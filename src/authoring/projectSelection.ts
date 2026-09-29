/**
 * Build a dependency-closed selection over the kept project. This produces a
 * candidate, not Keep authorization: reference diagnostics, potential uses in
 * open drafts/metadata, removal review and storage CAS belong to admission.
 */
import { openContainer } from "../container/container.ts";
import { PROFILES, type ProfileId } from "../runtime/profile.ts";
import {
  compileProjectDocuments,
  ProjectDocumentCompileError,
  readBindingsDocument,
} from "./projectDocuments.ts";
import type { ProjectDraft } from "./projectDraft.ts";
import { inspectProjectReferences } from "./projectReferences.ts";
import { inspectProjectSourceDependencies } from "./projectSourceDependencies.ts";

export function compileProjectSelection(input: {
  readonly draft: ProjectDraft;
  /** Current kept image; callers retain its storage identity through admission. */
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly profileId: ProfileId;
  readonly keys: readonly string[];
  /** Additional dependencies supplied by project metadata and editor operations. */
  readonly dependencies?: Readonly<Record<string, readonly string[]>>;
}) {
  const profile = PROFILES[input.profileId];
  if (!profile) throw new Error(`Unknown build profile: ${input.profileId}`);
  const keptDocuments = input.draft.select([]).documents();
  const baselineContainer = openContainer(new Map(Object.entries(input.files)));
  const keptBindings = keptDocuments["bindings"];
  if (keptBindings !== undefined && typeof keptBindings !== "string")
    throw new Error("Invalid project document bindings: expected JSON text.");
  const baseline = inspectProjectReferences({
    container: baselineContainer,
    profile,
    bindings: readBindingsDocument(keptBindings ?? "{}"),
  });
  const dependencies: Record<string, string[]> = Object.fromEntries(
    Object.entries(input.dependencies ?? {}).map(([key, values]) => [key, [...values]]),
  );
  const requiredKeys = new Set(input.keys);
  const dirty = new Set(input.draft.dirtyKeys());
  let selection = input.draft.select([...requiredKeys], dependencies);

  function addDependency(origin: string, target: string): boolean {
    const values = (dependencies[origin] ??= []);
    if (values.includes(target)) return false;
    values.push(target);
    return true;
  }

  // The finite document namespace has 4 * 256 resource slots and six auxiliary
  // documents. Each pass either selects another document or finishes; no parser
  // recovery, dependency cycle or malformed draft can create an unbounded loop.
  for (let pass = 0; pass <= 1030; pass++) {
    const documents = selection.documents();
    const bindingDocument = documents["bindings"];
    if (bindingDocument !== undefined && typeof bindingDocument !== "string")
      throw new Error("Invalid project document bindings: expected JSON text.");
    const bindings = readBindingsDocument(bindingDocument ?? "{}");
    let changed = false;
    for (const key of selection.keys) {
      const source = documents[key];
      if (key.startsWith("logic:") && typeof source === "string") {
        const analysis = inspectProjectSourceDependencies({ source, profile, bindings });
        // Select the current binding context before trusting any resolved IDs.
        // Otherwise an edited binding could pull in its obsolete kept target.
        const needed =
          analysis.bindings.length > 0 && !selection.keys.includes("bindings")
            ? ["bindings"]
            : analysis.dependencies;
        for (const dependency of needed) changed = addDependency(key, dependency) || changed;
      }
      // A selected removal pulls in the referring draft so its repair can be
      // compiled together. An unchanged use remains a visible reference error.
      if (keptDocuments[key] !== undefined && documents[key] === undefined) {
        for (const [origin, uses] of Object.entries(baseline.dependencies)) {
          if (uses.includes(key)) changed = addDependency(key, origin) || changed;
        }
      }
    }
    if (changed) {
      const next = input.draft.select([...requiredKeys], dependencies);
      if (next.keys.length !== selection.keys.length) {
        selection = next;
        continue;
      }
    }

    let compiled: ReturnType<typeof compileProjectDocuments>;
    try {
      compiled = compileProjectDocuments({ ...input, documents });
    } catch (error) {
      // New vocabulary/bindings may make a kept source invalid. Include its
      // available draft repair, without compiling every unrelated draft first.
      if (
        error instanceof ProjectDocumentCompileError &&
        !selection.keys.includes(error.key) &&
        dirty.has(error.key)
      ) {
        requiredKeys.add(error.key);
        selection = input.draft.select([...requiredKeys], dependencies);
        continue;
      }
      throw error;
    }
    const candidateContainer = openContainer(compiled.files());
    const references = inspectProjectReferences({
      container: candidateContainer,
      profile,
      bindings,
    });
    changed = false;
    for (const key of selection.keys) {
      // A reserved name may intentionally precede its resource. Only actual
      // source/native uses select that resource; reservations do not pull every
      // unfinished named asset into an otherwise independent build.
      if (key === "bindings") continue;
      for (const dependency of references.dependencies[key] ?? [])
        changed = addDependency(key, dependency) || changed;
    }
    // A context change can recompile kept source to new bytes without selecting
    // that source's unfinished typing. Include the dependencies of those actual
    // changed bytes, rather than guessing which bindings/word spellings mattered.
    for (const [key, uses] of Object.entries(references.dependencies)) {
      if (
        !key.startsWith("logic:") ||
        selection.keys.includes(key) ||
        typeof documents[key] !== "string"
      )
        continue;
      const num = Number(key.slice(6));
      const before = baselineContainer.getResource("logic", num);
      const after = candidateContainer.getResource("logic", num);
      if (
        before &&
        after &&
        before.length === after.length &&
        before.every((byte, index) => byte === after[index])
      )
        continue;
      for (const dependency of uses) {
        if (!selection.keys.includes(dependency)) {
          requiredKeys.add(dependency);
          changed = true;
        }
      }
    }
    if (changed) {
      const next = input.draft.select([...requiredKeys], dependencies);
      if (next.keys.length !== selection.keys.length) {
        selection = next;
        continue;
      }
    }
    return {
      selection,
      compiled,
      references,
      removedResources: Object.keys(keptDocuments)
        .filter((key) => key.includes(":") && documents[key] === undefined)
        .sort(),
    };
  }
  throw new Error("Project dependency closure exceeded its document limit.");
}

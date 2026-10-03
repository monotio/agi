/**
 * The debug workspace's draft authority over an open EditableProject. A test
 * capture runs the same admission path a Keep review does — buildSelected
 * over every dirty root plus its dependency closure — then re-captures the
 * candidate through captureProjectBuild for the verified source maps the
 * debugger binds breakpoints and stop positions against. A refused review,
 * a compile failure or a reference error surfaces unchanged; nothing here
 * invents source for byte-only resources.
 */
import type { EditableProject } from "../../../project/editableProject.ts";
import { captureProjectBuild } from "../../../../../src/authoring/projectBuild.ts";
import { readBindingsDocument } from "../../../../../src/authoring/projectDocuments.ts";
import type { SourceBindingKind } from "../../../worker/workerProtocol.ts";
import type { DebugDraftSource, DebugTestBuild } from "./logicDebugWorkspace.ts";

const LOGIC_DOCUMENT = /^logic:(\d+)$/;

export function createStudioDraftSource(
  project: () => EditableProject | undefined,
): DebugDraftSource {
  return {
    captureTestBuild(): DebugTestBuild {
      const ws = project();
      if (!ws) throw new Error("No project is open.");
      // The complete current draft: every dirty root plus the closure the
      // service computes; kept documents supply the rest of the image.
      const candidate = ws.buildSelected(ws.draft.dirtyKeys());
      const documents = candidate.documents();
      const sources: Record<string, string> = {};
      for (const [key, content] of Object.entries(documents)) {
        const match = LOGIC_DOCUMENT.exec(key);
        if (match && typeof content === "string") sources[match[1]!] = content;
      }
      const bindingsDocument = documents["bindings"];
      const sourceBindings: Record<string, { kind: SourceBindingKind; num: number }> =
        typeof bindingsDocument === "string" ? { ...readBindingsDocument(bindingsDocument) } : {};
      const files = candidate.files();
      // The same deterministic capture the worker verifies at attach: exact
      // sources and bindings reproducing the staged bytes, with source maps.
      const capture = captureProjectBuild({
        files,
        profileId: candidate.profileId,
        sources,
        bindings: Object.fromEntries(
          Object.entries(sourceBindings).map(([name, b]) => [name, { num: b.num }]),
        ),
      });
      const snapshot = ws.draft.capture();
      return {
        files,
        profile: candidate.profileId,
        sources,
        sourceBindings,
        capture,
        versions: snapshot.keys.map((key) => ({ key, version: snapshot.version(key) })),
        diagnostics: candidate.diagnostics,
      };
    },
    currentVersions() {
      const ws = project();
      if (!ws) return [];
      const snapshot = ws.draft.capture();
      return snapshot.keys.map((key) => ({ key, version: snapshot.version(key) }));
    },
  };
}

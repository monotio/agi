/** Detached preparation of the complete coordinated document image. */
import { createContainer, openContainer } from "../container/container.ts";
import { PROFILES, type ProfileId } from "../runtime/profile.ts";
import { createAuthoringState, validateAuthoringState } from "./authoringState.ts";
import {
  compileProjectDocuments,
  ProjectDocumentCompileError,
  readBindingsDocument,
  readMusicDocument,
  type ProjectDocumentsCompile,
} from "./projectDocuments.ts";
import type { ProjectApplication, ProjectModel, ProjectProposal } from "./projectModel.ts";
import { occupiedProjectNumbers } from "./projectRenumber.ts";
import type { ResourceKind } from "../types.ts";
import { inspectProjectReferences } from "./projectReferences.ts";
import { inspectProjectRemoval, PROJECT_RESOURCE_KEY } from "./projectRemoval.ts";
import { inspectProjectDocumentDependencies } from "./projectSelection.ts";

export interface ReviewedRenumbering {
  readonly key: string;
  readonly number: number;
}
export interface ProjectValidationPolicy {
  /** The creator reviewed computed uses before moving this resource. */
  readonly reviewedRenumbering?: ReviewedRenumbering | undefined;
  readonly allowMissingRooms?: boolean;
  /** Exact removed LOGIC keys whose unknown new.room.v risks the creator reviewed. */
  readonly reviewedComputedRoomJumps?: readonly string[] | undefined;
}
interface ProjectEditDiagnostic {
  readonly document: string;
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly preExisting: boolean;
}
export interface PreparedProjectEdit {
  readonly status: "ready" | "diagnostics";
  readonly proposal: ProjectProposal;
  readonly application: ProjectApplication;
  /** Present only when the complete image is admissible. */
  readonly compiled: ProjectDocumentsCompile | undefined;
  readonly diagnostics: readonly ProjectEditDiagnostic[];
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
  readonly removedResources: readonly string[];
}

export function prepareProjectEdit(input: {
  readonly model: ProjectModel;
  readonly proposal: ProjectProposal;
  readonly profileId: ProfileId;
  readonly policy: ProjectValidationPolicy;
  readonly drafts?:
    readonly { readonly key: string; readonly content: string | Uint8Array }[] | undefined;
}): PreparedProjectEdit {
  // Check ownership and freshness before any compilation or diagnostics.
  const sourceApplication = input.model.issueApplication(input.proposal);
  const profile = PROFILES[input.profileId];
  if (!profile) throw new Error(`Unknown build profile: ${input.profileId}`);
  const base = input.proposal.base.lastAdmissibleBuild;
  if (base !== undefined && base.identity.profileId !== input.profileId)
    throw new Error("Project preparation profile differs from the last admissible image.");
  const files = Object.fromEntries(base?.files() ?? createContainer().files);
  const documents = input.proposal.documents();
  const before = base?.documents() ?? {};
  const removedResources = Object.freeze(
    Object.keys(before)
      .filter((key) => PROJECT_RESOURCE_KEY.test(key) && documents[key] === undefined)
      .sort(),
  );
  let dependencies: Readonly<Record<string, readonly string[]>> = Object.freeze({});
  const diagnostics: ProjectEditDiagnostic[] = [];
  let compiled: ProjectDocumentsCompile | undefined;
  try {
    // Strict compilation remains the diagnostic authority for incomplete text.
    compiled = compileProjectDocuments({ files, profileId: input.profileId, documents });
    dependencies = inspectProjectDocumentDependencies({ documents, profileId: input.profileId });
    const bindingsText = documents["bindings"];
    const bindings = readBindingsDocument(typeof bindingsText === "string" ? bindingsText : "{}");
    const beforeBindings = before["bindings"];
    const baseline = inspectProjectReferences({
      container: openContainer(new Map(Object.entries(files)), { profile }),
      profile,
      bindings: readBindingsDocument(typeof beforeBindings === "string" ? beforeBindings : "{}"),
      allowMissingRooms: input.policy.allowMissingRooms === true,
    });
    const references = inspectProjectReferences({
      container: openContainer(compiled.files(), { profile }),
      profile,
      bindings,
      allowMissingRooms: input.policy.allowMissingRooms === true,
    });
    // Match diagnostic multiplicity, independent of byte offsets shifted by an
    // otherwise harmless code edit. Additional broken uses are new damage.
    const marker = (diagnostic: (typeof references.diagnostics)[number]): string =>
      JSON.stringify([
        diagnostic.document,
        diagnostic.code,
        diagnostic.command,
        diagnostic.message,
      ]);
    const existing: Record<string, number> = Object.create(null);
    for (const diagnostic of baseline.diagnostics) {
      const key = marker(diagnostic);
      existing[key] = (existing[key] ?? 0) + 1;
    }
    for (const diagnostic of references.diagnostics) {
      // Computed dispatch is ordinary AGI; the reference index retains its details.
      if (diagnostic.code === "unresolved-reference") continue;
      const key = marker(diagnostic);
      const preExisting = (existing[key] ?? 0) > 0;
      if (preExisting) existing[key] = existing[key]! - 1;
      diagnostics.push({
        document: diagnostic.document,
        code: diagnostic.code,
        message: diagnostic.message,
        // Sealing rooms checks every room exit, including existing ones.
        severity:
          preExisting && diagnostic.command !== "new.room" ? "warning" : diagnostic.severity,
        preExisting,
      });
    }
    dependencies = Object.freeze(
      Object.fromEntries(
        [...new Set([...Object.keys(dependencies), ...Object.keys(references.dependencies)])]
          .sort()
          .map((key) => [
            key,
            Object.freeze(
              [
                ...new Set([...(dependencies[key] ?? []), ...(references.dependencies[key] ?? [])]),
              ].sort(),
            ),
          ]),
      ),
    );
    const renumbering = input.policy.reviewedRenumbering;
    const reviewedMove =
      renumbering !== undefined &&
      removedResources.includes(renumbering.key) &&
      PROJECT_RESOURCE_KEY.test(renumbering.key) &&
      renumbering.key !== "logic:0" &&
      Number.isInteger(renumbering.number) &&
      renumbering.number >= (renumbering.key.startsWith("logic:") ? 1 : 0) &&
      renumbering.number <= 255 &&
      documents[`${renumbering.key.split(":")[0]}:${renumbering.number}`] !== undefined &&
      before[`${renumbering.key.split(":")[0]}:${renumbering.number}`] === undefined &&
      !occupiedProjectNumbers(
        input.proposal.base.documents(),
        renumbering.key.split(":")[0] as ResourceKind,
        profile,
      ).has(renumbering.number);
    if (renumbering && !reviewedMove)
      throw new Error("This number change changed. Review it again.");
    if (removedResources.length > 0) {
      const authoring = createAuthoringState();
      authoring.bindings = bindings;
      const world = documents["world"];
      if (world !== undefined) {
        if (typeof world !== "string")
          throw new ProjectDocumentCompileError("world", new Error("Expected JSON text."));
        try {
          authoring.world = validateAuthoringState({
            ...authoring,
            world: JSON.parse(world),
          }).world;
        } catch (error) {
          throw new ProjectDocumentCompileError("world", error);
        }
      }
      const music = documents["music"];
      if (typeof music === "string") authoring.music = readMusicDocument(music);
      for (const finding of inspectProjectRemoval({
        removals: removedResources,
        renumbering: reviewedMove ? renumbering?.key : undefined,
        image: references,
        authoring,
        tests: documents["tests"],
        references: documents["references"],
        drafts: (input.drafts ?? []).filter(
          (draft) => !input.proposal.changes().some((change) => change.key === draft.key),
        ),
        keptBindings: readBindingsDocument(
          typeof beforeBindings === "string" ? beforeBindings : "{}",
        ),
        profile,
      }))
        diagnostics.push({
          ...finding,
          code: finding.computedRoomJump ? "computed-room-jump" : "removal-use",
          severity:
            (reviewedMove && finding.computedResource === renumbering?.key) ||
            (finding.computedRoomJump &&
              input.policy.reviewedComputedRoomJumps?.includes(finding.computedRoomJump))
              ? "warning"
              : "error",
          preExisting: false,
        });
    }
  } catch (error) {
    diagnostics.push({
      document: error instanceof ProjectDocumentCompileError ? error.key : "project",
      severity: "error",
      code: "compile",
      message: error instanceof Error ? error.message : String(error),
      preExisting: false,
    });
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) compiled = undefined;
  return Object.freeze({
    status: compiled === undefined ? "diagnostics" : "ready",
    proposal: input.proposal,
    application:
      compiled === undefined
        ? sourceApplication
        : input.model.issueApplication(input.proposal, compiled),
    compiled,
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
    dependencies,
    removedResources,
  });
}

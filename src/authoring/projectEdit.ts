/** Detached preparation of the complete coordinated document image. */
import { createContainer, openContainer } from "../container/container.ts";
import { PROFILES, type ProfileId } from "../runtime/profile.ts";
import {
  createAuthoringState,
  validateAuthoringState,
  type AuthoringState,
} from "./authoringState.ts";
import {
  compileProjectDocuments,
  ProjectDocumentCompileError,
  readBindingsDocument,
  readMusicDocument,
  readWordsDocument,
  projectDocumentErrorRow,
  type ProjectDocumentsCompile,
} from "./projectDocuments.ts";
import type { ProjectApplication, ProjectModel, ProjectProposal } from "./projectModel.ts";
import { pruneWorldLaunches, readWorldLaunches } from "./launches.ts";
import { roomEntryProblem } from "../runtime/roomEntry.ts";
import { readInventoryObjects } from "./inventory.ts";
import { occupiedProjectNumbers } from "./projectRenumber.ts";
import type { ResourceKind } from "../types.ts";
import { inspectProjectReferences } from "./projectReferences.ts";
import { inspectProjectRemoval, PROJECT_RESOURCE_KEY } from "./projectRemoval.ts";
import { inspectProjectDocumentDependencies } from "./projectSelection.ts";
import { createProjectLogicLanguageSnapshot } from "./projectLanguage.ts";
import { parseWordsTok, buildWordsTok } from "../logic/words.ts";
import { projectDiagnosticRanges } from "./projectDiagnosticRange.ts";
import { jsonSourceRange } from "./jsonSourceRange.ts";

export interface ReviewedRenumbering {
  readonly key: string;
  readonly number: number;
}
export interface ProjectValidationPolicy {
  /** The creator reviewed computed uses before moving this resource. */
  readonly reviewedRenumbering?: ReviewedRenumbering | undefined;
  readonly allowMissingRooms?: boolean;
  readonly launch?: { readonly room: number; readonly id: string } | undefined;
  /** Exact removed LOGIC keys whose unknown new.room.v risks the creator reviewed. */
  readonly reviewedComputedRoomJumps?: readonly string[] | undefined;
}
export interface ProjectEditDiagnostic {
  readonly document: string;
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly preExisting: boolean;
  readonly start?: number;
  readonly end?: number;
  readonly row?: number;
  readonly navigation?: {
    readonly key: string;
    readonly launchId?: string;
    readonly item?: number;
  };
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
  let proposal = input.proposal;
  let documents = proposal.documents();
  const before = base?.documents() ?? {};
  const removedResources = Object.freeze(
    [...new Set([...Object.keys(before), ...proposal.base.keys])]
      .filter((key) => PROJECT_RESOURCE_KEY.test(key) && documents[key] === undefined)
      .sort(),
  );
  let dependencies: Readonly<Record<string, readonly string[]>> = Object.freeze({});
  const diagnostics: ProjectEditDiagnostic[] = [];
  let compiled: ProjectDocumentsCompile | undefined;
  try {
    const worldText = documents["world"];
    if (removedResources.length && typeof worldText === "string") {
      let world: AuthoringState["world"];
      try {
        world = JSON.parse(worldText) as AuthoringState["world"];
        validateAuthoringState({ ...createAuthoringState(), world });
      } catch (error) {
        throw new ProjectDocumentCompileError("world", error);
      }
      const launches = pruneWorldLaunches(world.launches, new Set(removedResources));
      if (launches !== world.launches) {
        // Keep the creator's other world fields and the exact Undo base.
        const prunedWorld = JSON.parse(worldText) as Record<string, unknown>;
        if (launches) prunedWorld["launches"] = launches;
        else delete prunedWorld["launches"];
        proposal = input.model.propose(proposal.base, proposal.label, [
          ...proposal.changes().filter((change) => change.key !== "world"),
          { key: "world", content: JSON.stringify(prunedWorld) },
        ]);
        documents = proposal.documents();
      }
    }
    const bindingsText = documents["bindings"];
    let bindings: ReturnType<typeof readBindingsDocument>;
    try {
      bindings = readBindingsDocument(typeof bindingsText === "string" ? bindingsText : "{}");
    } catch (error) {
      throw new ProjectDocumentCompileError("bindings", error);
    }
    const words = documents["words"];
    let dictionary: Map<string, number> = new Map();
    if (
      Object.entries(documents).some(
        ([key, value]) => key.startsWith("logic:") && typeof value === "string",
      )
    ) {
      try {
        dictionary = new Map<string, number>(
          words
            ? parseWordsTok(
                typeof words === "string" ? buildWordsTok(readWordsDocument(words)) : words,
              ).map(({ word, id }) => [word, id])
            : [],
        );
      } catch (error) {
        throw new ProjectDocumentCompileError("words", error);
      }
    }
    for (const [document, source] of Object.entries(documents)) {
      if (!document.startsWith("logic:") || typeof source !== "string") continue;
      for (const entry of createProjectLogicLanguageSnapshot({
        source,
        profile,
        dictionary,
        bindings,
      }).diagnostics)
        diagnostics.push({
          document,
          code: "compile",
          severity: entry.severity,
          message: entry.message,
          start: entry.start,
          end: entry.end,
          preExisting: false,
        });
    }
    const sourceRange = projectDiagnosticRanges(documents, { profile, dictionary, bindings });
    // Strict compilation remains the authority for the complete working image.
    compiled = compileProjectDocuments({ files, profileId: input.profileId, documents });
    const selectedLaunch = input.policy.launch;
    const launchWorld = documents["world"];
    if (selectedLaunch && typeof launchWorld === "string") {
      const world = JSON.parse(launchWorld) as AuthoringState["world"];
      const entries = world.launches?.[selectedLaunch.room]?.entries ?? [];
      const index = entries.findIndex((entry) => entry.id === selectedLaunch.id);
      const launch = entries[index];
      if (launch) {
        const inventoryCount = readInventoryObjects(compiled.files().get("OBJECT"), profile).length;
        const problem = roomEntryProblem(launch, inventoryCount);
        if (problem) {
          let readable = false;
          try {
            readWorldLaunches({ [selectedLaunch.room]: { entries } });
            readable = true;
          } catch {
            /* A malformed Launch can be repaired in its world document. */
          }
          diagnostics.push({
            document: "world",
            code: "launch-input",
            severity: "error",
            message: problem,
            preExisting: false,
            ...jsonSourceRange(launchWorld, [
              "launches",
              String(selectedLaunch.room),
              "entries",
              index,
            ]),
            ...(readable
              ? {
                  navigation: {
                    key: `launches:${selectedLaunch.room}`,
                    launchId: selectedLaunch.id,
                    ...(Object.keys(launch.items ?? {}).some((id) => Number(id) >= inventoryCount)
                      ? {
                          item: Number(
                            Object.keys(launch.items!).find((id) => Number(id) >= inventoryCount),
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
          });
        }
      }
    }
    dependencies = inspectProjectDocumentDependencies({ documents, profileId: input.profileId });
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
        ...sourceRange(diagnostic),
        ...(diagnostic.document === "bindings" &&
        diagnostic.command &&
        typeof bindingsText === "string"
          ? jsonSourceRange(bindingsText, [diagnostic.command, "num"])
          : {}),
        document: diagnostic.document,
        code: diagnostic.code,
        message: diagnostic.message,
        // Damage the base already had, a room exit to nowhere included,
        // stays listed and never blocks a change to something else.
        severity: preExisting ? "warning" : diagnostic.severity,
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
      const unselectedDrafts = (input.drafts ?? []).filter(
        (draft) => !input.proposal.changes().some((change) => change.key === draft.key),
      );
      for (const finding of inspectProjectRemoval({
        removals: removedResources,
        renumbering: reviewedMove ? renumbering?.key : undefined,
        image: references,
        authoring,
        tests: documents["tests"],
        references: documents["references"],
        drafts: unselectedDrafts,
        keptBindings: readBindingsDocument(
          typeof beforeBindings === "string" ? beforeBindings : "{}",
        ),
        profile,
      })) {
        const source =
          unselectedDrafts.find((draft) => draft.key === finding.document)?.content ??
          documents[finding.document];
        diagnostics.push({
          ...finding,
          ...sourceRange(finding),
          ...(finding.path && typeof source === "string"
            ? jsonSourceRange(source, finding.path)
            : {}),
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
    }
  } catch (error) {
    const document = error instanceof ProjectDocumentCompileError ? error.key : "project";
    const source = documents[document];
    const row = typeof source === "string" ? projectDocumentErrorRow(document, source) : undefined;
    if (!diagnostics.some((entry) => entry.document === document && entry.severity === "error"))
      diagnostics.push({
        document,
        ...(row === undefined ? {} : { row }),
        ...(row === undefined || typeof source !== "string" ? {} : jsonSourceRange(source, [row])),
        severity: "error",
        code: "compile",
        message: error instanceof Error ? error.message : String(error),
        preExisting: false,
      });
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) compiled = undefined;
  return Object.freeze({
    status: compiled === undefined ? "diagnostics" : "ready",
    proposal,
    application:
      compiled === undefined
        ? proposal === input.proposal
          ? sourceApplication
          : input.model.issueApplication(proposal)
        : input.model.issueApplication(proposal, compiled),
    compiled,
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
    dependencies,
    removedResources,
  });
}

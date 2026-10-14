/** Detached preparation and one physical-run admission attempt precede document publication. */
import {
  prepareProjectEdit,
  type ReviewedRenumbering,
} from "../../../src/authoring/projectEdit.ts";
import type {
  ProjectModel,
  ProjectProposal,
  ProjectImage,
} from "../../../src/authoring/projectModel.ts";
import { diffProjectDocuments } from "../../../src/authoring/projectContent.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { PreviewUpdateOutcome } from "../worker/workerProtocol.ts";
import type { ProjectDocumentsCompile } from "../../../src/authoring/projectDocuments.ts";

/** Native bytes, verified source origins and every authority document except tests. */
function sameAdmissionImage(
  compiled: ProjectDocumentsCompile,
  admitted: Pick<ProjectImage, "identity" | "documents"> | undefined,
): boolean {
  if (!admitted) return false;
  const identity = compiled.build.identity;
  return (
    identity.revision === admitted.identity.revision &&
    identity.buildId === admitted.identity.buildId &&
    identity.profileId === admitted.identity.profileId &&
    diffProjectDocuments(admitted.documents(), compiled.documents()).every(
      (change) => change.key === "tests",
    )
  );
}

export async function prepareAndAdmitProjectEdit(input: {
  readonly model: ProjectModel;
  readonly proposal: ProjectProposal;
  readonly profileId: ProfileId;
  readonly allowMissingRooms: boolean;
  readonly admittedImage: ProjectImage | undefined;
  readonly pendingImage?: ProjectDocumentsCompile | undefined;
  /** Explicit room/restart actions keep their existing native protocol. */
  readonly forceAdmission?: boolean;
  readonly reviewedRenumbering?: ReviewedRenumbering | undefined;
  readonly reviewedComputedRoomJumps?: readonly string[] | undefined;
  readonly drafts?:
    readonly { readonly key: string; readonly content: string | Uint8Array }[] | undefined;
  readonly current: () => boolean;
  readonly preflight: () => void;
  readonly admit: (
    compiled: ProjectDocumentsCompile,
    versions: { key: string; version: number }[],
  ) => Promise<PreviewUpdateOutcome>;
}) {
  const prepared = prepareProjectEdit({
    model: input.model,
    proposal: input.proposal,
    profileId: input.profileId,
    policy: {
      allowMissingRooms: input.allowMissingRooms,
      reviewedRenumbering: input.reviewedRenumbering,
      reviewedComputedRoomJumps: input.reviewedComputedRoomJumps,
    },
    drafts: input.drafts,
  });
  input.preflight();
  const before = input.model.capture();
  const changes = prepared.proposal.changes();
  const documentVersions = [
    ...new Set([...before.keys, ...changes.map((change) => change.key)]),
  ].map((key) => ({ key, version: before.version(key) }));
  function valid() {
    const current = input.model.capture();
    return (
      input.current() &&
      current.revision === before.revision &&
      current.documentId === before.documentId &&
      documentVersions.every(({ key, version }) => current.version(key) === version)
    );
  }
  let outcome: PreviewUpdateOutcome | undefined;
  const metadataEdit = !input.forceAdmission && changes.every((change) => change.key === "tests");
  const admissionUnchanged =
    metadataEdit &&
    prepared.compiled !== undefined &&
    sameAdmissionImage(prepared.compiled, input.admittedImage);
  // Keep an already queued native admission at its existing boundary when
  // this edit only refreshes its test document, including prepared-room adoption.
  const pending = input.pendingImage;
  const preservesPendingAdmission =
    metadataEdit &&
    prepared.compiled !== undefined &&
    pending !== undefined &&
    sameAdmissionImage(prepared.compiled, {
      identity: pending.build.identity,
      documents: () => pending.documents(),
    });
  if (prepared.compiled !== undefined && !admissionUnchanged && !preservesPendingAdmission) {
    if (!valid()) throw new Error("Project edit was superseded.");
    outcome = await input.admit(prepared.compiled, documentVersions);
  }
  if (!valid()) throw new Error("Project edit was superseded.");
  return { prepared, outcome, changes, admissionUnchanged, preservesPendingAdmission };
}

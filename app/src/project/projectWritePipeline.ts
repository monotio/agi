/** Detached preparation and one physical-run admission attempt precede document publication. */
import {
  prepareProjectEdit,
  type ReviewedRenumbering,
} from "../../../src/authoring/projectEdit.ts";
import type { ProjectModel, ProjectProposal } from "../../../src/authoring/projectModel.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { PreviewUpdateOutcome } from "../worker/workerProtocol.ts";
import type { ProjectDocumentsCompile } from "../../../src/authoring/projectDocuments.ts";

export async function prepareAndAdmitProjectEdit(input: {
  readonly model: ProjectModel;
  readonly proposal: ProjectProposal;
  readonly profileId: ProfileId;
  readonly allowMissingRooms: boolean;
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
  const changes = input.proposal.changes();
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
  if (prepared.compiled !== undefined) {
    if (!valid()) throw new Error("Project edit was superseded.");
    outcome = await input.admit(prepared.compiled, documentVersions);
  }
  if (!valid()) throw new Error("Project edit was superseded.");
  return { prepared, outcome, changes };
}

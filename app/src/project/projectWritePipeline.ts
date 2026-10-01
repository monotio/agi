/** Detached preparation and physical-run admission precede model publication and storage. */
import { prepareProjectEdit } from "../../../src/authoring/projectEdit.ts";
import type { ProjectModel, ProjectProposal } from "../../../src/authoring/projectModel.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { PreviewUpdateOutcome } from "../worker/workerProtocol.ts";
import type { ProjectDocumentsCompile } from "../../../src/authoring/projectDocuments.ts";

export async function prepareAndAdmitProjectEdit(input: {
  readonly model: ProjectModel;
  readonly proposal: ProjectProposal;
  readonly profileId: ProfileId;
  readonly allowMissingRooms: boolean;
  readonly current: () => boolean;
  readonly preflight: () => void;
  readonly admit: (
    compiled: ProjectDocumentsCompile,
    versions: { key: string; version: number }[],
  ) => Promise<PreviewUpdateOutcome>;
  readonly boundary: () => Promise<void>;
}) {
  const prepared = prepareProjectEdit({
    model: input.model,
    proposal: input.proposal,
    profileId: input.profileId,
    policy: { allowMissingRooms: input.allowMissingRooms },
  });
  input.preflight();
  const before = input.model.capture();
  const documentVersions = [
    ...new Set([...before.keys, ...input.proposal.changes().map((change) => change.key)]),
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
    do {
      if (!valid()) throw new Error("Project edit was superseded.");
      outcome = await input.admit(prepared.compiled, documentVersions);
      if (!valid()) throw new Error("Project edit was superseded.");
      if (outcome.status === "deferred") await input.boundary();
    } while (outcome.status === "deferred");
  }
  if (!valid()) throw new Error("Project edit was superseded.");
  return { prepared, outcome };
}

import { gameTestChanges } from "../../../src/agent/gameTestReview.ts";
/** Translate a detached whole-game tool result into one owned project proposal. */
import {
  mergeAgentTestChanges,
  sameNonTestDocuments,
} from "../../../src/authoring/projectTestsMerge.ts";
import { PROFILES } from "../../../src/runtime/profile.ts";
import { ProjectDraft } from "../../../src/authoring/projectDraft.ts";
import { captureAgentWorkspace } from "../../../src/authoring/projectAgentCandidate.ts";
import type { AgentSessionState } from "../../../src/agent/agentState.ts";
import type { ProjectSnapshot } from "../../../src/authoring/projectModel.ts";
import type { ProjectSession } from "../project/projectSession.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import { forkAgentState } from "./sessionState.ts";
/** Background tasks start from the current documents, including recent editor typing. */
export function refreshProjectAgent(
  session: ProjectSession,
  state: AgentSessionState,
  profileId: ProfileId,
): ProjectSnapshot {
  const base = session.model.capture();
  const candidate = captureAgentWorkspace({
    draft: new ProjectDraft(base.documents()),
    files: Object.fromEntries(base.lastAdmissibleBuild!.files()),
    profileId,
    allowMissingRooms: session.allowMissingRooms,
  }).openToolState();
  Object.assign(state, candidate.state);
  state.readCommittedTests = () => session.model.capture().read("tests")?.content;
  state.finishTestsBase = base.read("tests")?.content ?? null;
  return base;
}
/** Validate a runtime room transaction before its native answer resumes the interpreter. */
export function validateAgentState(
  base: ProjectSnapshot,
  state: AgentSessionState,
  profileId: ProfileId,
  allowMissingRooms: boolean,
) {
  const candidate = captureAgentWorkspace({
    draft: new ProjectDraft(base.documents()),
    files: Object.fromEntries(base.lastAdmissibleBuild!.files()),
    profileId,
    allowMissingRooms,
  }).openToolState();
  Object.assign(candidate.state, forkAgentState(state));
  return candidate.finish("Authored room").changes();
}
export async function submitAgentState(input: {
  session: ProjectSession;
  base: ProjectSnapshot;
  state: AgentSessionState;
  profileId: ProfileId;
  label: string;
  chatId?: string;
  messageId?: string;
  preparedRoom?: boolean;
}) {
  const { session, base } = input;
  const changes = validateAgentState(base, input.state, input.profileId, session.allowMissingRooms);
  if (!changes.length) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = session.model.capture();
    if (!sameNonTestDocuments(base.documents(), current.documents()))
      throw new Error(
        "The project changed while the agent worked. Retry the task with its current documents.",
      );
    const merged = mergeAgentTestChanges(
      base.documents(),
      current.documents(),
      changes,
      PROFILES[input.profileId],
    );
    if (!merged.length) return;
    const requireCreatorReview = () => {
      const latest = session.model.capture();
      const latestChanges = mergeAgentTestChanges(
        base.documents(),
        latest.documents(),
        changes,
        PROFILES[input.profileId],
      );
      const tests = latestChanges.find((change) => change.key === "tests");
      if (!tests) return;
      let needsReview: boolean;
      try {
        needsReview =
          gameTestChanges(
            latest.read("tests")?.content,
            tests.content,
            PROFILES[input.profileId],
          ).some((change) => change.kind !== "added") ||
          gameTestChanges(
            base.read("tests")?.content,
            changes.find((change) => change.key === "tests")?.content,
            PROFILES[input.profileId],
          ).some((change) => change.kind !== "added");
      } catch {
        needsReview = true;
      }
      if (needsReview)
        throw new Error(
          "Existing test edits need creator review. Open Tests in the workspace to review this change.",
        );
    };
    requireCreatorReview();
    try {
      return await (input.preparedRoom ? session.submitPreparedRoom : session.submit)({
        proposal: session.model.propose(current, input.label, merged),
        beforeCommit: requireCreatorReview,
        label: `AI: ${input.label}`,
        origin: "agent",
        author: "agent",
        ...(input.chatId === undefined
          ? {}
          : { chatId: input.chatId, messageId: input.messageId! }),
      });
    } catch (error) {
      if (attempt === 0 && error instanceof Error && error.message === "Project changes are stale.")
        continue;
      throw error;
    }
  }
  throw new Error("The project changed again. Retry the task.");
}

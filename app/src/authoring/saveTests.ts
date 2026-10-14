/** The recorder and Tests panel share one transactional project edit. */
import { editGameTests, type GameTestsEditOperation } from "../../../src/agent/gameTestsEdit.ts";
import { PROFILES } from "../../../src/runtime/profile.ts";
import type { ProjectSession } from "../project/projectSession.ts";

export interface SaveTestsOptions {
  /** Checked again immediately before the queued proposal commits. */
  readonly beforeCommit?: () => void;
}

const retries = new WeakMap<
  ProjectSession,
  {
    readonly operation: string;
    readonly content: string;
    readonly edited: ReturnType<typeof editGameTests>;
  }
>();

export async function saveTests(
  session: ProjectSession | null | undefined,
  op: GameTestsEditOperation,
  options: SaveTestsOptions = {},
): Promise<ReturnType<typeof editGameTests>> {
  if (!session) throw new Error("Open Create before saving a test.");
  const beforeCommit = () => options.beforeCommit?.();
  beforeCommit();
  async function flushTests() {
    try {
      await session!.flush();
    } catch (error) {
      const status = session!.saveStatus();
      if (status.state === "failed" && status.cause !== undefined) {
        const cause = status.cause;
        const reason = (cause instanceof Error ? cause.message : String(cause))
          .trim()
          .replace(/[.!?]+$/, "");
        throw new Error(`Could not save the test: ${reason}. Retry the save.`, { cause: error });
      }
      throw error;
    }
  }
  const retry = retries.get(session);
  if (
    retry &&
    retry.operation === JSON.stringify(op) &&
    session.model.capture().read("tests")?.content === retry.content
  ) {
    await flushTests();
    retries.delete(session);
    return retry.edited;
  }
  if (session.saveStatus().state === "failed") await flushTests();
  retries.delete(session);
  for (let attempt = 0; attempt < 2; attempt++) {
    beforeCommit();
    const snapshot = session.model.capture();
    const profileId = snapshot.lastAdmissibleBuild!.identity.profileId;
    const edited = editGameTests(
      {
        document: snapshot.read("tests")?.content,
        profile: PROFILES[profileId],
        words: undefined,
      },
      op,
    );
    try {
      const result = await session.submit({
        proposal: session.model.propose(snapshot, "Tests", [
          { key: "tests", content: new TextDecoder().decode(edited.payload) },
        ]),
        label: "Tests",
        origin: "guided",
        author: "creator",
        beforeCommit,
      });
      if (result.status === "refused") {
        const reason = (result.reason ?? "The project could not save the test")
          .trim()
          .replace(/[.!?]+$/, "");
        throw new Error(`${reason}. Try saving the test again.`);
      }
    } catch (error) {
      if (attempt === 0 && error instanceof Error && error.message === "Project proposal is stale.")
        continue;
      throw error;
    }
    try {
      await flushTests();
    } catch (error) {
      retries.set(session, {
        operation: JSON.stringify(op),
        content: new TextDecoder().decode(edited.payload),
        edited,
      });
      throw error;
    }
    const status = session.saveStatus();
    if (status.state !== "saved") throw new Error(status.message);
    return edited;
  }
  throw new Error("The project changed again. Try saving the test again.");
}

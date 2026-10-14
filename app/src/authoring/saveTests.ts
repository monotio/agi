/** The recorder and Tests panel share one transactional project edit. */
import { editGameTests, type GameTestsEditOperation } from "../../../src/agent/gameTestsEdit.ts";
import { buildWordsTok } from "../../../src/logic/words.ts";
import { readWordsDocument } from "../../../src/authoring/projectDocuments.ts";
import { PROFILES } from "../../../src/runtime/profile.ts";
import { testsWriteBlockReason } from "./testWriteStatus.ts";
import type { ProjectSession } from "../project/projectSession.ts";

export interface SaveTestsOptions {
  /** Checked again immediately before the queued proposal commits. */
  readonly writeBlockReason?: () => string | null;
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
  const beforeCommit = () => {
    const reason = testsWriteBlockReason(session) ?? options.writeBlockReason?.();
    if (reason) throw new Error(reason);
  };
  beforeCommit();
  const retry = retries.get(session);
  if (
    retry &&
    retry.operation === JSON.stringify(op) &&
    session.model.capture().read("tests")?.content === retry.content
  ) {
    await session.flush();
    retries.delete(session);
    return retry.edited;
  }
  if (session.saveStatus().state === "failed") await session.flush();
  retries.delete(session);
  for (let attempt = 0; attempt < 2; attempt++) {
    beforeCommit();
    const snapshot = session.model.capture();
    const image = snapshot.lastAdmissibleBuild;
    if (!image) throw new Error("The game could not build. Fix the problems before saving tests.");
    const words = snapshot.read("words")?.content;
    const edited = editGameTests(
      {
        document: snapshot.read("tests")?.content,
        profile: PROFILES[image.identity.profileId],
        words: typeof words === "string" ? buildWordsTok(readWordsDocument(words)) : words,
      },
      op,
    );
    try {
      await session.submit({
        proposal: session.model.propose(snapshot, "Tests", [
          { key: "tests", content: new TextDecoder().decode(edited.payload) },
        ]),
        label: "Tests",
        origin: "guided",
        author: "creator",
        beforeCommit,
      });
    } catch (error) {
      if (attempt === 0 && error instanceof Error && error.message === "Project proposal is stale.")
        continue;
      throw error;
    }
    try {
      await session.flush();
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

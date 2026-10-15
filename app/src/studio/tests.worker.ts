import { ProjectDraft } from "../../../src/authoring/projectDraft.ts";
import { captureAgentWorkspace } from "../../../src/authoring/projectAgentCandidate.ts";
import { runGameTests } from "../../../src/agent/gameTestsRunner.ts";
import { GAME_TESTS_FILE, parseGameTests } from "../../../src/agent/gameTestFormat.ts";
import { PROFILES } from "../../../src/runtime/profile.ts";
import type { TestsWorkerPort, TestsWorkerOutbound } from "./testsProtocol.ts";

/** Fake ports and the browser drive the same worker with the real interpreter. */
export function installTestsWorker(port: TestsWorkerPort): void {
  port.onmessage = (event) => {
    const input = event.data;
    try {
      const files = { ...input.files };
      delete files[GAME_TESTS_FILE];
      const document = input.documents["tests"];
      if (document !== undefined) {
        const bytes = typeof document === "string" ? new TextEncoder().encode(document) : document;
        try {
          parseGameTests(bytes, PROFILES[input.profileId]);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            reason.startsWith(`${GAME_TESTS_FILE} format must be`)
              ? "The tests file uses an unsupported format. Import a supported tests file."
              : `${reason} Fix the tests file before running it.`,
            { cause: error },
          );
        }
        files[GAME_TESTS_FILE] = bytes;
      }
      const candidate = captureAgentWorkspace({
        draft: new ProjectDraft(input.documents),
        files,
        profileId: input.profileId,
        allowMissingRooms: input.allowMissingRooms,
      }).openToolState();
      const result = runGameTests(candidate.state, input.names);
      port.postMessage({ result } satisfies TestsWorkerOutbound);
    } catch (error) {
      port.postMessage({
        error: error instanceof Error ? error.message : String(error),
      } satisfies TestsWorkerOutbound);
    }
  };
}
if (typeof self !== "undefined") installTestsWorker(self);

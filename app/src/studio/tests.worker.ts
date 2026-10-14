import { ProjectDraft } from "../../../src/authoring/projectDraft.ts";
import { captureAgentWorkspace } from "../../../src/authoring/projectAgentCandidate.ts";
import { runGameTests } from "../../../src/agent/gameTestsRunner.ts";
import type { TestsWorkerPort, TestsWorkerOutbound } from "./testsProtocol.ts";

/** Fake ports and the browser drive the same worker with the real interpreter. */
export function installTestsWorker(port: TestsWorkerPort): void {
  port.onmessage = (event) => {
    const input = event.data;
    try {
      const candidate = captureAgentWorkspace({
        draft: new ProjectDraft(input.documents),
        files: input.files,
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

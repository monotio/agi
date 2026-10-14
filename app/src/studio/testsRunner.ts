/** Each manual run owns a disposable worker and uses committed project documents. */
import type { AgentToolResult } from "../../../src/agent/agentState.ts";
import type { ProjectSession } from "../project/projectSession.ts";
import type { TestsWorkerInbound, TestsWorkerOutbound } from "./testsProtocol.ts";
export type { TestsWorkerInbound, TestsWorkerOutbound } from "./testsProtocol.ts";

export function runTestsInWorker(
  session: ProjectSession,
  options: {
    readonly names?: readonly string[];
    readonly signal?: AbortSignal;
    readonly deadlineMs?: number;
    /** Test ports exercise termination without starting a browser worker. */
    readonly createWorker?: () => Worker;
  } = {},
): Promise<AgentToolResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Tests stopped."));
      return;
    }
    const snapshot = session.model.capture();
    const image = snapshot.lastAdmissibleBuild;
    if (!image) {
      reject(new Error("The game could not build. Fix the problems before running tests."));
      return;
    }
    const worker =
      options.createWorker?.() ??
      new Worker(new URL("./tests.worker.ts", import.meta.url), { type: "module" });
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", stop);
      worker.terminate();
      return true;
    };
    const stop = () => {
      if (finish()) reject(new Error("Tests stopped."));
    };
    const timeout = setTimeout(() => {
      if (finish())
        reject(
          new Error("The tests took too long and were stopped. Run fewer tests and try again."),
        );
    }, options.deadlineMs ?? 30_000);
    options.signal?.addEventListener("abort", stop, { once: true });
    worker.onmessage = (event: MessageEvent<TestsWorkerOutbound>) => {
      if (!finish()) return;
      if ("result" in event.data) resolve(event.data.result);
      else reject(new Error(event.data.error));
    };
    worker.onerror = () => {
      if (finish()) reject(new Error("The tests could not start. Try running them again."));
    };
    try {
      worker.postMessage({
        files: Object.fromEntries(image.files()),
        documents: snapshot.documents(),
        profileId: image.identity.profileId,
        allowMissingRooms: session.allowMissingRooms,
        names: options.names ?? null,
      } satisfies TestsWorkerInbound);
    } catch (error) {
      if (finish()) reject(error);
    }
  });
}

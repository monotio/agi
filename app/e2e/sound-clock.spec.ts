import type { EngineStateReport } from "../../src/runtime/engine.ts";
import type { SoundOutput } from "../../src/sound/sound.ts";
import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

/** The worker replies this test reads (engine.worker.ts, "Messages out"). */
type WorkerReply =
  | { type: "cycle"; cycle: number }
  | { type: "error"; message: string }
  | { type: "soundOutput"; output: SoundOutput }
  | { type: "stopSound" }
  | { type: "hostRequest"; id: number; op: string; context: Record<string, unknown> }
  | { type: "engineState"; id: number; state: EngineStateReport };
type Reply<T extends WorkerReply["type"]> = Extract<WorkerReply, { type: T }>;

test("sound ticks and completion continue during a blocking host prompt", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(
    async ({ containerPath, assemblerPath }) => {
      const { createContainer } = await import(containerPath);
      const { assembleLogic } = await import(assemblerPath);
      const workerPath = "/src/engine.worker.ts?worker";
      const { default: EngineWorker } = await import(workerPath);
      const container = createContainer();
      container.putResource(
        "logic",
        0,
        assembleLogic(
          `
      if (!isset(f201)) {
        set(f201); set(f9); load.sound(0); sound(0, f200);
        get.num("Continue?", v202);
      }
      if (isset(f200)) { assignn(v203, 88); }
      return;
    `,
          { dictionary: new Map() },
        ).payload,
      );
      // Channel0: duration3, divisor258, audible. Other channels terminate immediately.
      container.putResource(
        "sound",
        0,
        new Uint8Array([8, 0, 15, 0, 15, 0, 15, 0, 3, 0, 0x10, 0x82, 0x90, 255, 255, 255, 255]),
      );
      const worker = new EngineWorker() as Worker;
      const sab = new SharedArrayBuffer(16);
      const messages: WorkerReply[] = [];
      const waiters = new Set<() => void>();
      worker.onmessage = (event) => {
        messages.push(event.data);
        for (const wake of waiters) wake();
      };
      const wait = <T extends WorkerReply>(
        predicate: (message: WorkerReply) => message is T,
      ): Promise<T> =>
        new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            waiters.delete(check);
            reject(new Error("Worker reply timed out"));
          }, 10000);
          const check = () => {
            const error = messages.find(
              (message): message is Reply<"error"> => message.type === "error",
            );
            const message = messages.find(predicate);
            if (!message && !error) return;
            clearTimeout(timeout);
            waiters.delete(check);
            if (error) reject(new Error(error.message));
            else resolve(message!);
          };
          waiters.add(check);
          check();
        });
      try {
        worker.postMessage({
          type: "boot",
          files: Object.fromEntries(container.files),
          words: [],
          soundDevice: 0,
          sab,
        });
        const audible = await wait(
          (message): message is Reply<"soundOutput"> =>
            message.type === "soundOutput" &&
            message.output.kind === "speaker" &&
            message.output.divisor !== null,
        );
        await wait(
          (message): message is Reply<"stopSound"> =>
            message.type === "stopSound" && messages.indexOf(message) > messages.indexOf(audible),
        );
        const request = await wait(
          (message): message is Reply<"hostRequest"> => message.type === "hostRequest",
        );
        const cycleWhileBlocked = messages.some((message) => message.type === "cycle");
        worker.postMessage({ type: "hostAnswer", id: request.id, response: "7" });
        worker.postMessage({ type: "state", id: 1 });
        const after = await wait(
          (message): message is Reply<"engineState"> =>
            message.type === "engineState" && message.id === 1,
        );
        return {
          audible: audible.output,
          prompt: request.op,
          cycleWhileBlocked,
          vars: after.state.vars,
        };
      } finally {
        worker.terminate();
      }
    },
    {
      containerPath:
        "/@fs" + fileURLToPath(new URL("../../src/container/container.ts", import.meta.url)),
      assemblerPath:
        "/@fs" + fileURLToPath(new URL("../../src/logic/assembler.ts", import.meta.url)),
    },
  );
  expect(result.audible).toEqual({ kind: "speaker", divisor: 3096 });
  expect(result.prompt).toBe("getnum");
  expect(result.cycleWhileBlocked).toBe(false);
  expect(result.vars[202]).toBe(7);
  expect(result.vars[203]).toBe(88);
});

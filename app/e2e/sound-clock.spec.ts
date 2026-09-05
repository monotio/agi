import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

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
      const sab = new SharedArrayBuffer(16 + 65536);
      const header = new Int32Array(sab, 0, 4);
      const bridgeBytes = new Uint8Array(sab, 16);
      const messages: any[] = [];
      const waiters = new Set<() => void>();
      worker.onmessage = (event) => {
        messages.push(event.data);
        for (const wake of waiters) wake();
      };
      const wait = (predicate: (message: any) => boolean): Promise<any> =>
        new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            waiters.delete(check);
            reject(new Error("Worker reply timed out"));
          }, 10000);
          const check = () => {
            const error = messages.find((message) => message.type === "error");
            const message = messages.find(predicate);
            if (!message && !error) return;
            clearTimeout(timeout);
            waiters.delete(check);
            if (error) reject(new Error(error.message));
            else resolve(message);
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
          (message) =>
            message.type === "soundOutput" &&
            message.output.kind === "speaker" &&
            message.output.divisor !== null,
        );
        await wait(
          (message) =>
            message.type === "stopSound" && messages.indexOf(message) > messages.indexOf(audible),
        );
        const blockedState = Atomics.load(header, 0);
        const prompt = JSON.parse(
          new TextDecoder().decode(bridgeBytes.slice(0, Atomics.load(header, 1))),
        );
        const cycleWhileBlocked = messages.some((message) => message.type === "cycle");
        bridgeBytes.set(new TextEncoder().encode("7"));
        Atomics.store(header, 1, 1);
        Atomics.store(header, 0, 2);
        Atomics.notify(header, 0);
        worker.postMessage({ type: "state", id: 1 });
        const after = await wait((message) => message.type === "engineState" && message.id === 1);
        return {
          audible: audible.output,
          blockedState,
          prompt: prompt.op,
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
  expect(result.blockedState).toBe(1);
  expect(result.prompt).toBe("getnum");
  expect(result.cycleWhileBlocked).toBe(false);
  expect(result.vars[202]).toBe(7);
  expect(result.vars[203]).toBe(88);
});

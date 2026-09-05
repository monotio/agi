import { test, expect } from "@playwright/test";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildView } from "../../src/view/view.ts";

function cartridge(delay: number, modal = false) {
  const game = createContainer();
  game.putResource(
    "logic",
    0,
    assembleLogic("if (equaln(v0,0)) {new.room(1);} increment(v40);call(1);return;", {
      dictionary: new Map(),
    }).payload,
  );
  game.putResource(
    "logic",
    1,
    assembleLogic(
      `if (isset(f5)) {assignn(v10,${delay});assignn(v60,1);load.pic(v60);draw.pic(v60);show.pic();load.view(0);animate.obj(0);set.view(0,0);position(0,80,120);draw(0);accept.input();${modal ? 'print("Timing prompt");' : ""}} return;`,
      { dictionary: new Map() },
    ).payload,
  );
  game.putResource("picture", 1, Uint8Array.of(255));
  game.putResource(
    "view",
    0,
    buildView({
      loops: [
        {
          cels: [
            { width: 1, height: 1, pixels: [1] },
            { width: 1, height: 1, pixels: [2] },
            { width: 1, height: 1, pixels: [3] },
          ],
        },
      ],
    }),
  );
  return Object.fromEntries([...game.files].map(([name, bytes]) => [name, Array.from(bytes)]));
}

test("worker honors v10 pace while modal keys and pause remain responsive", async ({ page }) => {
  await page.goto("/");
  const observations = await page.evaluate(
    async (games) => {
      interface WorkerState {
        vars: number[];
        modalKind: string | null;
      }
      async function start(files: Record<string, number[]>) {
        const worker = new Worker("/src/engine.worker.ts", { type: "module" });
        const sab = new SharedArrayBuffer(16 + 1024 * 1024);
        let id = 0;
        const pending = new Map<number, (state: WorkerState) => void>();
        let resolveBoot!: () => void;
        const booted = new Promise<void>((resolve) => {
          resolveBoot = resolve;
        });
        const errors: string[] = [];
        worker.onmessage = (event) => {
          if (event.data.type === "booted") resolveBoot();
          if (event.data.type === "error") errors.push(event.data.message);
          if (event.data.type === "engineState") {
            pending.get(event.data.id)?.(event.data.state);
            pending.delete(event.data.id);
          }
        };
        worker.postMessage({
          type: "boot",
          files: Object.fromEntries(
            Object.entries(files).map(([name, bytes]) => [name, new Uint8Array(bytes)]),
          ),
          words: [],
          sab,
        });
        await booted;
        const read = () =>
          new Promise<WorkerState>((resolve) => {
            pending.set(++id, resolve);
            worker.postMessage({ type: "state", id });
          });
        const until = async (predicate: (state: WorkerState) => boolean, limit = 5000) => {
          const deadline = performance.now() + limit;
          while (performance.now() < deadline) {
            const state = await read();
            if (predicate(state)) return state;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error(`Worker state deadline exceeded: ${errors.join("; ")}`);
        };
        await until((state) => state.vars[40]! >= 1);
        return { worker, sab, read, until, errors };
      }
      const [fast, slow, prompt] = await Promise.all(games.map((files) => start(files)));
      try {
        const beforeFast = (await fast!.read()).vars[40]!;
        const beforeSlow = (await slow!.read()).vars[40]!;
        const started = performance.now();
        await slow!.until((state) => state.vars[40]! >= beforeSlow + 10);
        const elapsed = performance.now() - started;
        const fastDelta = (await fast!.read()).vars[40]! - beforeFast;
        const slowDelta = (await slow!.read()).vars[40]! - beforeSlow;
        const clockFast = (await fast!.read()).vars[11]!;
        const clockSlow = (await slow!.read()).vars[11]!;
        const promptBefore = await prompt!.read();
        const keyAt = performance.now();
        prompt!.worker.postMessage({ type: "key", code: 13 });
        await prompt!.until((state) => state.modalKind === null, 1000);
        const keyMs = performance.now() - keyAt;
        const paused = new Int32Array(slow!.sab, 0, 4);
        Atomics.store(paused, 2, 1);
        // Observe a fixed number of fast-worker cycles to prove elapsed host time while slow is parked.
        const pausedState = await slow!.read();
        const pausedAt = pausedState.vars[40]!;
        const clockPausedAt = pausedState.vars[11]!;
        const fastAt = (await fast!.read()).vars[40]!;
        await fast!.until((state) => state.vars[40]! >= fastAt + 30);
        const pausedStateEnd = await slow!.read();
        const pausedEnd = pausedStateEnd.vars[40]!;
        const clockPausedEnd = pausedStateEnd.vars[11]!;
        Atomics.store(paused, 2, 0);
        const resumedAt = performance.now();
        await slow!.until((state) => state.vars[40]! >= pausedEnd + 2);
        const resumeMs = performance.now() - resumedAt;
        return {
          clockFast,
          clockSlow,
          clockPausedAt,
          clockPausedEnd,
          clockDuringModal: promptBefore.vars[11],
          elapsed,
          fastDelta,
          slowDelta,
          promptBefore: promptBefore.modalKind,
          keyMs,
          pausedAt,
          pausedEnd,
          resumeMs,
          errors: [...fast!.errors, ...slow!.errors, ...prompt!.errors],
        };
      } finally {
        fast!.worker.terminate();
        slow!.worker.terminate();
        prompt!.worker.terminate();
      }
    },
    [cartridge(1), cartridge(4), cartridge(20, true)],
  );
  expect(observations.errors).toEqual([]);
  expect(observations.clockFast).toBeGreaterThanOrEqual(2);
  expect(Math.abs(observations.clockFast - observations.clockSlow)).toBeLessThanOrEqual(1);
  expect(observations.clockPausedEnd).toBe(observations.clockPausedAt);
  expect(observations.clockDuringModal).toBe(0);
  expect(observations.elapsed).toBeGreaterThan(1700);
  expect(observations.elapsed).toBeLessThan(3000);
  expect(observations.fastDelta / observations.slowDelta).toBeGreaterThan(3.2);
  expect(observations.fastDelta / observations.slowDelta).toBeLessThan(4.8);
  expect(observations.promptBefore).toBe("print");
  expect(observations.keyMs).toBeLessThan(300);
  expect(observations.pausedEnd).toBe(observations.pausedAt);
  expect(observations.resumeMs).toBeGreaterThan(300);
  expect(observations.resumeMs).toBeLessThan(800);
});

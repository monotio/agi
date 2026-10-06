import assert from "node:assert/strict";
import { beforeEach } from "node:test";
import { scheduler } from "node:timers/promises";

/** Poll an observable condition between event-loop turns, with a failure deadline. */
export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = performance.now() + 1000;
  while (!(await check())) {
    assert.ok(performance.now() < deadline, message);
    await scheduler.yield();
  }
}

/** Advance deadlines separately so each timer's promise continuations finish before the next. */
export function useTestClock(): { advance(ms: number): Promise<void> } {
  let tick: (ms: number) => void;
  beforeEach((t) => {
    assert.ok("mock" in t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    tick = (ms) => t.mock.timers.tick(ms);
  });
  return {
    async advance(ms) {
      for (let elapsed = 0; elapsed < ms;) {
        const step = Math.min(5, ms - elapsed);
        elapsed += step;
        tick(step);
        await scheduler.yield();
      }
      tick(0);
      await scheduler.yield();
    },
  };
}

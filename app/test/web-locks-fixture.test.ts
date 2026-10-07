import assert from "node:assert/strict";
import { test } from "node:test";
import { installWebLocksFixture } from "./webLocksFixture.ts";

test("a rejected lock holder releases the next queued waiter", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  });
  installWebLocksFixture();
  const calls: string[] = [];
  let reject!: (reason: Error) => void;
  const held = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const first = navigator.locks.request("project", () => {
    calls.push("holder");
    return held;
  });
  const refusal = assert.rejects(first, /holder failed/);
  const second = navigator.locks.request("project", () => {
    calls.push("waiter");
  });
  // Observe both requests even when the faulty fixture propagates the rejection.
  const finished = Promise.allSettled([first, second]);
  reject(new Error("holder failed"));
  await refusal;
  const results = await finished;
  assert.equal(results[1]!.status, "fulfilled");
  assert.deepEqual(calls, ["holder", "waiter"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRelativeTime } from "../src/home/relativeTime.ts";
import { createThumbnailQueue } from "../src/home/thumbnailQueue.ts";

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const MINUTE = 60_000;

test("relative time reads in minutes, hours and days, then names the date", () => {
  assert.equal(formatRelativeTime(NOW - 20_000, NOW), "just now");
  assert.equal(formatRelativeTime(NOW + 5 * MINUTE, NOW), "just now");
  assert.equal(formatRelativeTime(NOW - MINUTE, NOW), "1 min ago");
  assert.equal(formatRelativeTime(NOW - 12 * MINUTE - 30_000, NOW), "12 min ago");
  assert.equal(formatRelativeTime(NOW - 60 * MINUTE, NOW), "1 hour ago");
  assert.equal(formatRelativeTime(NOW - 5 * 60 * MINUTE, NOW), "5 hours ago");
  assert.equal(formatRelativeTime(NOW - 24 * 60 * MINUTE, NOW), "1 day ago");
  assert.equal(formatRelativeTime(NOW - 6 * 24 * 60 * MINUTE, NOW), "6 days ago");
  assert.equal(formatRelativeTime(Date.UTC(2026, 8, 3, 12), NOW), "on Sep 3");
  assert.equal(formatRelativeTime(Date.UTC(2025, 11, 24, 12), NOW), "on Dec 24, 2025");
  assert.equal(formatRelativeTime(Number.NaN, NOW), "");
});

interface Deferred {
  resolve(value: string): void;
  reject(error: Error): void;
}

/** A render whose completion the test controls, recording when it started. */
function controlledRenders() {
  const started: string[] = [];
  const pending = new Map<string, Deferred>();
  const render = (key: string) => () => {
    started.push(key);
    return new Promise<string>((resolve, reject) => pending.set(key, { resolve, reject }));
  };
  return { started, pending, render };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the thumbnail queue runs at most two renders at a time, in request order", async () => {
  const queue = createThumbnailQueue(2);
  const { started, pending, render } = controlledRenders();
  const results = Promise.allSettled(
    ["a", "b", "c", "d"].map((key) => queue.request(key, render(key))),
  );
  await tick();
  assert.deepEqual(started, ["a", "b"]);
  pending.get("b")!.resolve("B");
  await tick();
  assert.deepEqual(started, ["a", "b", "c"]);
  pending.get("a")!.reject(new Error("broken game"));
  await tick();
  assert.deepEqual(started, ["a", "b", "c", "d"]);
  pending.get("c")!.resolve("C");
  pending.get("d")!.resolve("D");
  assert.deepEqual(
    (await results).map((result) => (result.status === "fulfilled" ? result.value : "failed")),
    ["failed", "B", "C", "D"],
  );
});

test("each key renders once per session, successes and failures alike", async () => {
  const queue = createThumbnailQueue(2);
  const { started, pending, render } = controlledRenders();
  const first = queue.request("game", render("game"));
  const again = queue.request("game", render("game"));
  assert.equal(first, again);
  await tick();
  pending.get("game")!.resolve("data:image/png;base64,AA");
  assert.equal(await first, "data:image/png;base64,AA");
  assert.equal(queue.cached("game"), "data:image/png;base64,AA");
  assert.equal(await queue.request("game", render("game")), "data:image/png;base64,AA");

  const failed = queue.request("broken", render("broken"));
  await tick();
  pending.get("broken")!.reject(new Error("no picture"));
  await assert.rejects(failed, /no picture/);
  await assert.rejects(queue.request("broken", render("broken")), /no picture/);
  assert.equal(queue.cached("broken"), undefined);
  assert.deepEqual(started, ["game", "broken"]);
});

test("a request abandoned before its turn never renders and can be asked for again", async () => {
  const queue = createThumbnailQueue(1);
  const { started, pending, render } = controlledRenders();
  const busy = queue.request("busy", render("busy"));
  const controller = new AbortController();
  const abandoned = queue.request("scrolled-away", render("scrolled-away"), controller.signal);
  controller.abort();
  await tick();
  pending.get("busy")!.resolve("BUSY");
  await busy;
  await assert.rejects(abandoned, { name: "AbortError" });
  assert.deepEqual(started, ["busy"]);
  const retried = queue.request("scrolled-away", render("scrolled-away"));
  await tick();
  pending.get("scrolled-away")!.resolve("BACK");
  assert.equal(await retried, "BACK");
  assert.deepEqual(started, ["busy", "scrolled-away"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { gameContainer, workerHarness } from "./worker-ctx.ts";
import type { Inbound } from "../src/worker/context.ts";
import { resetSession } from "../src/worker/context.ts";

// One tickEngine run emits ~INSTRUCTIONS trace records: a chain of plain
// assignn ops, no conditions, so every instruction executes every cycle.
const INSTRUCTIONS = 60;
const OPS = Array.from(
  { length: INSTRUCTIONS },
  (_, i) => `assignn(v${(i % 200) + 10}, ${i % 250});`,
).join(" ");

function traceGame() {
  return gameContainer([`${OPS} return;`]);
}

function armTrace(ctx: ReturnType<typeof workerHarness>["ctx"]) {
  const msg: Inbound<"debug"> = { type: "debug", channels: { trace: true } };
  ctx.fns.onDebug(msg);
}

/** Run n interpreter cycles, flushing like finishCycle does. */
function produce(ctx: ReturnType<typeof workerHarness>["ctx"], cycles: number) {
  for (let i = 0; i < cycles; i++) {
    ctx.fns.tickEngine();
    ctx.fns.flushTraceBatch();
  }
}

test("a stalled consumer bounds the backlog and counts the loss exactly", () => {
  const { ctx, presentation, control } = workerHarness(traceGame());
  armTrace(ctx);
  produce(ctx, 50);
  const produced = ctx.debug.traceSeq; // monotonic counter: every record the listener saw

  const batches = presentation.filter((m) => m.type === "trace");
  assert.equal(batches.length, 4, "posted batches are bounded by the in-flight credit cap");
  for (const b of batches) assert.equal(b.epoch, ctx.debug.traceEpoch);
  assert.equal(ctx.debug.traceInFlight, 4);

  const delivered = batches.reduce((n, b) => n + (b.type === "trace" ? b.records.length : 0), 0);
  const retained = ctx.debug.pendingTrace.length;
  assert.ok(retained <= 2000, `pendingTrace bounded: ${retained}`);
  const dropped = batches.reduce(
    (n, b) => n + (b.type === "trace" ? b.dropped : 0),
    ctx.debug.traceDropped,
  );
  assert.equal(delivered + retained + dropped, produced, "exact loss accounting");

  // Surviving records keep their monotonic order across every batch.
  const seqs = batches.flatMap((b) => (b.type === "trace" ? b.records.map((r) => r.seq) : []));
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i]! > seqs[i - 1]!);

  // Control messages stay responsive while the trace backs up.
  ctx.fns.onPause({ type: "pause", paused: true });
  assert.ok(
    control.some((m) => m.type === "paused" && m.paused === true),
    "control traffic is not blocked by the stalled trace stream",
  );
});

test("an ack frees a credit, drains the backlog and reports the loss", () => {
  const { ctx, presentation } = workerHarness(traceGame());
  armTrace(ctx);
  produce(ctx, 50); // 3000 records; 4 batches post, the rest queues or drops
  const stalled = presentation.filter((m) => m.type === "trace");
  const last = stalled[stalled.length - 1]!;
  assert.ok(last.type === "trace");

  ctx.fns.onTraceAck({ type: "traceAck", epoch: last.epoch, batch: last.batch });
  const batches = presentation.filter((m) => m.type === "trace");
  assert.equal(batches.length, 5, "one freed credit posts exactly one more batch");
  const fresh = batches[4]!;
  assert.ok(fresh.type === "trace" && fresh.dropped > 0, "the batch reports dropped records");
  assert.equal(ctx.debug.traceInFlight, 4, "credit cap refills while records remain");
});

test("a stale ack frees no credit in a replaced stream", () => {
  const { ctx, presentation } = workerHarness(traceGame());
  armTrace(ctx);
  produce(ctx, 10);
  const old = presentation.filter((m) => m.type === "trace").at(-1)!;
  assert.ok(old.type === "trace");

  ctx.fns.onDebug({ type: "debug", channels: { trace: false } });
  assert.equal(ctx.debug.pendingTrace.length, 0, "disarm drops the unposted backlog");
  assert.equal(ctx.debug.traceInFlight, 0);
  assert.notEqual(ctx.debug.traceEpoch, old.type === "trace" ? old.epoch : -1);

  // Re-arm and generate again: the old epoch's ack must not free a credit.
  armTrace(ctx);
  produce(ctx, 4);
  const count = presentation.filter((m) => m.type === "trace").length;
  ctx.fns.onTraceAck({ type: "traceAck", epoch: old.epoch, batch: old.batch });
  assert.equal(presentation.filter((m) => m.type === "trace").length, count);
});

test("session reset clears the trace stream for the next game", () => {
  const { ctx } = workerHarness(traceGame());
  armTrace(ctx);
  produce(ctx, 10);
  const epoch = ctx.debug.traceEpoch;

  resetSession(ctx);
  assert.notEqual(ctx.debug.traceEpoch, epoch);
  assert.equal(ctx.debug.pendingTrace.length, 0);
  assert.equal(ctx.debug.traceInFlight, 0);
  assert.equal(ctx.debug.traceDropped, 0);
  assert.equal(ctx.debug.traceRing.length, 0);
});

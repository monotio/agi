/**
 * Inspector plumbing: state diffs, the trace channel, and the debug
 * messages. Pure functions of the worker context — importable under Node.
 */
import type { Inbound, WorkerContext } from "./context.ts";

const DEBUG_EVENT_CAP = 4000;
const TRACE_CAP = 4000;
const TRACE_POST_MAX = 500;
/**
 * The trace backlog stays bounded even while the consumer stalls: at most
 * TRACE_PENDING_CAP records wait locally, and at most TRACE_INFLIGHT_MAX
 * posted batches await traceAck. Loss is reported through `dropped` on the
 * next batch and through the monotonic seq gap in the surviving records.
 * A capped array alone cannot bound the browser's posted-message queue,
 * so posting is credit-based: each batch posts only once a slot is free.
 */
const TRACE_PENDING_CAP = 2000;
const TRACE_INFLIGHT_MAX = 4;

export function createDebug(ctx: WorkerContext) {
  /**
   * Diff vars/flags against the previous completed cycle. The ring records
   * every write the interpreter made — the timeline lane's raw material —
   * whether or not an inspector view is currently open.
   */
  function captureStateDiffs(): void {
    if (!ctx.engine) return;
    if (ctx.debug.prevVars === null || ctx.debug.prevFlags === null) {
      ctx.debug.prevVars = ctx.engine.vars.slice();
      ctx.debug.prevFlags = ctx.engine.flags.slice();
      return;
    }
    for (let i = 0; i < 256; i++) {
      const v = ctx.engine.vars[i]!;
      if (v !== ctx.debug.prevVars[i])
        ctx.debug.debugEvents.push({
          seq: ++ctx.debug.debugEventSeq,
          cycle: ctx.cycle.cycleCount,
          kind: "var",
          index: i,
          from: ctx.debug.prevVars[i]!,
          to: v,
        });
      const f = ctx.engine.flags[i]!;
      if (f !== ctx.debug.prevFlags[i])
        ctx.debug.debugEvents.push({
          seq: ++ctx.debug.debugEventSeq,
          cycle: ctx.cycle.cycleCount,
          kind: "flag",
          index: i,
          from: ctx.debug.prevFlags[i]!,
          to: f,
        });
    }
    ctx.debug.prevVars.set(ctx.engine.vars);
    ctx.debug.prevFlags.set(ctx.engine.flags);
    if (ctx.debug.debugEvents.length > DEBUG_EVENT_CAP)
      ctx.debug.debugEvents.splice(0, ctx.debug.debugEvents.length - DEBUG_EVENT_CAP);
  }

  function applyTraceChannel(): void {
    ctx.engine?.setTraceListener(
      ctx.debug.channels.trace
        ? (record) => {
            const stamped = { ...record, seq: ++ctx.debug.traceSeq, cycle: ctx.cycle.cycleCount };
            ctx.debug.traceRing.push(stamped);
            if (ctx.debug.traceRing.length > TRACE_CAP)
              ctx.debug.traceRing.splice(0, ctx.debug.traceRing.length - TRACE_CAP);
            ctx.debug.pendingTrace.push(stamped);
            if (ctx.debug.pendingTrace.length > TRACE_PENDING_CAP) {
              // Evict the oldest records and count the loss; the consumer
              // sees the seq gap plus the dropped total on the next batch.
              const excess = ctx.debug.pendingTrace.length - TRACE_PENDING_CAP;
              ctx.debug.pendingTrace.splice(0, excess);
              ctx.debug.traceDropped += excess;
            }
          }
        : null,
    );
  }

  /**
   * Post accumulated trace records under a bounded credit policy: a batch
   * goes out only while fewer than TRACE_INFLIGHT_MAX batches await the
   * host's traceAck. The presentation port drops them while seeking.
   */
  function flushTraceBatch(): void {
    if (ctx.debug.pendingTrace.length === 0) return;
    if (ctx.debug.traceInFlight >= TRACE_INFLIGHT_MAX) return;
    const records = ctx.debug.pendingTrace.splice(0, TRACE_POST_MAX);
    ctx.debug.traceInFlight++;
    ctx.ports.presentation({
      type: "trace",
      epoch: ctx.debug.traceEpoch,
      batch: ++ctx.debug.traceBatch,
      dropped: ctx.debug.traceDropped,
      records,
    });
    ctx.debug.traceDropped = 0;
  }

  /**
   * The host consumed one batch — free a credit and drain what queued while
   * it was stalled. Acks from a replaced session carry an old epoch and are
   * ignored: their batches already posted, but the credit belongs to the
   * stream they came from.
   */
  function onTraceAck(msg: Inbound<"traceAck">): void {
    if (msg.epoch !== ctx.debug.traceEpoch) return;
    if (ctx.debug.traceInFlight > 0) ctx.debug.traceInFlight--;
    flushTraceBatch();
  }

  function onDebug(msg: Inbound<"debug">): void {
    const want = msg.channels ?? {};
    const traceWas = ctx.debug.channels.trace;
    ctx.debug.channels.ownership = want.ownership === true;
    ctx.debug.channels.objects = want.objects === true;
    ctx.debug.channels.trace = want.trace === true;
    ctx.debug.channels.picture = want.picture === true;
    if (ctx.debug.channels.trace !== traceWas) {
      applyTraceChannel();
      if (!ctx.debug.channels.trace) {
        // Disarming ends the stream: drop the unposted backlog and bump the
        // epoch so acks of already-posted batches cannot free fake credits.
        ctx.debug.pendingTrace = [];
        ctx.debug.traceDropped = 0;
        ctx.debug.traceInFlight = 0;
        ctx.debug.traceEpoch++;
      }
    }
    // Invalidate the sameness check so a newly armed channel ships with the
    // next frame and a disarmed one clears promptly.
    ctx.presentation.lastVisual = null;
    ctx.presentation.lastObjectsJson = "";
    ctx.fns.postFrame();
  }

  function onDebugWrite(msg: Inbound<"debugWrite">): void {
    if (!ctx.engine) return;
    const jumps = Array.isArray(msg.vars) && msg.vars.some((pair) => pair[0] === 0);
    if (Array.isArray(msg.vars))
      for (const pair of msg.vars) ctx.engine.vars[pair[0]! & 0xff] = pair[1]! & 0xff;
    if (Array.isArray(msg.flags))
      for (const pair of msg.flags) ctx.engine.flags[pair[0]! & 0xff] = pair[1] ? 1 : 0;
    if (jumps) ctx.fns.markJump();
    // Attribute the host write to the current boundary, not the next cycle.
    captureStateDiffs();
    if (jumps) ctx.fns.noteTransition();
    ctx.ports.control({ type: "debugWritten", id: msg.id });
  }

  function onDebugEvents(msg: Inbound<"debugEvents">): void {
    const since = typeof msg.since === "number" ? msg.since : 0;
    ctx.ports.control({
      type: "debugEvents",
      id: msg.id,
      cycle: ctx.cycle.cycleCount,
      latestSeq: ctx.debug.debugEventSeq,
      events: ctx.debug.debugEvents.filter((e) => e.seq > since),
    });
  }

  function onDebugTrace(msg: Inbound<"debugTrace">): void {
    const since = typeof msg.since === "number" ? msg.since : 0;
    ctx.ports.control({
      type: "debugTrace",
      id: msg.id,
      cycle: ctx.cycle.cycleCount,
      latestSeq: ctx.debug.traceSeq,
      records: ctx.debug.traceRing.filter((r) => r.seq > since),
    });
  }

  return {
    captureStateDiffs,
    applyTraceChannel,
    flushTraceBatch,
    onDebug,
    onDebugWrite,
    onDebugEvents,
    onDebugTrace,
    onTraceAck,
  };
}

export type DebugModule = ReturnType<typeof createDebug>;

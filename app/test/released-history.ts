/** Real-worker takeover of the immutable, released 1.2.5 restart recording. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { HistorySegment } from "../../src/agent/history.ts";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type {
  BootMessage,
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
} from "../src/worker/workerProtocol.ts";
import { base64ToBytes } from "../src/project/bytes.ts";
import { testProjectId, testRevision } from "./identity.ts";

export function releasedRestartHarness(
  t: { after(callback: () => void): void },
  restore?: Partial<BootMessage>,
) {
  const segments = JSON.parse(
    readFileSync(new URL("./formats/history-1.2.5-restart.json", import.meta.url), "utf8"),
  ) as HistorySegment[];
  const files = Object.fromEntries(
    Object.entries(segments[0]!.boot.files).map(([name, data]) => [name, base64ToBytes(data)]),
  );
  let now = 0;
  const control: WorkerControl[] = [];
  const presentation: WorkerPresentation[] = [];
  const ctx = createWorkerContext({
    control: (message) => control.push(message),
    presentation: (message) => presentation.push(message),
    now: () => now,
  });
  ctx.host = createEngineHost(ctx);
  t.after(() => ctx.fns.stopTimers());
  const send = (message: WorkerInbound) => onWorkerMessage(ctx, message);
  const tick = (count = 1) => {
    for (let i = 0; i < count; i++) {
      now += 1000 / 60;
      ctx.fns.hostTick();
    }
  };
  send({ type: "boot", profile: "2.936", files, words: [], ...restore });
  ctx.fns.stopTimers();
  return { ctx, control, presentation, files, segments, send, tick };
}

export function takeReleasedRestart(h: ReturnType<typeof releasedRestartHarness>) {
  h.tick(12);
  h.send({ type: "pause", paused: true });
  h.send({
    type: "historyViewStart",
    id: 1,
    recording: {
      version: 3,
      identity: { project: testProjectId("released-restart"), revision: testRevision("restart") },
      profile: "2.936",
      resourceSet: h.segments[0]!.boot.resourceSet,
      startedAt: 0,
      segments: h.segments,
    },
    segment: 0,
    tick: 10,
  });
  const opened = h.control.findLast(
    (message) => message.type === "historyView" && message.id === 1,
  );
  assert.ok(opened?.type === "historyView" && opened.canResume);
  h.send({
    type: "historyViewTake",
    id: 2,
    generation: opened.generation,
    segment: 0,
    tick: opened.tick,
    seq: opened.seq,
  });
  const taken = h.control.findLast(
    (message) => message.type === "historyTaken" && message.id === 2,
  );
  assert.ok(taken?.type === "historyTaken" && taken.ok);
  h.send({ type: "pause", paused: false });
  h.tick();
}

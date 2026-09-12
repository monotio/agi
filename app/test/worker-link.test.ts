import test from "node:test";
import assert from "node:assert/strict";
import { useWorkerLink } from "../src/useWorkerLink.ts";
import type { WorkerOutbound, WorkerQueryPayload, WorkerQueryType } from "../src/workerProtocol.ts";
import type { EngineState, TextHook } from "../src/useEngineTypes.ts";
import type { AgiAudio } from "../src/audio/AgiAudio.ts";
import type { ReplayObservation } from "../src/replay.ts";

/**
 * The outbound dispatch table is a required mapped type — a WorkerOutbound
 * member without a handler is a compile error, not a dropped message. This
 * suite delivers every member once through a fake worker and asserts it
 * reached its documented effect, plus the query correlation, stale-session
 * and replacement guards.
 */
const OUTBOUND_TYPES = [
  "paused",
  "hostRequest",
  "interactionCancelled",
  "replay",
  "error",
  "frames",
  "engineState",
  "objects",
  "debugWritten",
  "debugEvents",
  "debugTrace",
  "checkpoint",
  "recordingStarted",
  "recordingStopped",
  "exportFiles",
  "restored",
  "booted",
  "roomTransition",
  "flushed",
  "metadataPatched",
  "frame",
  "trace",
  "print",
  "status",
  "shake",
  "showObj",
  "autosave",
  "controls",
  "inputEdit",
  "cycle",
  "waitingForKey",
  "soundEnabled",
  "sound",
  "soundOutput",
  "soundPaused",
  "stopSound",
  "quit",
  "log",
] as const;

// Compile-time exhaustiveness: a protocol member missing from (or extra in)
// this list fails `npm run check` here.
type AssertNever<T extends never> = T;
type _Missing = AssertNever<Exclude<WorkerOutbound["type"], (typeof OUTBOUND_TYPES)[number]>>;
type _Extra = AssertNever<Exclude<(typeof OUTBOUND_TYPES)[number], WorkerOutbound["type"]>>;

function fakeWorker() {
  const posted: unknown[] = [];
  return {
    posted,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    postMessage(msg: unknown) {
      posted.push(msg);
    },
    terminate() {},
  };
}
type FakeWorker = ReturnType<typeof fakeWorker>;

function fakeState(): EngineState {
  return {
    controls: [],
    agentLog: [],
    rows: [],
    powerUp: { messages: [] },
    walkthrough: {},
    debugTrace: [],
    debugTraceDropped: 0,
    debugObjects: [],
    roomJournal: [],
    prompt: null,
  } as unknown as EngineState;
}

function fakeHook(): TextHook {
  return {
    rows: [],
    modal: null,
    textMode: false,
    profile: null,
    paused: false,
    cycle: 0,
    frame: 0,
    autosave: -1,
    room: 0,
    egoX: 0,
    egoY: 0,
  };
}

function makeLink() {
  const state = fakeState();
  const hook = fakeHook();
  const audioCalls: string[] = [];
  const audio = {
    setMuted: () => audioCalls.push("setMuted"),
    setPaused: () => audioCalls.push("setPaused"),
    stop: () => audioCalls.push("stop"),
    output: () => audioCalls.push("output"),
  } as unknown as AgiAudio;
  const depCalls: string[] = [];
  const logged: string[] = [];
  const frames: unknown[] = [];
  const driver = { latest: null as ReplayObservation | null };
  const link = useWorkerLink({
    state,
    hook,
    audio,
    onFrame: (f) => frames.push(f),
    logAgent: (kind, text) => logged.push(`${kind}:${text}`),
    getBootedGame: () => null,
    getActiveWalkthroughSession: () => 7,
    observationListeners: new Set(),
  });
  Object.assign(link.deps, {
    resetScreenState: () => depCalls.push("resetScreenState"),
    cancelPrompt: () => depCalls.push("cancelPrompt"),
    handleAutosave: () => depCalls.push("autosave"),
    handleFlushed: () => depCalls.push("flushed"),
    handleRestored: () => depCalls.push("restored"),
    handleSaveSlotRequest: () => "ok",
    handlePromptRequest: async () => "42",
    handleRoomAuthoring: async () => "done",
    getAgentSession: () => null,
    getReplayDriver: () => driver,
    ejectGame: () => depCalls.push("ejectGame"),
  });
  return { link, state, hook, audioCalls, depCalls, logged, frames, driver };
}

function deliver(w: FakeWorker, msg: WorkerOutbound): void {
  w.onmessage!({ data: msg });
}

function fakeObservation(over: Partial<ReplayObservation> = {}): ReplayObservation {
  return {
    sessionId: 0,
    revision: 1,
    cycle: 3,
    blocked: null,
    rows: [],
    state: {
      inputEnabled: true,
      inputReady: true,
      modalKind: null,
      room: 1,
      egoX: 0,
      egoY: 0,
    },
    ...over,
  } as unknown as ReplayObservation;
}

/** Start a query, then answer it through the wire with the captured id. */
async function roundTrip<K extends WorkerQueryType>(
  link: ReturnType<typeof useWorkerLink>,
  w: FakeWorker,
  type: K,
  reply: WorkerOutbound,
  extra?: Record<string, unknown>,
): Promise<WorkerQueryPayload[K]> {
  const pending = link.query(type, extra);
  const sent = w.posted.at(-1) as { type: string; id: number };
  assert.equal(sent.type, type);
  deliver(w, { ...reply, id: sent.id } as WorkerOutbound);
  return pending;
}

test("every WorkerOutbound member reaches its handler once", async () => {
  const { link, state, hook, audioCalls, depCalls, logged, frames, driver } = makeLink();
  const w = fakeWorker();
  link.wireWorker(w as unknown as Worker);

  for (const type of OUTBOUND_TYPES) {
    depCalls.length = 0;
    audioCalls.length = 0;
    switch (type) {
      case "paused":
        deliver(w, { type, paused: true });
        assert.equal(hook.paused, true);
        break;
      case "hostRequest": {
        deliver(w, { type, id: 9, op: "getnum", context: {} });
        await new Promise((r) => setTimeout(r, 0));
        const answer = w.posted.find((m) => (m as { type: string }).type === "hostAnswer");
        assert.ok(answer, "hostRequest must post a hostAnswer");
        break;
      }
      case "interactionCancelled":
        deliver(w, { type, id: 1, op: "getnum" });
        assert.ok(depCalls.includes("cancelPrompt"));
        break;
      case "replay": {
        const obs = fakeObservation();
        deliver(w, { type, sessionId: 0, id: null, observation: obs });
        assert.equal(driver.latest, obs);
        assert.equal(state.modal, null);
        break;
      }
      case "error":
        deliver(w, { type, message: "boom" });
        assert.equal(state.phase, "error");
        assert.equal(state.error, "boom");
        break;
      case "frames":
        await roundTrip(link, w, "frames", { type, id: 0, source: "recent", frames: [] });
        break;
      case "engineState": {
        const r = await roundTrip(link, w, "state", {
          type,
          id: 0,
          state: { room: 5 } as never,
        });
        assert.deepEqual(r, { room: 5 });
        break;
      }
      case "objects": {
        const r = await roundTrip(link, w, "objects", {
          type,
          id: 0,
          objects: [{ num: 3 }] as never,
        });
        assert.deepEqual(r, [{ num: 3 }]);
        break;
      }
      case "debugWritten":
        await roundTrip(link, w, "debugWrite", { type, id: 0 });
        break;
      case "debugEvents": {
        const r = await roundTrip(link, w, "debugEvents", {
          type,
          id: 0,
          cycle: 1,
          latestSeq: 2,
          events: [],
        });
        assert.equal((r as { latestSeq: number }).latestSeq, 2);
        break;
      }
      case "debugTrace": {
        const r = await roundTrip(link, w, "debugTrace", {
          type,
          id: 0,
          cycle: 1,
          latestSeq: 2,
          records: [],
        });
        assert.equal((r as { cycle: number }).cycle, 1);
        break;
      }
      case "checkpoint": {
        // A checkpoint reply must settle the query — before the exhaustive
        // map this member had no handler and the promise hung to timeout.
        const image = new Uint8Array([1, 2, 3]);
        const r = await roundTrip(link, w, "checkpoint", { type, id: 0, image });
        assert.equal(r, image);
        break;
      }
      case "recordingStarted": {
        const r = await roundTrip(link, w, "startRecording", { type, id: 0, ok: true });
        assert.equal((r as { ok: boolean }).ok, true);
        break;
      }
      case "recordingStopped": {
        const r = await roundTrip(link, w, "stopRecording", {
          type,
          id: 0,
          operations: [],
          events: [],
          printed: [],
          tainted: null,
          usedGetnum: false,
          cycle: 0,
          state: null,
        });
        assert.ok(r);
        break;
      }
      case "exportFiles": {
        const r = await roundTrip(link, w, "exportFiles", { type, id: 0, files: null });
        assert.equal(r, null);
        break;
      }
      case "restored":
        deliver(w, { type, ok: true });
        assert.ok(depCalls.includes("restored"));
        break;
      case "booted":
        deliver(w, { type, profile: "2.917" });
        assert.equal(state.phase, "running");
        assert.equal(state.profile, "2.917");
        break;
      case "roomTransition":
        deliver(w, {
          type,
          seq: 1,
          from: null,
          to: 3,
          cause: "boot",
          cycle: 0,
          patchGeneration: 0,
          scoreDelta: 0,
          gained: [],
          lost: [],
        });
        assert.equal(state.roomJournal.length, 1, "the journal collected the observation");
        assert.equal(state.roomJournal[0]!.to, 3);
        break;
      case "flushed":
        deliver(w, {
          type,
          id: 1,
          taken: true,
          cycle: 2,
          hasEngine: true,
          modal: false,
          textMode: false,
          pictureShown: true,
        });
        assert.ok(depCalls.includes("flushed"));
        break;
      case "metadataPatched":
        deliver(w, { type });
        break; // deliberate no-op — the assertion is that it is handled.
      case "frame": {
        const visual = new Uint8Array(160 * 168);
        const priority = new Uint8Array(160 * 168);
        const text = new Uint8Array(40 * 25);
        deliver(w, {
          type,
          visual,
          priority,
          text,
          picRow: 1,
          modal: null,
          textMode: false,
          inputEnabled: true,
          inputReady: true,
          holdToMove: false,
          patchGeneration: 0,
          edit: "",
          cycle: 11,
        });
        // Transferred buffers are adopted, not copied.
        assert.equal(link.getLatestFrame()?.visual, visual);
        assert.equal(frames.length > 0, true);
        assert.equal(hook.frame > 0, true);
        break;
      }
      case "trace": {
        deliver(w, { type, epoch: 1, batch: 1, dropped: 2, records: [] });
        assert.equal(state.debugTraceDropped, 2);
        assert.ok(
          w.posted.some(
            (m) =>
              (m as { type: string }).type === "traceAck" && (m as { epoch: number }).epoch === 1,
          ),
          "each trace batch is acknowledged",
        );
        break;
      }
      case "print":
        deliver(w, { type, text: "hi" });
        assert.ok(logged.some((l) => l.startsWith("log:print")));
        break;
      case "status":
        deliver(w, { type, text: "Score: 1" });
        assert.equal(state.status, "Score: 1");
        break;
      case "shake":
        deliver(w, { type, count: 1 });
        assert.equal(state.shake, true);
        break;
      case "showObj":
        deliver(w, { type, viewNum: 7 });
        assert.equal(state.showObjView, 7);
        break;
      case "autosave":
        deliver(w, {
          type,
          image: "x",
          menus: [] as never,
          cycle: 1,
          room: 1,
        });
        assert.ok(depCalls.includes("autosave"));
        break;
      case "controls":
        deliver(w, { type, controls: [] });
        assert.deepEqual(state.controls, []);
        break;
      case "inputEdit":
        deliver(w, { type, text: "look" });
        assert.deepEqual(state.gameEdit, { text: "look" });
        break;
      case "cycle":
        deliver(w, { type, cycle: 4, room: 2, egoX: 9, egoY: 10 });
        assert.equal(hook.cycle, 4);
        assert.equal(hook.room, 2);
        break;
      case "waitingForKey":
        deliver(w, { type, waiting: true });
        assert.equal(state.waitingForKey, true);
        break;
      case "soundEnabled":
        deliver(w, { type, enabled: false });
        assert.equal(state.soundMuted, true);
        assert.ok(audioCalls.includes("setMuted"));
        break;
      case "sound":
        deliver(w, { type, soundNum: 3 });
        assert.equal(state.soundPlaying, true);
        break;
      case "soundOutput":
        deliver(w, { type, output: {} as never });
        assert.ok(audioCalls.includes("output"));
        break;
      case "soundPaused":
        deliver(w, { type, paused: true });
        assert.ok(audioCalls.includes("setPaused"));
        break;
      case "stopSound":
        deliver(w, { type });
        assert.equal(state.soundPlaying, false);
        assert.ok(audioCalls.includes("stop"));
        break;
      case "quit":
        deliver(w, { type });
        assert.ok(depCalls.includes("ejectGame"));
        break;
      case "log":
        deliver(w, { type, text: "hello" });
        assert.ok(logged.includes("log:hello"));
        break;
      default:
        assert.fail(`unhandled member ${type satisfies never}`);
    }
  }
});

test("a stale-session replay observation cannot settle a current query", async () => {
  const { link } = makeLink();
  const w = fakeWorker();
  link.wireWorker(w as unknown as Worker);
  const pending = link.query("replayAdvance", { ticks: 1 }, 200);
  const sent = w.posted.at(-1) as { id: number };
  let settled: unknown = "pending";
  void pending.then(
    (v) => (settled = v),
    (e) => (settled = e),
  );
  // Wrong walkthrough session: the onmessage guard drops it before dispatch.
  deliver(w, {
    type: "replay",
    sessionId: 99,
    id: sent.id,
    observation: fakeObservation({ sessionId: 99 }),
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, "pending");
  // The current session's reply does settle it.
  deliver(w, {
    type: "replay",
    sessionId: 7,
    id: sent.id,
    observation: fakeObservation({ sessionId: 7 }),
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(typeof settled === "object" && settled !== null, "current-session reply settles");
});

test("a replaced worker's replies are dropped before dispatch", async () => {
  const { link, state } = makeLink();
  const w1 = fakeWorker();
  link.wireWorker(w1 as unknown as Worker);
  const pending = link.query("objects", {}, 500);
  void pending.catch(() => {});
  const w2 = fakeWorker();
  link.wireWorker(w2 as unknown as Worker);
  deliver(w1, { type: "objects", id: 1, objects: [] });
  await new Promise((r) => setTimeout(r, 20));
  // w1's message never reached its handler; the query stays pending.
  state.debugObjects = [];
  deliver(w2, { type: "objects", id: 1, objects: [{ num: 1 }] as never });
  assert.equal((await pending).length, 1);
});

test("unregistered message shapes drop at ingress", () => {
  const { link } = makeLink();
  const w = fakeWorker();
  link.wireWorker(w as unknown as Worker);
  deliver(w, null as never);
  deliver(w, { type: "notAMessage" } as never);
  deliver(w, 42 as never);
});

test("drainPendingQueries cancels outstanding requests", async () => {
  const { link } = makeLink();
  const w = fakeWorker();
  link.wireWorker(w as unknown as Worker);
  const pending = link.query("objects");
  link.drainPendingQueries();
  await assert.rejects(pending, /aborted/);
});

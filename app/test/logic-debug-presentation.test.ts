import assert from "node:assert/strict";
import { test } from "node:test";
import type { SoundOutput } from "../../src/sound/sound.ts";
import type { WorkerOutbound } from "../src/worker/workerProtocol.ts";
import {
  createDebugPresentation,
  createLateGuard,
  type DebugAudioPort,
  type DebugFrameMessage,
} from "../src/studio/logic/debug/debugPresentation.ts";

/**
 * The debug preview's presentation bridge: frame routing, the privately
 * owned audio lifetime, the worker/debugger pause-owner holds and the
 * late-async guards that keep a replaced or closed preview silent.
 */

function frame(n = 0): DebugFrameMessage {
  return {
    type: "frame",
    visual: new Uint8Array(160 * 168).fill(n),
    priority: new Uint8Array(160 * 168),
    text: new Uint8Array(40 * 25 * 2),
    picRow: 0,
    modal: null,
    textMode: false,
    inputEnabled: true,
    inputReady: true,
    holdToMove: true,
    edit: "",
    cycle: n,
    patchGeneration: 0,
  };
}

const TICK: SoundOutput = { kind: "speaker", divisor: 100 };

function fakeAudio(): DebugAudioPort & {
  outputs: SoundOutput[];
  owners: Set<string>;
  stopped: number;
  closed: boolean;
} {
  const audio = {
    outputs: [] as SoundOutput[],
    owners: new Set<string>(),
    stopped: 0,
    closed: false,
    outputTick(packet: { outputs: readonly SoundOutput[] }) {
      audio.outputs.push(...packet.outputs);
    },
    output(e: SoundOutput) {
      audio.outputs.push(e);
    },
    stop() {
      audio.stopped++;
    },
    setPauseOwner(owner: string, paused: boolean) {
      if (paused) audio.owners.add(owner);
      else audio.owners.delete(owner);
    },
    async close() {
      audio.closed = true;
    },
  };
  return audio;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("frames reach the sink; the text mirror and key wait publish", () => {
  const presented: DebugFrameMessage[] = [];
  const keys: boolean[] = [];
  const edits: string[] = [];
  const bridge = createDebugPresentation({
    present: (f) => presented.push(f),
    onWaitingKey: (w) => keys.push(w),
    onInputEdit: (t) => edits.push(t),
  });
  bridge.handle(frame(1));
  bridge.handle(frame(2));
  assert.equal(presented.length, 2);
  assert.equal(bridge.lastFrame, presented[1]);
  bridge.handle({ type: "waitingForKey", waiting: true } as WorkerOutbound);
  bridge.handle({ type: "inputEdit", text: "look" } as WorkerOutbound);
  assert.equal(bridge.waitingForKey, true);
  assert.equal(bridge.inputEdit, "look");
  assert.deepEqual(keys, [true]);
  bridge.dispose();
});

test("audio is created lazily and owned privately — output, holds, stop, close", async () => {
  const made: ReturnType<typeof fakeAudio>[] = [];
  const bridge = createDebugPresentation({
    present: () => {},
    createAudio: () => {
      const audio = fakeAudio();
      made.push(audio);
      return audio;
    },
  });
  assert.equal(made.length, 0, "no audio before the first sound");
  bridge.handle({ type: "soundOutput", output: TICK } as WorkerOutbound);
  await flush();
  assert.equal(made.length, 1);
  assert.deepEqual(made[0]!.outputs, [TICK]);

  bridge.handle({ type: "soundPaused", paused: true } as WorkerOutbound);
  assert.equal(bridge.audioHeld, true);
  assert.equal(made[0]!.owners.has("worker"), true);

  // The debugger hold releases only for the epoch that raised it.
  bridge.handle({ type: "debugAudio", epoch: 7, paused: true } as WorkerOutbound);
  bridge.handle({ type: "debugAudio", epoch: 9, paused: false } as WorkerOutbound);
  assert.equal(made[0]!.owners.has("debugger"), true, "a stale release is noise");
  bridge.handle({ type: "debugAudio", epoch: 7, paused: false } as WorkerOutbound);
  assert.equal(made[0]!.owners.has("debugger"), false);
  assert.equal(made[0]!.owners.has("worker"), true, "the worker hold stands");

  bridge.handle({ type: "stopSound" } as WorkerOutbound);
  assert.equal(made[0]!.stopped, 1);

  bridge.dispose();
  await flush();
  assert.equal(made[0]!.closed, true);
});

test("reset silences and clears holds; a new run hears a clean audio state", async () => {
  const made: ReturnType<typeof fakeAudio>[] = [];
  const bridge = createDebugPresentation({
    present: () => {},
    createAudio: () => {
      const audio = fakeAudio();
      made.push(audio);
      return audio;
    },
  });
  bridge.handle({ type: "soundOutput", output: TICK } as WorkerOutbound);
  await flush();
  bridge.handle({ type: "debugAudio", epoch: 3, paused: true } as WorkerOutbound);
  bridge.handle({ type: "soundPaused", paused: true } as WorkerOutbound);
  assert.equal(bridge.audioHeld, true);
  bridge.reset();
  assert.equal(made[0]!.stopped >= 1, true);
  assert.equal(bridge.audioHeld, false, "holds do not leak into the next run");
  assert.equal(bridge.lastFrame, null);
  // Sound output resumes on the same instance — the run owns it, not the run identity.
  bridge.handle({ type: "soundOutput", output: TICK } as WorkerOutbound);
  await flush();
  assert.equal(made.length, 1);
  assert.equal(made[0]!.outputs.length, 2);
  bridge.dispose();
});

test("audio created late resolves closed — never audible after dispose", async () => {
  let settle: (audio: DebugAudioPort) => void = () => {};
  const created = new Promise<DebugAudioPort>((resolve) => (settle = resolve));
  const made: ReturnType<typeof fakeAudio>[] = [];
  const bridge = createDebugPresentation({
    present: () => {},
    createAudio: () => {
      const audio = fakeAudio();
      made.push(audio);
      return created;
    },
  });
  bridge.handle({ type: "soundOutput", output: TICK } as WorkerOutbound);
  bridge.dispose();
  settle(made[0]!);
  await flush();
  assert.equal(made[0]!.closed, true, "the late instance closed instead of attaching");
  assert.equal(made[0]!.outputs.length, 0, "no output reached the dead run's audio");
  assert.equal(bridge.audio, null);
});

test("the late guard disposes a resource resolved after close", async () => {
  const disposed: string[] = [];
  const guard = createLateGuard();
  let settle: (v: string | null) => void = () => {};
  const pending = new Promise<string | null>((resolve) => (settle = resolve));
  const adopted = guard.adopt(pending, (v) => disposed.push(v));
  guard.close();
  settle("stage");
  assert.equal(await adopted, null);
  assert.deepEqual(disposed, ["stage"]);

  const alive = createLateGuard();
  const kept = await alive.adopt(Promise.resolve("stage2"), (v) => disposed.push(v));
  assert.equal(kept, "stage2");
  assert.deepEqual(disposed, ["stage"]);
});

test("dispose drops frames, mirrors and future output", async () => {
  const presented: DebugFrameMessage[] = [];
  const made: ReturnType<typeof fakeAudio>[] = [];
  const bridge = createDebugPresentation({
    present: (f) => presented.push(f),
    createAudio: () => {
      const audio = fakeAudio();
      made.push(audio);
      return audio;
    },
  });
  bridge.handle(frame(1));
  bridge.handle({ type: "soundOutput", output: TICK } as WorkerOutbound);
  await flush();
  bridge.dispose();
  bridge.handle(frame(2));
  bridge.handle({ type: "soundOutput", output: TICK } as WorkerOutbound);
  assert.equal(presented.length, 1);
  assert.equal(bridge.lastFrame, null);
  assert.equal(made.length, 1, "no second audio for a dead preview");
  assert.equal(made[0]!.outputs.length, 1);
});

test("lazy debugger audio preserves every queued heartbeat", async () => {
  const audio = fakeAudio();
  let resolve!: (audio: DebugAudioPort) => void;
  const pending = new Promise<DebugAudioPort>((done) => {
    resolve = done;
  });
  const bridge = createDebugPresentation({ present() {}, createAudio: () => pending });
  for (const tick of [0, 1, 2])
    bridge.handle({
      type: "soundTick",
      stream: "preview",
      tick,
      outputs: [{ kind: "speaker", divisor: 100 + tick }],
      complete: tick === 2,
    });
  resolve(audio);
  await flush();
  assert.deepEqual(
    audio.outputs,
    [100, 101, 102].map((divisor) => ({ kind: "speaker", divisor })),
  );
  bridge.dispose();
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgiAudio } from "../src/audio/AgiAudio.ts";
import {
  AUDITION_TICK_HZ,
  SoundAudition,
  type AuditionLease,
  type AuditionLeaseAcquire,
  type AuditionSnapshot,
  type AuditionTarget,
} from "../src/audio/soundAudition.ts";
import { PSG_BASE_FREQ, SoundPlayback } from "../../src/sound/sound.ts";
import { PROFILES } from "../../src/runtime/profile.ts";

const TICK_MS = 1000 / AUDITION_TICK_HZ;

// ---- deterministic doubles ----

interface FakeParam {
  value: number;
  writes: [number, number][];
  setValueAtTime(value: number, at: number): void;
  linearRampToValueAtTime(value: number, at: number): void;
}

interface FakeNode {
  stopped: boolean;
  disconnected: boolean;
  connect(): void;
  disconnect(): void;
  start(): void;
  stop(): void;
}

function fakeAudioContext() {
  const calls: string[] = [];
  interface Pending {
    kind: "suspend" | "resume";
    accept(): void;
    refuse(error: Error): void;
  }
  const pending: Pending[] = [];
  const stateListeners: (() => void)[] = [];
  const removedListeners: (() => void)[] = [];
  const params = (): FakeParam => ({
    value: 0,
    writes: [],
    setValueAtTime(value: number, at: number) {
      this.value = value;
      this.writes.push([value, at]);
    },
    linearRampToValueAtTime(value: number, at: number) {
      this.value = value;
      this.writes.push([value, at]);
    },
  });
  const node = (): FakeNode => ({
    stopped: false,
    disconnected: false,
    connect() {},
    disconnect() {
      this.disconnected = true;
    },
    start() {},
    stop() {
      this.stopped = true;
    },
  });
  type Gain = FakeNode & { gain: FakeParam };
  const gains: Gain[] = [];
  type Osc = FakeNode & { frequency: FakeParam; type: string };
  const oscillators: Osc[] = [];
  type Filter = FakeNode & { frequency: FakeParam; type: string; Q: FakeParam };
  const filters: Filter[] = [];
  type Source = FakeNode & { buffer: unknown; loop: boolean; playbackRate: FakeParam };
  const sources: Source[] = [];
  const ctx = {
    state: "running",
    currentTime: 0.25,
    sampleRate: 48000,
    destination: {},
    addEventListener(_type: string, listener: () => void) {
      stateListeners.push(listener);
    },
    removeEventListener(_type: string, listener: () => void) {
      removedListeners.push(listener);
    },
    suspend(): Promise<void> {
      calls.push("suspend");
      return new Promise<void>((resolve, reject) => {
        pending.push({
          kind: "suspend",
          accept: () => {
            ctx.state = "suspended";
            resolve();
          },
          refuse: reject,
        });
      });
    },
    resume(): Promise<void> {
      calls.push("resume");
      return new Promise<void>((resolve, reject) => {
        pending.push({
          kind: "resume",
          accept: () => {
            ctx.state = "running";
            resolve();
          },
          refuse: reject,
        });
      });
    },
    close(): Promise<void> {
      calls.push("close");
      ctx.state = "closed";
      return Promise.resolve();
    },
    createGain: (): Gain => {
      const gain = { ...node(), gain: params() };
      gains.push(gain);
      return gain;
    },
    createOscillator: (): Osc => {
      const osc = { ...node(), frequency: params(), type: "square" };
      oscillators.push(osc);
      return osc;
    },
    createBuffer: (_channels: number, length: number, _rate: number) => {
      const data = new Float32Array(length);
      return { data, length, getChannelData: () => data };
    },
    createBufferSource: (): Source => {
      const source = { ...node(), buffer: null, loop: false, playbackRate: params() };
      sources.push(source);
      return source;
    },
    createChannelMerger: () => node(),
    createIIRFilter: () => node(),
    createBiquadFilter: (): Filter => {
      const filter = { ...node(), frequency: params(), type: "bandpass", Q: params() };
      filters.push(filter);
      return filter;
    },
  };
  return {
    ctx,
    calls,
    pending,
    stateListeners,
    removedListeners,
    gains,
    oscillators,
    filters,
    sources,
    /** Complete the oldest pending suspend/resume. */
    settle(): void {
      const next = pending.shift();
      assert.ok(next, "no context transition is pending");
      next.accept();
    },
    /** Reject the oldest pending transition. */
    fail(error = new Error("context closed")): void {
      const next = pending.shift();
      assert.ok(next, "no context transition is pending");
      next.refuse(error);
    },
    audio: new AgiAudio({ contextFactory: () => ctx as unknown as AudioContext }),
  };
}

function fakeScheduler() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  const earliest = (limit: number) => {
    let best: { id: number; at: number; cb: () => void } | null = null;
    for (const [id, timer] of timers)
      if (timer.at <= limit && (best === null || timer.at < best.at))
        best = { id, at: timer.at, cb: timer.cb };
    return best;
  };
  const scheduler = {
    now: () => now,
    setTimeout: (cb: () => void, ms: number): number => {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), cb });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    pending: (): number => timers.size,
    /** Run the earliest timer due by `limit` (default: anything due). */
    step(limit = Number.MAX_SAFE_INTEGER): boolean {
      const next = earliest(limit);
      if (!next) return false;
      timers.delete(next.id);
      now = Math.max(now, next.at);
      next.cb();
      return true;
    },
    /** Advance the clock, running every timer due within it. */
    advance(ms: number): void {
      const end = now + ms;
      while (scheduler.step(end)) {
        /* timers ran at their own times */
      }
      now = end;
    },
    /** Move the clock without running timers — a scheduling stall. */
    warp(ms: number): void {
      now += ms;
    },
  };
  return scheduler;
}

function grantedLease(log: { calls: number; released: number[] }): AuditionLeaseAcquire {
  return async (request) => {
    log.calls++;
    return {
      release: () => {
        log.released.push(request.epoch);
      },
    };
  };
}

function auditionWith(overrides?: { acquire?: AuditionLeaseAcquire; audio?: AgiAudio }) {
  const scheduler = fakeScheduler();
  const context = fakeAudioContext();
  const leaseLog = { calls: 0, released: [] as number[] };
  const audio = overrides?.audio ?? context.audio;
  const audition = new SoundAudition({
    audio,
    acquire: overrides?.acquire ?? grantedLease(leaseLog),
    scheduler,
  });
  return { scheduler, context, audition, leaseLog, audio };
}

// ---- hand-encoded SOUND resources ----

function toneRecord(channel: number, ticks: number, divisor: number, att: number): number[] {
  const duration = ticks === 65536 ? 0 : ticks;
  return [
    duration & 255,
    duration >> 8,
    (divisor >> 4) & 0x3f,
    0x80 | (channel << 5) | (divisor & 0xf),
    0x90 | (channel << 5) | att,
  ];
}

function noiseRecord(ticks: number, control: number, att: number): number[] {
  const duration = ticks === 65536 ? 0 : ticks;
  return [duration & 255, duration >> 8, control, 0xe0 | control, 0xf0 | att];
}

function restRecord(channel: number, ticks: number): number[] {
  const duration = ticks === 65536 ? 0 : ticks;
  return [duration & 255, duration >> 8, 0, 0x80 | (channel << 5), 0x90 | (channel << 5) | 15];
}

function soundPayload(lanes: number[][][]): Uint8Array {
  const bytes: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let channel = 0; channel < 4; channel++) {
    bytes[channel * 2] = bytes.length & 255;
    bytes[channel * 2 + 1] = bytes.length >> 8;
    for (const record of lanes[channel]!) bytes.push(...record);
    bytes.push(0xff, 0xff);
  }
  return new Uint8Array(bytes);
}

function target(payload: Uint8Array, overrides?: Partial<AuditionTarget>): AuditionTarget {
  return {
    projectId: "proj-1",
    documentId: "sound:7",
    revision: 3,
    payload,
    profileId: "2.936",
    device: 1,
    ...overrides,
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Pump a fake scheduler through reconstruction yields: each timer fire
 * resolves a yield, whose continuation schedules the next one on a
 * microtask — so each step needs a microtask drain before the next timer
 * exists. Returns the number of timer steps taken.
 */
async function pump(scheduler: ReturnType<typeof fakeScheduler>, limit = 1000): Promise<number> {
  let steps = 0;
  for (;;) {
    if (scheduler.pending() === 0) {
      await Promise.resolve();
      if (scheduler.pending() === 0) return steps;
    }
    scheduler.step();
    steps++;
    await Promise.resolve();
    if (steps >= limit) return steps;
  }
}

describe("AgiAudio lane audibility", () => {
  it("gates the rendered gain only and restores the last programmed volume", () => {
    const { audio, gains } = fakeAudioContext();
    audio.output({ kind: "psg", bytes: [0x82, 0x0e, 0x94] });
    assert.equal(gains[1]!.gain.value, Math.pow(10, -4 / 10) * 0.25);
    audio.setLaneAudible(0, false);
    assert.equal(gains[1]!.gain.value, 0);
    // A later attenuation event still programs the lane while gated.
    audio.output({ kind: "psg", bytes: [0x98] });
    assert.equal(gains[1]!.gain.value, 0);
    audio.setLaneAudible(0, true);
    assert.equal(
      gains[1]!.gain.value,
      Math.pow(10, -8 / 10) * 0.25,
      "the most recent programmed value returns, not a stale one",
    );
  });

  it("keeps the tone-2 divisor feeding noise rate 3 while lane 2 is gated", () => {
    const { audio, gains, filters } = fakeAudioContext();
    audio.setLaneAudible(2, false);
    // Channel 2 latch+data: divisor 100; noise control white/rate 3, att 4.
    audio.output({ kind: "psg", bytes: [0xc4, 0x06] });
    audio.output({ kind: "psg", bytes: [0xe7, 0xf4] });
    assert.equal(filters[0]!.frequency.value, PSG_BASE_FREQ / 100);
    assert.equal(gains[4]!.gain.value, Math.pow(10, -4 / 10) * 0.25);
    audio.setLaneAudible(3, false);
    assert.equal(gains[4]!.gain.value, 0);
    audio.setLaneAudible(3, true);
    assert.equal(gains[4]!.gain.value, Math.pow(10, -4 / 10) * 0.25);
  });

  it("lets every lane finish while all are gated", () => {
    const { audio, gains, oscillators } = fakeAudioContext();
    for (let lane = 0; lane < 4; lane++) audio.setLaneAudible(lane, false);
    audio.output({ kind: "psg", bytes: [0x82, 0x0e, 0x90] });
    assert.equal(oscillators[0]!.frequency.value, PSG_BASE_FREQ / 226);
    assert.equal(gains[1]!.gain.value, 0);
    audio.output({ kind: "psg", bytes: [0x9f, 0xbf, 0xdf, 0xff] });
    assert.ok(gains.slice(1).every((gain) => gain.gain.value === 0));
  });

  it("disposes only its own context: nodes, listener, close, no resurrection", async () => {
    const { audio, ctx, calls, pending, stateListeners, removedListeners, oscillators, gains } =
      fakeAudioContext();
    audio.output({ kind: "psg", bytes: [0x82, 0x0e, 0x94] });
    audio.setPaused(true);
    assert.equal(pending.length, 1, "a suspend is in flight");
    const created = gains.length;
    await audio.close();
    assert.equal(audio.closed, true);
    assert.equal(audio.isPlaying, false);
    assert.ok(oscillators.every((osc) => osc.stopped));
    assert.ok(gains.every((gain) => gain.disconnected));
    assert.deepEqual(removedListeners, stateListeners);
    assert.deepEqual(calls, ["suspend", "close"]);
    // The still-pending suspend rejection cannot resurrect or leak.
    pending[0]!.refuse(new Error("context closed"));
    await flush();
    audio.output({ kind: "psg", bytes: [0x90] });
    assert.equal(gains.length, created, "no new nodes after disposal");
    await audio.close();
    assert.equal(calls.filter((call) => call === "close").length, 1);
    assert.equal(ctx.state, "closed");
  });
});

describe("sound audition transport", () => {
  it("keeps an immutable target identity and never reads caller bytes", async () => {
    const payload = soundPayload([[toneRecord(0, 30, 226, 4)], [], [], []]);
    const { audition, scheduler, context } = auditionWith();
    const offered = target(payload);
    audition.setTarget(offered);
    const identity = audition.snapshot().target!;
    assert.equal(identity.documentId, "sound:7");
    assert.equal(identity.revision, 3);
    assert.equal(identity.profileId, "2.936");
    assert.equal(identity.device, 1);
    assert.match(identity.payloadHash, /^[0-9a-f]{16}$/);
    // Caller mutation after setTarget cannot reach the kept copy: these
    // bytes would change the decoded divisor to 1023 if they were read.
    offered.payload[10] = 0x3f;
    offered.payload[11] = 0x8f;
    await audition.play();
    scheduler.advance(40);
    assert.equal(
      context.oscillators[0]!.frequency.value,
      PSG_BASE_FREQ / 226,
      "the copied payload, not the mutated caller bytes",
    );
    assert.equal(audition.snapshot().target!.payloadHash, identity.payloadHash);
  });

  it("produces profile-different output sequences through real SoundPlayback", async () => {
    const payload = soundPayload([[toneRecord(0, 30, 226, 4)], [], [], []]);
    const runs: { profileId: "2.936" | "2.411"; values: number[] }[] = [];
    for (const profileId of ["2.936", "2.411"] as const) {
      const { audition, scheduler, context } = auditionWith();
      audition.setTarget(target(payload, { profileId }));
      await audition.play();
      scheduler.advance(TICK_MS * 4);
      runs.push({ profileId, values: context.gains[1]!.gain.writes.map(([value]) => value) });
    }
    // The 2.936 common driver applies the decay envelope every tick
    // (-2, -3, … on the note's base attenuation 4); early-2.411 writes the
    // control byte once at note start. (The leading write is the channel's
    // initial silence, programmed at creation.)
    const early = runs[1]!.values.slice(1);
    assert.deepEqual(early, [Math.pow(10, -4 / 10) * 0.25]);
    const common = runs[0]!.values.slice(1);
    assert.ok(common.length >= 4, `expected per-tick envelope writes, got ${common.length}`);
    assert.equal(common[0], Math.pow(10, -2 / 10) * 0.25); // base 4 + delta -2
    assert.equal(common[1], Math.pow(10, -1 / 10) * 0.25); // base 4 + delta -3
    assert.notEqual(common[common.length - 1], early[0]);
  });

  it("preserves a half-tick carry on pause and owes no backlog after a long hold", async () => {
    const payload = soundPayload([[toneRecord(0, 600, 226, 4)], [], [], []]);
    const { audition, scheduler } = auditionWith();
    audition.setTarget(target(payload));
    await audition.play();
    scheduler.advance(TICK_MS); // tick 1 ran; next due in one period
    scheduler.advance(TICK_MS / 2); // half a tick of wall time
    audition.pause();
    assert.equal(audition.snapshot().status, "paused");
    scheduler.warp(60_000); // an hour of sound ticks of wall stall
    assert.equal(audition.snapshot().positionTicks, 1);
    await audition.resume();
    // The preserved ~half-tick carry lands the next tick, nothing banks up.
    scheduler.advance(TICK_MS / 2 - 2);
    assert.equal(audition.snapshot().positionTicks, 1, "the next tick is not early");
    scheduler.advance(3);
    assert.equal(audition.snapshot().positionTicks, 2, "no catch-up burst");
    scheduler.advance(TICK_MS * 3);
    assert.equal(audition.snapshot().positionTicks, 5);
  });

  it("completes at the playback extent, reported beside the authored extent", async () => {
    const payload = soundPayload([[toneRecord(0, 3, 226, 4), restRecord(0, 2)], [], [], []]);
    const { audition, scheduler, leaseLog, context } = auditionWith();
    audition.setTarget(target(payload));
    const snap = audition.snapshot();
    assert.equal(snap.authoredExtentTicks, 5);
    assert.equal(snap.playbackExtentTicks, 5);
    await audition.play();
    scheduler.advance(TICK_MS * 10);
    const done = audition.snapshot();
    assert.equal(done.status, "complete");
    assert.equal(done.positionTicks, 5, "the terminator tick is not phantom progress");
    assert.equal(done.leaseHeld, false);
    assert.deepEqual(leaseLog.released.length, 1);
    assert.ok(context.gains.slice(1).every((gain) => gain.gain.value === 0));
  });

  it("completes an empty resource with no tick advancement and no lease", async () => {
    const payload = soundPayload([[], [], [], []]);
    const { audition, scheduler, leaseLog, context } = auditionWith();
    audition.setTarget(target(payload));
    assert.equal(audition.snapshot().playbackExtentTicks, 0);
    const snap = await audition.play();
    assert.equal(snap.status, "complete");
    assert.equal(snap.positionTicks, 0);
    assert.equal(leaseLog.calls, 0, "an empty run never needs the hold");
    assert.equal(context.gains.length, 0, "no audio context was ever needed");
    scheduler.advance(200);
    assert.equal(audition.snapshot().positionTicks, 0);
  });

  it("releases its own lease exactly once per run and never a newer token", async () => {
    const payload = soundPayload([[toneRecord(0, 600, 226, 4)], [], [], []]);
    const { audition, scheduler, leaseLog } = auditionWith();
    audition.setTarget(target(payload));
    const first = await audition.play();
    scheduler.advance(TICK_MS * 2);
    audition.stop();
    assert.deepEqual(leaseLog.released, [first.epoch]);
    const second = await audition.play();
    scheduler.advance(TICK_MS);
    audition.stop();
    assert.deepEqual(leaseLog.released, [first.epoch, second.epoch]);
    await audition.close();
    assert.deepEqual(leaseLog.released, [first.epoch, second.epoch], "nothing double-released");
  });

  it("releases only its own late token when a deferred acquire lands after retarget", async () => {
    let grant: ((lease: AuditionLease) => void) | null = null;
    const released: string[] = [];
    const acquire: AuditionLeaseAcquire = () =>
      new Promise<AuditionLease>((resolve) => {
        grant = resolve;
      });
    const { audition } = auditionWith({ acquire });
    audition.setTarget(target(soundPayload([[toneRecord(0, 60, 226, 4)], [], [], []])));
    const playing = audition.play();
    audition.setTarget(target(soundPayload([[toneRecord(0, 5, 300, 2)], [], [], []])));
    grant!({
      release: () => {
        released.push("stale-token");
      },
    });
    await playing;
    await flush();
    assert.deepEqual(released, ["stale-token"]);
    assert.equal(audition.snapshot().status, "idle");
    assert.equal(audition.snapshot().leaseHeld, false);
  });

  it("refuses a host lease error without losing target or manual state", async () => {
    let attempts = 0;
    const acquire: AuditionLeaseAcquire = async () => {
      attempts++;
      if (attempts === 1) throw new Error("the workspace holds the transport");
      return { release: () => {} };
    };
    const { audition, scheduler } = auditionWith({ acquire });
    audition.setTarget(target(soundPayload([[toneRecord(0, 60, 226, 4)], [], [], []])));
    audition.setLaneMuted(1, true);
    const snap = await audition.play();
    assert.equal(snap.status, "refused");
    assert.equal(snap.refusal, "lease-refused");
    assert.equal(snap.target!.documentId, "sound:7");
    assert.deepEqual(snap.laneMuted, [false, true, false, false]);
    // A retry under a working host plays normally.
    const retry = await audition.play();
    assert.equal(retry.status, "playing");
    scheduler.advance(TICK_MS * 2);
    assert.equal(audition.snapshot().positionTicks, 2);
  });

  it("mutes and solos real four-stream lanes; names unsupported families", async () => {
    const payload = soundPayload([
      [toneRecord(0, 60, 226, 4)],
      [toneRecord(1, 60, 300, 2)],
      [toneRecord(2, 60, 150, 6)],
      [noiseRecord(60, 7, 4)],
    ]);
    const { audition, scheduler, context } = auditionWith();
    audition.setTarget(target(payload));
    assert.equal(audition.snapshot().laneControls, "four");
    await audition.play();
    scheduler.advance(TICK_MS * 2);
    const laneGains = context.gains.slice(1);
    audition.setLaneMuted(0, true);
    assert.equal(laneGains[0]!.gain.value, 0);
    assert.notEqual(laneGains[1]!.gain.value, 0);
    audition.setLaneSolo(2);
    assert.equal(laneGains[0]!.gain.value, 0);
    assert.equal(laneGains[1]!.gain.value, 0);
    assert.notEqual(laneGains[2]!.gain.value, 0);
    assert.equal(laneGains[3]!.gain.value, 0);
    audition.setLaneSolo(null);
    audition.setLaneMuted(0, false);
    assert.notEqual(laneGains[0]!.gain.value, 0);
    assert.throws(() => audition.setLaneMuted(4, true), RangeError);
  });

  it("reports unsupported lane controls for opaque families without faking lanes", async () => {
    // PC booter register rows: one tick of silence-ish bytes, one terminator row.
    const { audition } = auditionWith();
    audition.setTarget(target(new Uint8Array([0x9f, 0x00, 0xbf, 0x00]), { profileId: "2.001" }));
    assert.equal(audition.snapshot().laneControls, "unsupported");
    audition.setLaneMuted(0, true);
    audition.setLaneSolo(0);
    assert.ok(
      audition.snapshot().warnings.some((warning) => warning.includes("unsupported")),
      "the refusal is named, not silent",
    );
    // Whole-resource audition still plays.
    const snap = await audition.play();
    assert.equal(snap.status, "playing");
  });

  it("keeps every lane advancing to completion while all are silent", async () => {
    const payload = soundPayload([[toneRecord(0, 4, 226, 4)], [toneRecord(1, 4, 300, 2)], [], []]);
    const { audition, scheduler, context } = auditionWith();
    audition.setTarget(target(payload));
    for (let lane = 0; lane < 4; lane++) audition.setLaneMuted(lane, true);
    await audition.play();
    scheduler.advance(TICK_MS * 8);
    const snap = audition.snapshot();
    assert.equal(snap.status, "complete");
    assert.equal(snap.positionTicks, 4);
    // The event stream still programmed each lane's attenuation register.
    assert.ok(context.gains[1]!.gain.writes.length > 0);
    assert.ok(context.gains.slice(1).every((gain) => gain.gain.value === 0));
  });

  it("stops old notes and never plays stale output on target change", async () => {
    const payload = soundPayload([[toneRecord(0, 60, 226, 4)], [], [], []]);
    const { audition, scheduler, context } = auditionWith();
    audition.setTarget(target(payload));
    await audition.play();
    scheduler.advance(TICK_MS * 3);
    audition.setTarget(target(soundPayload([[toneRecord(0, 5, 300, 2)], [], [], []])));
    assert.equal(audition.snapshot().status, "idle");
    assert.equal(audition.snapshot().positionTicks, 0);
    const written = context.gains[1]!.gain.writes.length;
    assert.equal(context.gains[1]!.gain.value, 0, "the old run's notes were silenced");
    scheduler.advance(500);
    assert.equal(context.gains[1]!.gain.writes.length, written, "no stale notes leak");
  });
});

describe("sound audition seek", () => {
  it("reconstructs mid-note state silently: envelope, tone2/noise3, held volume", async () => {
    const payload = soundPayload([
      [toneRecord(0, 40, 226, 6)],
      [],
      [toneRecord(2, 60, 300, 4)],
      [noiseRecord(60, 7, 4)],
    ]);
    // Reference run: the same cue played continuously.
    const ref = auditionWith();
    ref.audition.setTarget(target(payload));
    await ref.audition.play();
    ref.scheduler.advance(TICK_MS * 9);
    const refGain = ref.context.gains[1]!.gain.value;

    const { audition, scheduler, context } = auditionWith();
    audition.setTarget(target(payload));
    const sought = await audition.seek(9);
    assert.equal(sought.status, "paused");
    assert.equal(sought.positionTicks, 9);
    // The reconstructing lane-gate kept every write at 0 until the last one,
    // which restores the programmed attenuation at tick 9 — identical to the
    // reference run's held volume there.
    const writes = context.gains[1]!.gain.writes;
    assert.equal(writes.at(-1)![0], refGain);
    assert.ok(
      writes.slice(0, -1).every(([value]) => value === 0),
      "reconstruction was silent",
    );
    // Lane 2's divisor reached the noise rate-3 computation.
    assert.equal(context.filters[0]!.frequency.value, PSG_BASE_FREQ / 300);
    // Resuming continues the profile envelope, not a restarted note.
    await audition.resume();
    scheduler.advance(TICK_MS);
    ref.scheduler.advance(TICK_MS);
    assert.equal(
      context.gains[1]!.gain.value,
      ref.context.gains[1]!.gain.value,
      "the seeked run's tick-10 gain equals the continuous run's",
    );
  });

  it("reconstructs Amiga voices silently: period and per-tick volume envelope", async () => {
    const payload = soundPayload([[toneRecord(0, 30, 226, 4)], [], [], []]);
    const { audition, context } = auditionWith();
    audition.setTarget(target(payload, { profileId: "amiga-2.176" }));
    const sought = await audition.seek(3);
    assert.equal(sought.status, "paused");
    assert.equal(sought.positionTicks, 3);
    // AUDxPER is the note's divisor times four.
    assert.equal(context.sources[0]!.playbackRate.value, ((3546895 / (4 * 226)) * 32) / 48000);
    // The 2.176 attack envelope (-2, -3, -2, …) leaves attenuation 2 at
    // tick 3: AUDxVOL ((15 - 2) << 6) / 15 = 55, rendered (55 / 64) * 0.4.
    assert.equal(context.gains[1]!.gain.value, (55 / 64) * 0.4);
    assert.ok(
      context.gains[1]!.gain.writes.slice(0, -1).every(([value]) => value === 0),
      "the voice was reconstructed without audible output",
    );
  });

  it("seeks forward from the current position without resetting", async () => {
    const payload = soundPayload([[toneRecord(0, 120, 226, 4)], [], [], []]);
    const { audition, scheduler, context } = auditionWith();
    audition.setTarget(target(payload));
    await audition.play();
    scheduler.advance(TICK_MS * 5);
    const before = context.gains[1]!.gain.writes.length;
    const snap = await audition.seek(40);
    assert.equal(snap.status, "playing", "a playing run keeps playing after seek");
    assert.equal(snap.positionTicks, 40);
    // Forward reconstruction reuses the consistent pair; the gate writes
    // bracket the silently replayed ticks.
    assert.ok(context.gains[1]!.gain.writes.length > before);
    scheduler.advance(TICK_MS * 10);
    assert.equal(audition.snapshot().positionTicks, 50);
  });

  it("cancels a stale seek across a retarget without corrupting the new run", async () => {
    const longPayload = soundPayload([[toneRecord(0, 65536, 226, 4)], [], [], []]);
    const { audition, scheduler } = auditionWith();
    audition.setTarget(target(longPayload));
    const pending = audition.seek(60000); // chunked: ~30 reconstruction yields
    scheduler.step();
    await Promise.resolve(); // one more chunk ran, then suspended on a yield
    audition.setTarget(
      target(soundPayload([[toneRecord(0, 5, 300, 2)], [], [], []]), { revision: 4 }),
    );
    scheduler.step(); // resolves the stale yield so the abort can land
    const stale = await pending;
    assert.equal(stale.target!.revision, 4);
    assert.equal(audition.snapshot().status, "idle");
    // Whatever the stale seek leaves behind cannot schedule output.
    scheduler.advance(300);
    assert.equal(audition.snapshot().positionTicks, 0);
  });

  it("bounds a long seek into cancellable chunks with no duration allocation", async () => {
    const longPayload = soundPayload([[toneRecord(0, 65536, 226, 4)], [], [], []]);
    const { audition, scheduler } = auditionWith();
    audition.setTarget(target(longPayload));
    const pending = audition.seek(60000);
    const boundaries = await pump(scheduler);
    const snap = await pending;
    assert.ok(boundaries >= 20, `reconstruction yielded (${boundaries} chunks)`);
    assert.equal(snap.positionTicks, 60000);
    assert.equal(snap.status, "paused");
  });

  it("names the IIgs seek refusal and its missing renderer seam", async () => {
    // A minimal IIgs stream: type-2 word, then the 0xfc terminator.
    const { audition } = auditionWith();
    audition.setTarget(
      target(new Uint8Array([0x02, 0x00, 0x01, 0x9c, 0x45, 0x40, 0x00, 0xfc]), {
        profileId: "iigs-1.014",
      }),
    );
    const snap = await audition.seek(1);
    assert.equal(snap.status, "refused");
    assert.equal(snap.refusal, "seek-unsupported-family");
    assert.ok(
      snap.warnings.some((warning) => warning.includes("IigsSynth")),
      "the refusal names the missing dependency",
    );
  });

  it("validates explicit finite nonnegative safe-integer ticks", async () => {
    const { audition } = auditionWith();
    audition.setTarget(target(soundPayload([[toneRecord(0, 60, 226, 4)], [], [], []])));
    await assert.rejects(() => audition.seek(-1), RangeError);
    await assert.rejects(() => audition.seek(1.5), RangeError);
    await assert.rejects(() => audition.seek(Number.NaN), RangeError);
    assert.equal(audition.snapshot().status, "idle");
  });
});

describe("sound audition scheduling honesty", () => {
  it("rebases a scheduling stall silently instead of bursting overdue output", async () => {
    const payload = soundPayload([[toneRecord(0, 900, 226, 4)], [], [], []]);
    const { audition, scheduler, context } = auditionWith();
    audition.setTarget(target(payload));
    await audition.play();
    scheduler.warp(3000); // ~180 ticks of stall
    scheduler.step(); // the overdue wake starts the rebase
    await flush(); // one reconstruction chunk finishes without a yield
    const snap = audition.snapshot();
    assert.equal(snap.status, "playing");
    assert.ok(snap.underrunTicks >= 179, `underrun reported (${snap.underrunTicks})`);
    assert.ok(
      snap.warnings.some((warning) => warning.includes("underrun")),
      "the rebase is reported, not passed off as accurate",
    );
    // After rebase the run continues live from the resynced position.
    const at = snap.positionTicks;
    scheduler.advance(TICK_MS * 3);
    assert.ok(audition.snapshot().positionTicks > at);
    assert.ok(context.gains[1]!.gain.writes.length > 0);
  });

  it("reports a smaller stall as late ticks without a rebase", async () => {
    const payload = soundPayload([[toneRecord(0, 900, 226, 4)], [], [], []]);
    const { audition, scheduler } = auditionWith();
    audition.setTarget(target(payload));
    await audition.play();
    scheduler.warp(TICK_MS * 5); // 4 ticks late, under the rebase bound
    scheduler.step();
    const snap = audition.snapshot();
    assert.equal(snap.status, "playing");
    assert.equal(snap.underrunTicks, 4);
    assert.equal(snap.positionTicks, 5);
  });
});

describe("sound audition lifecycle", () => {
  it("keeps stop/complete/dispose idempotent", async () => {
    const payload = soundPayload([[toneRecord(0, 5, 226, 4)], [], [], []]);
    const { audition, scheduler, context } = auditionWith();
    audition.setTarget(target(payload));
    audition.stop();
    audition.stop();
    assert.equal(audition.snapshot().status, "idle");
    await audition.play();
    scheduler.advance(TICK_MS * 8);
    assert.equal(audition.snapshot().status, "complete");
    audition.stop();
    assert.equal(audition.snapshot().status, "idle");
    await audition.close();
    await audition.close();
    assert.equal(context.calls.filter((call) => call === "close").length, 1);
    const refused = await audition.play();
    assert.equal(refused.status, "refused");
    assert.equal(refused.refusal, "closed");
    assert.equal(audition.snapshot().closed, true);
  });

  it("delivers snapshots to subscribers and stops after unsubscribe", async () => {
    const payload = soundPayload([[toneRecord(0, 30, 226, 4)], [], [], []]);
    const { audition, scheduler } = auditionWith();
    const seen: AuditionSnapshot[] = [];
    const off = audition.subscribe((snapshot) => seen.push(snapshot));
    assert.equal(seen.length, 1, "the current snapshot arrives immediately");
    audition.setTarget(target(payload));
    await audition.play();
    scheduler.advance(TICK_MS * 3);
    assert.ok(seen.some((snapshot) => snapshot.status === "playing"));
    const count = seen.length;
    off();
    scheduler.advance(TICK_MS * 2);
    assert.equal(seen.length, count);
  });

  it("swallows a failing subscriber into warnings and keeps playing", async () => {
    const payload = soundPayload([[toneRecord(0, 30, 226, 4)], [], [], []]);
    const { audition, scheduler } = auditionWith();
    audition.subscribe(() => {
      throw new Error("ui bug");
    });
    audition.setTarget(target(payload));
    await audition.play();
    scheduler.advance(TICK_MS * 3);
    const snap = audition.snapshot();
    assert.equal(snap.status, "playing");
    assert.ok(snap.warnings.some((warning) => warning.includes("subscriber")));
  });

  it("never touches another AgiAudio instance's owners, mute or context", async () => {
    // The "game" instance: a different context with its own pause owner.
    const game = fakeAudioContext();
    game.audio.output({ kind: "speaker", divisor: 2712 });
    game.audio.setPauseOwner("worker", true);
    const { audition, scheduler } = auditionWith({ audio: fakeAudioContext().audio });
    audition.setTarget(target(soundPayload([[toneRecord(0, 60, 226, 4)], [], [], []])));
    await audition.play();
    scheduler.advance(TICK_MS * 3);
    audition.pause();
    scheduler.advance(TICK_MS * 2);
    await audition.resume();
    scheduler.advance(TICK_MS);
    audition.stop();
    await audition.close();
    assert.equal(game.audio.isPaused, true, "the game's worker hold still stands");
    assert.equal(game.audio.isMuted, false);
    assert.deepEqual(game.calls, ["suspend"], "only the game's own suspend ran");
    game.settle();
    await game.audio.close();
    assert.deepEqual(game.calls, ["suspend", "close"]);
  });

  it("rejects malformed targets and operands before any state change", () => {
    const { audition } = auditionWith();
    const payload = soundPayload([[toneRecord(0, 5, 226, 4)], [], [], []]);
    assert.throws(() => audition.setTarget(target(payload, { device: 256 })), RangeError);
    assert.throws(() => audition.setTarget(target(payload, { adjustment: -1 })), RangeError);
    assert.throws(
      () => audition.setTarget(target(payload, { profileId: "9.999" as never })),
      RangeError,
    );
    assert.throws(
      () => audition.setTarget({ ...target(payload), payload: "nope" as unknown as Uint8Array }),
      TypeError,
    );
    assert.equal(audition.snapshot().status, "idle");
  });

  it("hands the host lease a detached identity the recipient cannot rewrite", async () => {
    let seen: AuditionSnapshot["target"] | null = null;
    const acquire: AuditionLeaseAcquire = (request) => {
      seen = request.target;
      request.target.documentId = "foreign-sound";
      request.target.device = 0;
      return { release: () => {} };
    };
    const { audition, scheduler, context } = auditionWith({ acquire });
    audition.setTarget(target(soundPayload([[toneRecord(0, 60, 226, 4)], [], [], []])));
    await audition.play();
    assert.equal(seen!.documentId, "foreign-sound", "the recipient owns its copy");
    const snap = audition.snapshot();
    assert.equal(snap.target!.documentId, "sound:7");
    assert.equal(snap.target!.device, 1);
    // The run still rendered through the real device: psg channels exist,
    // not a speaker-only rebuild a rewritten operand would have caused.
    scheduler.advance(TICK_MS * 2);
    assert.equal(context.gains.length, 5);
  });

  it("gives every observer a detached snapshot of observational state", () => {
    const { audition } = auditionWith();
    const seen: (string | undefined)[] = [];
    audition.subscribe((snapshot) => {
      if (snapshot.target) snapshot.target.documentId = "observer-mutation";
    });
    audition.subscribe((snapshot) => seen.push(snapshot.target?.documentId));
    audition.setTarget(target(soundPayload([[toneRecord(0, 5, 226, 4)], [], [], []])));
    assert.ok(seen.every((id) => id === undefined || id === "sound:7"));
    assert.equal(audition.snapshot().target!.documentId, "sound:7");
  });

  it("stops publishing a stale epoch once a subscriber supersedes it", async () => {
    const { audition, scheduler } = auditionWith();
    const statuses: AuditionSnapshot["status"][] = [];
    let stopped = false;
    audition.subscribe((snapshot) => {
      if (snapshot.status === "playing" && !stopped) {
        stopped = true;
        audition.stop();
      }
    });
    audition.subscribe((snapshot) => statuses.push(snapshot.status));
    audition.setTarget(target(soundPayload([[toneRecord(0, 60, 226, 4)], [], [], []])));
    await audition.play();
    scheduler.advance(TICK_MS * 2);
    // The second observer received the fresh idle publication from the
    // superseding stop() — never the stale playing snapshot that preceded it.
    assert.ok(!statuses.includes("playing"), `saw ${statuses.join(",")}`);
    assert.equal(audition.snapshot().status, "idle");
  });

  it("keeps a replacement run audible when an observer supersedes a seek", async () => {
    const longPayload = soundPayload([[toneRecord(0, 65536, 226, 4)], [], [], []]);
    const { audition, scheduler, context } = auditionWith();
    audition.setTarget(target(longPayload));
    let replaced = false;
    let replacement: Promise<AuditionSnapshot> | undefined;
    audition.subscribe((snapshot) => {
      if (snapshot.status === "seeking" && !replaced) {
        replaced = true;
        audition.setTarget(
          target(soundPayload([[toneRecord(0, 60, 226, 4)], [], [], []]), { revision: 4 }),
        );
        replacement = audition.play();
      }
    });
    await audition.seek(60000);
    assert.ok(replacement);
    const snap = await replacement;
    assert.equal(snap.status, "playing");
    scheduler.advance(TICK_MS * 3);
    assert.equal(audition.snapshot().status, "playing");
    assert.equal(audition.snapshot().target!.revision, 4);
    assert.notEqual(
      context.gains[1]!.gain.value,
      0,
      "the stale reconstruction must not leave the new run gated",
    );
  });

  it("abandons a wake when the audio adapter reenters a lifecycle call", async () => {
    const { audition, scheduler, audio, leaseLog } = auditionWith();
    let stopped = false;
    const original = audio.outputTick.bind(audio);
    audio.outputTick = (packet) => {
      original(packet);
      if (!stopped) {
        stopped = true;
        audition.stop();
      }
    };
    audition.setTarget(target(soundPayload([[toneRecord(0, 60, 226, 4)], [], [], []])));
    await audition.play();
    scheduler.advance(TICK_MS * 5);
    const snap = audition.snapshot();
    assert.equal(snap.status, "idle");
    assert.equal(snap.positionTicks, 0, "the superseded wake counted nothing");
    scheduler.advance(200);
    assert.equal(audition.snapshot().status, "idle", "the dead wake rescheduled nothing");
    assert.equal(leaseLog.released.length, 1);
  });

  it("lands paused when a hold is requested during an underrun rebase", async () => {
    const { audition, scheduler } = auditionWith();
    let held = false;
    audition.subscribe((snapshot) => {
      if (snapshot.status === "seeking" && !held) {
        held = true;
        audition.pause();
      }
    });
    audition.setTarget(target(soundPayload([[toneRecord(0, 900, 226, 4)], [], [], []])));
    await audition.play();
    scheduler.warp(3000);
    scheduler.step();
    await flush();
    assert.equal(audition.snapshot().status, "paused", "the hold survives the rebase");
    await audition.resume();
    scheduler.advance(TICK_MS * 2);
    assert.ok(audition.snapshot().positionTicks >= 179);
  });

  it("lets a lease-release callback supersede the stop that invoked it", async () => {
    let service: SoundAudition | null = null;
    const acquire: AuditionLeaseAcquire = () => ({
      release: () => {
        service!.setTarget(
          target(soundPayload([[toneRecord(0, 10, 300, 2)], [], [], []]), { revision: 9 }),
        );
      },
    });
    const { audition, scheduler } = auditionWith({ acquire });
    service = audition;
    audition.setTarget(target(soundPayload([[toneRecord(0, 60, 226, 4)], [], [], []])));
    await audition.play();
    scheduler.advance(TICK_MS * 2);
    const snap = audition.stop();
    assert.equal(snap.target!.revision, 9, "the host's retarget wins");
    assert.equal(audition.snapshot().status, "idle");
    await audition.play();
    scheduler.advance(TICK_MS * 2);
    assert.equal(audition.snapshot().status, "playing");
  });

  it("applies each tick's outputs in SoundPlayback order, completion included", async () => {
    const payload = soundPayload([
      [toneRecord(0, 3, 226, 4), restRecord(0, 2)],
      [toneRecord(1, 5, 300, 2)],
      [],
      [],
    ]);
    // The authoritative event stream for the same target.
    const direct = new SoundPlayback(PROFILES["2.936"]!, payload, 1);
    const expected: unknown[] = [];
    for (;;) {
      const result = direct.tick(true, 0);
      expected.push(...result.outputs);
      if (result.complete) break;
    }
    const { audition, scheduler, audio } = auditionWith();
    const seen: unknown[] = [];
    const original = audio.outputTick.bind(audio);
    audio.outputTick = (packet) => {
      seen.push(...packet.outputs);
      original(packet);
    };
    audition.setTarget(target(payload));
    await audition.play();
    scheduler.advance(TICK_MS * 12);
    assert.equal(audition.snapshot().status, "complete");
    assert.deepEqual(seen, expected);
  });
});

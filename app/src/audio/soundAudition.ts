/**
 * Local, selected-profile native SOUND audition: a private SoundPlayback
 * driven by an injected monotonic scheduler into a private AgiAudio
 * instance. The interpreter stream stays authoritative for note timing,
 * envelopes and completion; the renderer only presents it. Nothing here
 * touches the gameplay AgiAudio, the worker's sound stream, engine flags,
 * stored resources or persisted project state.
 */

import { SoundPlayback, booterSoundRows } from "../../../src/sound/sound.ts";
import { PROFILES, type AgiProfile, type ProfileId } from "../../../src/runtime/profile.ts";
import type { AgiAudio } from "./AgiAudio.ts";

export const AUDITION_TICK_HZ = 60;

export type AuditionStatus = "idle" | "playing" | "paused" | "seeking" | "complete" | "refused";

/** "unsupported" names the opaque authoring families (booter rows, IIgs). */
type AuditionLaneControls = "single" | "four" | "unsupported";

export interface AuditionTarget {
  projectId: string;
  workspaceId?: string;
  documentId: string;
  revision: string | number;
  payload: Uint8Array;
  profileId: ProfileId;
  /** The soundDevice operand the run renders with (0 = PC speaker). */
  device: number;
  /** The v23 attenuation operand; default 0. */
  adjustment?: number;
}

export interface AuditionTargetIdentity {
  projectId: string;
  workspaceId: string | null;
  documentId: string;
  revision: string | number;
  payloadHash: string;
  profileId: ProfileId;
  device: number;
  adjustment: number;
}

/**
 * The host's runtime freeze/transport hold. Acquisition answers an opaque,
 * run-specific release token; a token released late releases only its own
 * acquisition, never a newer one. Required — an always-grant service in
 * production is the host's explicit decision, not a default here.
 */
export interface AuditionLease {
  release(): void;
}
export type AuditionLeaseAcquire = (request: {
  owner: string;
  target: AuditionTargetIdentity;
  epoch: number;
}) => Promise<AuditionLease> | AuditionLease;

/** One monotonic clock and timer source; tests drive a fake. */
export interface AuditionScheduler {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AuditionSnapshot {
  status: AuditionStatus;
  /** The latest target/request epoch; stale async work carries an older one. */
  epoch: number;
  closed: boolean;
  target: AuditionTargetIdentity | null;
  /** Interpreter ticks executed, reported capped at the playback extent. */
  positionTicks: number;
  /** The header-declared extent; null for opaque families. */
  authoredExtentTicks: number | null;
  /** SoundPlayback's completion extent; Infinity for a looping IIgs sample. */
  playbackExtentTicks: number;
  laneControls: AuditionLaneControls | null;
  laneMuted: readonly boolean[];
  soloLane: number | null;
  leaseHeld: boolean;
  /** Ticks applied behind their schedule, counting silent re-sync work. */
  underrunTicks: number;
  refusal: string | null;
  warnings: readonly string[];
}

type RenderFamily = "speaker" | "psg" | "paula" | "booter" | "iigs";

const TICK_MS = 1000 / AUDITION_TICK_HZ;
/** Ticks one wake may run; larger backlogs rebase instead of bursting. */
const MAX_WAKE_TICKS = 8;
/** A backlog beyond this is a reported underrun, not a burst of late output. */
const REBASE_TICKS = 90;
/** Reconstruction chunk bounds: a tick count and a scheduler-time budget. */
const RECON_CHUNK_TICKS = 2048;
const RECON_CHUNK_MS = 12;
const MAX_WARNINGS = 64;
const PAUSE_OWNER = "sound-audition";
const LEASE_OWNER = "sound-audition";

/** Mirror of SoundPlayback's channel selection for lane-control reporting. */
function renderFamily(profile: AgiProfile, device: number): RenderFamily {
  const sound = profile.sound;
  if (sound === "iigs") return "iigs";
  if (sound === "booter-2.001") return "booter";
  if (sound === "amiga" || sound === "amiga-2.082") return "paula";
  return device === 0 || (sound === "common" && device === 8) ? "speaker" : "psg";
}

function laneControlOf(family: RenderFamily): AuditionLaneControls {
  if (family === "speaker") return "single";
  if (family === "psg" || family === "paula") return "four";
  return "unsupported";
}

/** The header-declared extent: summed lane durations, word 0 as 65,536. */
function authoredExtent(payload: Uint8Array, family: RenderFamily): number | null {
  if (family === "iigs") return null;
  if (family === "booter") return booterSoundRows(payload).length;
  if (payload.length < 8) return null;
  let max = 0;
  for (let ch = 0; ch < 4; ch++) {
    let pos = payload[ch * 2]! | (payload[ch * 2 + 1]! << 8);
    let sum = 0;
    while (pos + 2 <= payload.length) {
      const duration = payload[pos]! | (payload[pos + 1]! << 8);
      pos += 2;
      if (duration === 0xffff) break;
      if (pos + 3 > payload.length) break;
      pos += 3;
      sum += duration === 0 ? 65536 : duration;
    }
    if (sum > max) max = sum;
  }
  return max;
}

/** FNV-1a over the kept payload copy — identity, not security. */
function payloadHash(payload: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of payload) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function byteOperand(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255)
    throw new RangeError(`${name} must be an integer in 0..255.`);
  return value;
}

function defaultScheduler(): AuditionScheduler {
  return {
    now: () => globalThis.performance.now(),
    setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  };
}

export class SoundAudition {
  private readonly audio: AgiAudio;
  private readonly acquire: AuditionLeaseAcquire;
  private readonly scheduler: AuditionScheduler;

  private epoch = 0;
  private closedFlag = false;
  private status: AuditionStatus = "idle";
  private refusal: string | null = null;
  private readonly warnings: string[] = [];
  private readonly seenWarnings = new Set<string>();
  private underrunTicks = 0;

  private target: AuditionTargetIdentity | null = null;
  private payload: Uint8Array | null = null;
  private profile: AgiProfile | null = null;
  private family: RenderFamily | null = null;
  private authored: number | null = null;

  private playback: SoundPlayback | null = null;
  /** The target's completion extent, kept across stop()/playback resets. */
  private playbackExtent = 0;
  private completed = false;
  /** Interpreter ticks the playback/renderer pair have executed together. */
  private ticksRun = 0;

  private timer: unknown = null;
  /** Scheduler time at which the next tick is due. */
  private nextDue = 0;
  /** The fractional remainder a pause preserved, in ms. */
  private pausedCarryMs = TICK_MS;

  private lease: AuditionLease | null = null;
  private leaseReleased = false;

  /** Silence the renderer during reconstruction, separately from user gates. */
  private reconGated = false;
  private pauseRequested = false;
  private resumeAfterSeek = false;
  private readonly laneMuted = [false, false, false, false];
  private soloLane: number | null = null;

  private readonly subscribers = new Set<(snapshot: AuditionSnapshot) => void>();

  constructor(deps: {
    audio: AgiAudio;
    acquire: AuditionLeaseAcquire;
    scheduler?: AuditionScheduler;
  }) {
    this.audio = deps.audio;
    this.acquire = deps.acquire;
    this.scheduler = deps.scheduler ?? defaultScheduler();
  }

  /**
   * Point the preview at an immutable resource revision. The payload and
   * config are copied synchronously; a current run's notes are silenced
   * immediately and the cursor resets — a new target never plays old notes.
   */
  setTarget(offered: AuditionTarget): AuditionSnapshot {
    if (this.closedFlag) return this.refuse("closed");
    if (typeof offered.projectId !== "string" || offered.projectId.length === 0)
      throw new TypeError("target.projectId must be a non-empty string.");
    if (typeof offered.documentId !== "string" || offered.documentId.length === 0)
      throw new TypeError("target.documentId must be a non-empty string.");
    if (typeof offered.revision !== "string" && typeof offered.revision !== "number")
      throw new TypeError("target.revision must be a string or number.");
    if (!(offered.payload instanceof Uint8Array))
      throw new TypeError("target.payload must be a Uint8Array.");
    const profile = PROFILES[offered.profileId];
    if (!profile) throw new RangeError(`unknown profile '${offered.profileId}'.`);
    const device = byteOperand(offered.device, "target.device");
    const adjustment = byteOperand(offered.adjustment ?? 0, "target.adjustment");

    this.epoch++;
    this.cancelTimer();
    this.silenceCurrentRun();
    this.releaseLease();
    this.pauseRequested = false;
    this.resumeAfterSeek = false;

    // The kept copy is the only bytes the run ever reads.
    const payload = offered.payload.slice();
    this.payload = payload;
    this.profile = profile;
    this.family = renderFamily(profile, device);
    this.target = {
      projectId: offered.projectId,
      workspaceId: offered.workspaceId ?? null,
      documentId: offered.documentId,
      revision: offered.revision,
      payloadHash: payloadHash(payload),
      profileId: offered.profileId,
      device,
      adjustment,
    };
    this.warnings.length = 0;
    this.seenWarnings.clear();
    this.underrunTicks = 0;
    this.refusal = null;
    this.completed = false;
    this.ticksRun = 0;
    this.authored = authoredExtent(payload, this.family);
    this.status = "idle";
    this.playback = this.newPlayback();
    this.playbackExtent = this.playback?.durationTicks ?? this.authored ?? 0;
    this.notify();
    return this.snapshot();
  }

  /**
   * Start or continue the run. Audible preview first acquires the host's
   * runtime freeze/transport lease; a refusal or a superseded acquisition
   * leaves the target and the manual state untouched.
   */
  async play(): Promise<AuditionSnapshot> {
    if (this.closedFlag) return this.refuse("closed");
    if (!this.target || !this.profile || !this.payload || !this.family)
      return this.refuse("no-target");
    if (this.status === "playing") return this.snapshot();
    const e = ++this.epoch;
    this.cancelTimer();
    const resuming = this.status === "paused";
    if (!resuming) {
      // A fresh run starts from a clean renderer and a fresh playback.
      this.resetRenderer();
      this.playback = this.newPlayback();
      this.ticksRun = 0;
      this.completed = false;
    }
    if (!this.playback) return this.refuse("unplayable");
    if (this.completed || this.playback.durationTicks === 0) {
      // An empty resource completes at position 0 with no tick advancement.
      this.completed = true;
      this.status = "complete";
      this.releaseLease();
      this.notify();
      return this.snapshot();
    }
    if (!this.lease) {
      let handle: AuditionLease;
      try {
        // The host receives a detached identity copy: a recipient that
        // rewrites request.target must never reach the owned run state.
        handle = await this.acquire({
          owner: LEASE_OWNER,
          target: { ...this.target },
          epoch: e,
        });
      } catch (error) {
        if (e === this.epoch)
          return this.refuse("lease-refused", `the host lease refused: ${message(error)}`);
        return this.snapshot();
      }
      // A superseded acquisition releases its own token and only its own.
      if (e !== this.epoch || this.closedFlag) {
        try {
          handle.release();
        } catch {
          /* A stale token's release failure is its owner's business. */
        }
        return this.snapshot();
      }
      this.lease = handle;
      this.leaseReleased = false;
    }
    try {
      await this.audio.resume();
    } catch (error) {
      this.warn(`the audio unlock failed: ${message(error)}`);
    }
    if (e !== this.epoch || this.closedFlag) return this.snapshot();
    this.status = "playing";
    this.audio.setPauseOwner(PAUSE_OWNER, false);
    // The adapter call is an outward seam; a superseding call owns the run.
    if (e !== this.epoch) return this.snapshot();
    this.nextDue =
      this.scheduler.now() + (resuming ? Math.min(this.pausedCarryMs, TICK_MS) : TICK_MS);
    this.scheduleNext(e);
    this.notify();
    return this.snapshot();
  }

  /** Hold transport: the fractional remainder is preserved, never banked. */
  pause(): void {
    if (this.status === "seeking") {
      this.pauseRequested = true;
      this.notify();
      return;
    }
    if (this.status !== "playing") return;
    const e = this.epoch;
    this.cancelTimer();
    this.pausedCarryMs = Math.max(0, Math.min(TICK_MS, this.nextDue - this.scheduler.now()));
    this.audio.setPauseOwner(PAUSE_OWNER, true);
    // The audio adapter is an outward seam: a lifecycle call made from inside
    // it supersedes this pause and already published its own state.
    if (this.epoch !== e) return;
    this.status = "paused";
    this.notify();
  }

  /** Continue from a pause or a held seek position; no catch-up is owed. */
  async resume(): Promise<AuditionSnapshot> {
    if (this.status !== "paused") return this.snapshot();
    return this.continueRun();
  }

  /** Authentic silence for the current run, then a reset cursor. */
  stop(): AuditionSnapshot {
    const e = ++this.epoch;
    this.cancelTimer();
    this.silenceCurrentRun();
    this.releaseLease();
    // Lease release is a host callback: a run it started supersedes this stop.
    if (this.epoch !== e) return this.snapshot();
    this.pauseRequested = false;
    this.resumeAfterSeek = false;
    this.ticksRun = 0;
    this.completed = false;
    this.playback = null;
    this.status = "idle";
    this.refusal = null;
    this.notify();
    return this.snapshot();
  }

  /**
   * Reposition the run to an exact interpreter tick. Invalidated output is
   * silenced first, then the playback/renderer pair is reconstructed in
   * bounded, cancellable chunks — never by editing channel counters.
   */
  async seek(tick: number): Promise<AuditionSnapshot> {
    if (this.closedFlag) return this.refuse("closed");
    if (!Number.isSafeInteger(tick) || tick < 0)
      throw new RangeError("seek tick must be a finite nonnegative safe integer.");
    if (!this.target || !this.family || !this.profile || !this.payload)
      return this.refuse("no-target");
    if (this.family === "iigs")
      return this.refuse(
        "seek-unsupported-family",
        "the iigs renderer cannot be reconstructed through the lane-gain seam; " +
          "it needs an IigsSynth state restore seam, which does not exist yet.",
      );

    const extent = this.playback?.durationTicks ?? this.playbackExtent;
    let goal = tick;
    if (Number.isFinite(extent) && goal > extent) {
      goal = extent;
      this.warn(`seek past the ${extent}-tick extent clamps to the end.`);
    }
    const e = ++this.epoch;
    this.cancelTimer();
    if (this.status !== "seeking") this.resumeAfterSeek = this.status === "playing";
    this.status = "seeking";
    this.notify();
    // The seeking notification is an external callback point: observers may
    // retarget or replay synchronously, superseding this request.
    if (this.epoch !== e) return this.snapshot();

    let ok: boolean;
    try {
      ok = await this.reconstructTo(goal, e);
    } catch (error) {
      if (e === this.epoch) {
        this.silenceCurrentRun();
        this.releaseLease();
        return this.refuse("playback-error", `the interpreter stream failed: ${message(error)}`);
      }
      return this.snapshot();
    }
    if (!ok) return this.snapshot();
    if (this.completed) {
      this.status = "complete";
      this.audio.setPauseOwner(PAUSE_OWNER, false);
      this.releaseLease();
      this.notify();
      return this.snapshot();
    }
    if (this.pauseRequested || !this.resumeAfterSeek) {
      this.pauseRequested = false;
      this.status = "paused";
      this.pausedCarryMs = TICK_MS;
      this.audio.setPauseOwner(PAUSE_OWNER, true);
    } else {
      this.status = "playing";
      this.nextDue = this.scheduler.now() + TICK_MS;
      this.scheduleNext(e);
    }
    this.notify();
    return this.snapshot();
  }

  setLaneMuted(lane: number, muted: boolean): void {
    const count = this.laneCount();
    if (count === 0) {
      this.warn(
        this.family === null
          ? "lane controls need a target first."
          : `lane controls are unsupported for the ${this.family} family.`,
      );
      return;
    }
    if (!Number.isInteger(lane) || lane < 0 || lane >= count)
      throw new RangeError(`lane must be an integer in 0..${count - 1}.`);
    this.laneMuted[lane] = muted;
    this.applyLaneAudibility();
    this.notify();
  }

  setLaneSolo(lane: number | null): void {
    const count = this.laneCount();
    if (count === 0) {
      this.warn(
        this.family === null
          ? "lane controls need a target first."
          : `lane controls are unsupported for the ${this.family} family.`,
      );
      return;
    }
    if (lane !== null && (!Number.isInteger(lane) || lane < 0 || lane >= count))
      throw new RangeError(`solo lane must be null or an integer in 0..${count - 1}.`);
    this.soloLane = lane;
    this.applyLaneAudibility();
    this.notify();
  }

  subscribe(cb: (snapshot: AuditionSnapshot) => void): () => void {
    this.subscribers.add(cb);
    try {
      cb(this.snapshot());
    } catch (error) {
      this.warn(`a snapshot subscriber failed: ${message(error)}`);
    }
    return () => {
      this.subscribers.delete(cb);
    };
  }

  snapshot(): AuditionSnapshot {
    const extent = this.playback?.durationTicks ?? this.playbackExtent;
    return {
      status: this.status,
      epoch: this.epoch,
      closed: this.closedFlag,
      target: this.target === null ? null : { ...this.target },
      positionTicks: Number.isFinite(extent) && this.ticksRun > extent ? extent : this.ticksRun,
      authoredExtentTicks: this.authored,
      playbackExtentTicks: extent,
      laneControls: this.family === null ? null : laneControlOf(this.family),
      laneMuted: this.laneMuted.slice(0, this.laneCount()),
      soloLane: this.soloLane,
      leaseHeld: this.lease !== null && !this.leaseReleased,
      underrunTicks: this.underrunTicks,
      refusal: this.refusal,
      warnings: [...this.warnings],
    };
  }

  /** Release the lease and dispose the private audio instance — once. */
  async close(): Promise<void> {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.epoch++;
    this.cancelTimer();
    this.silenceCurrentRun();
    this.releaseLease();
    this.pauseRequested = false;
    this.resumeAfterSeek = false;
    this.ticksRun = 0;
    this.completed = false;
    this.playback = null;
    this.status = "idle";
    this.refusal = null;
    this.notify();
    await this.audio.close();
  }

  // ---- transport internals ----

  private continueRun(): Promise<AuditionSnapshot> {
    // Resume shares play()'s path: a paused run keeps position and acquires
    // the lease only when audible playback actually starts.
    return this.play();
  }

  private scheduleNext(e: number): void {
    const delay = Math.max(0, this.nextDue - this.scheduler.now());
    this.timer = this.scheduler.setTimeout(() => this.onWake(e), delay);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private onWake(e: number): void {
    this.timer = null;
    if (this.closedFlag || e !== this.epoch || this.status !== "playing" || !this.playback) return;
    const playback = this.playback;
    const overdue = Math.floor((this.scheduler.now() - this.nextDue) / TICK_MS);
    if (overdue > REBASE_TICKS) {
      this.underrunTicks += overdue;
      if (this.family === "iigs") {
        this.warn(
          `audition stopped: a ${overdue}-tick scheduling underrun cannot be replayed ` +
            "through the iigs renderer.",
        );
        this.silenceCurrentRun();
        this.releaseLease();
        // The silence outputs and lease release are outward seams; a
        // superseding run owns the counters from here.
        if (this.epoch !== e) return;
        this.playback = null;
        this.ticksRun = 0;
        this.completed = false;
        this.status = "idle";
        this.notify();
        return;
      }
      this.warn(`late output underrun: silently re-syncing ${overdue} ticks.`);
      void this.rebase(e, overdue).catch((error) => {
        if (e === this.epoch && !this.closedFlag) {
          this.silenceCurrentRun();
          this.releaseLease();
          this.refuse("playback-error", `the interpreter stream failed: ${message(error)}`);
        }
      });
      return;
    }
    let ran = 0;
    try {
      while (ran < Math.min(1 + overdue, MAX_WAKE_TICKS) && !this.completed) {
        const result = playback.tick(true, this.target!.adjustment);
        for (const output of result.outputs) this.audio.output(output);
        // A lifecycle call reentering through the audio adapter (stop, close,
        // retarget) supersedes this wake; abandon before counting the tick.
        if (this.epoch !== e || this.playback !== playback || this.status !== "playing") return;
        this.ticksRun++;
        ran++;
        if (result.complete) this.completed = true;
      }
    } catch (error) {
      // A tick or renderer failure inside a timer must not escape as an
      // uncaught exception: silence and name the refusal instead.
      this.silenceCurrentRun();
      this.releaseLease();
      this.refuse("playback-error", `the interpreter stream failed: ${message(error)}`);
      return;
    }
    // The ticks applied late this wake count as underrun, never as accuracy.
    if (overdue > 0) this.underrunTicks += Math.min(ran, overdue);
    this.nextDue += ran * TICK_MS;
    if (this.completed) {
      this.finishComplete();
      return;
    }
    this.scheduleNext(e);
    this.notify();
  }

  /**
   * A backlog is re-synced silently: the interpreter still executes every
   * tick through the lane-gated renderer, so register state stays exact;
   * only audibility is skipped. Position and wall time re-anchor after.
   */
  private async rebase(e: number, overdue: number): Promise<void> {
    this.status = "seeking";
    this.notify();
    if (!(await this.reconstructTo(this.ticksRun + overdue, e))) return;
    if (this.completed) {
      this.finishComplete();
      return;
    }
    if (this.pauseRequested) {
      this.pauseRequested = false;
      this.status = "paused";
      this.pausedCarryMs = TICK_MS;
      this.audio.setPauseOwner(PAUSE_OWNER, true);
    } else {
      this.status = "playing";
      this.nextDue = this.scheduler.now() + TICK_MS;
      this.scheduleNext(e);
    }
    this.notify();
  }

  /**
   * Advance the playback/renderer pair to `goal` ticks, silently and in
   * bounded chunks. Backward or post-stop goals reset the renderer and
   * replay from tick 0 — renderer register state cannot be restored from a
   * playback-only snapshot, so it is rebuilt by the same event stream.
   * Returns false when a newer request superseded this epoch.
   */
  private async reconstructTo(goal: number, e: number): Promise<boolean> {
    // Admission before any side effect: a request superseded by an observer
    // callback must never gate a newer run's lanes.
    if (this.epoch !== e) return false;
    this.reconGated = true;
    this.applyLaneAudibility();
    try {
      if (this.playback === null || this.ticksRun > goal || this.completed) {
        this.audio.stop();
        // The renderer reset is an outward seam too.
        if (this.epoch !== e) return false;
        this.applyLaneAudibility();
        this.playback = this.newPlayback();
        this.ticksRun = 0;
        this.completed = false;
      }
      const playback = this.playback;
      if (playback === null) return this.epoch === e;
      while (this.ticksRun < goal && !this.completed) {
        // A superseding request may have reset the counters or replaced the
        // playback between chunks; continuing on the stale pair would corrupt
        // the new run's position and feed it old events.
        if (this.epoch !== e || this.playback !== playback) return false;
        const chunkStart = this.scheduler.now();
        let ran = 0;
        while (
          this.ticksRun < goal &&
          ran < RECON_CHUNK_TICKS &&
          this.scheduler.now() - chunkStart < RECON_CHUNK_MS
        ) {
          const result = playback.tick(true, this.target!.adjustment);
          for (const output of result.outputs) this.audio.output(output);
          // A lifecycle call reentering through the audio adapter supersedes
          // this reconstruction; abandon before counting the stale tick.
          if (this.epoch !== e || this.playback !== playback) return false;
          this.ticksRun++;
          ran++;
          if (result.complete) this.completed = true;
          if (this.completed) break;
        }
        this.notify();
        if (this.epoch !== e) return false;
        if (this.ticksRun < goal && !this.completed) {
          await this.yieldNow();
          if (this.epoch !== e) return false;
        }
      }
      return this.epoch === e;
    } finally {
      // Ungate only while this epoch still owns the gate: a superseding
      // operation either cleared it (reset) or set its own (a new
      // reconstruction), and must not be ungated from underneath.
      if (this.epoch === e && this.reconGated) {
        this.reconGated = false;
        this.applyLaneAudibility();
      }
    }
  }

  private yieldNow(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.scheduler.setTimeout(resolve, 0);
    });
  }

  private finishComplete(): void {
    this.status = "complete";
    this.cancelTimer();
    this.audio.setPauseOwner(PAUSE_OWNER, false);
    this.releaseLease();
    this.notify();
  }

  /** The run's own silence outputs, then a clean renderer. */
  private silenceCurrentRun(): void {
    if (this.playback && this.ticksRun > 0 && !this.completed) {
      try {
        for (const output of this.playback.stop()) this.audio.output(output);
      } catch {
        /* A renderer refusing a silence never blocks the reset. */
      }
    }
    this.resetRenderer();
  }

  private resetRenderer(): void {
    this.reconGated = false;
    this.audio.stop();
    this.audio.setPauseOwner(PAUSE_OWNER, false);
    this.applyLaneAudibility();
  }

  private newPlayback(): SoundPlayback | null {
    if (!this.profile || !this.payload || !this.target) return null;
    try {
      return new SoundPlayback(this.profile, this.payload, this.target.device, (warning) =>
        this.warn(warning),
      );
    } catch (error) {
      this.warn(`the sound resource cannot be played: ${message(error)}`);
      return null;
    }
  }

  private laneCount(): number {
    if (this.family === null || this.family === "iigs" || this.family === "booter") return 0;
    return this.family === "speaker" ? 1 : 4;
  }

  private applyLaneAudibility(): void {
    // Internal reconstruction gates apply to every register-rendered lane,
    // including booter rows; the unsupported user-facing control is separate.
    const count =
      this.family === "speaker" ? 1 : this.family === "iigs" || this.family === null ? 0 : 4;
    for (let lane = 0; lane < count; lane++) {
      const userAudible = this.soloLane !== null ? lane === this.soloLane : !this.laneMuted[lane];
      this.audio.setLaneAudible(lane, userAudible && !this.reconGated);
    }
  }

  private releaseLease(): void {
    if (!this.lease || this.leaseReleased) return;
    this.leaseReleased = true;
    const lease = this.lease;
    this.lease = null;
    try {
      lease.release();
    } catch (error) {
      this.warn(`the host lease release failed: ${message(error)}`);
    }
  }

  private refuse(code: string, detail?: string): AuditionSnapshot {
    this.status = "refused";
    this.refusal = code;
    if (detail !== undefined) this.warn(detail);
    this.notify();
    return this.snapshot();
  }

  private warn(text: string): void {
    if (this.seenWarnings.has(text)) return;
    this.seenWarnings.add(text);
    if (this.warnings.length >= MAX_WARNINGS) this.warnings.shift();
    this.warnings.push(text);
  }

  private notify(): void {
    // Every observer receives a detached snapshot: one observer's mutation of
    // published state can never reach another observer or the owned run. And
    // a callback that synchronously supersedes the epoch (stop, close,
    // retarget, a new seek) ends this publication — the superseding call's
    // own notify already delivered fresh state to the remaining observers.
    const e = this.epoch;
    for (const cb of this.subscribers) {
      if (this.epoch !== e) return;
      try {
        cb(this.snapshot());
      } catch (error) {
        this.warn(`a snapshot subscriber failed: ${message(error)}`);
      }
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

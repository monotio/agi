/**
 * HistoryRecording — the versioned always-on session-history contract.
 *
 * While a game plays, the worker records every accepted boundary cause —
 * keys, direction holds and releases, typed input, prompt and host answers,
 * patches, pauses — stamped with the interpreter's logical tick and cycle,
 * plus checkpoint anchors complete enough to resume mid-play (save image,
 * parked continuation, PRNG state, clock accumulators, queued input) and
 * cheap sync marks that let a replay detect divergence.
 *
 * A recording replays deterministically offline: restore a segment's boot
 * (or any anchor), then apply the event stream at the recorded ticks — a
 * host answer resumes execution before the next tick, same-tick keys keep
 * queue order, and a patch applies at its recorded boundary, never to the
 * boot resources the earlier part of the tape ran on.
 *
 * Pure module: no browser, worker or Node APIs. The engine-facing helpers
 * take structural types so both the live worker and a scratch replayer can
 * feed them.
 */
import { validateEngineReplayState, type EngineReplayState } from "../runtime/replayState.ts";
import type { EngineMenuState } from "../runtime/engine.ts";
import { gameIdentity, type GameIdentity } from "../gameIdentity.ts";

/** Current recording contract: game identity, original 16-bit RNG and reseed events. */
export const HISTORY_FORMAT_VERSION = 1;

/** Worker in-memory ring bounds: records and bytes pending the host's ack. */
export const HISTORY_EVENT_LIMIT = 250_000;
export const HISTORY_BYTE_LIMIT = 48 * 1024 * 1024;
/** Posted-but-unacknowledged batch credit, same pattern as the trace stream. */
export const HISTORY_INFLIGHT_MAX = 4;
/**
 * Per-segment bounds during healthy recording: a live segment ends and rolls
 * over rather than grow past these, so the persisted tape's total is bounded
 * by HISTORY_SEGMENTS_MAX bounded segments.
 */
export const HISTORY_SEGMENT_BYTE_LIMIT = 8 * 1024 * 1024;
export const HISTORY_SEGMENT_EVENT_LIMIT = 25_000;

export type HistoryPatchKind = "logic" | "picture" | "view" | "sound";

export interface HistoryCommittedResource {
  kind: HistoryPatchKind;
  num: number;
  /** base64 resource payload. */
  data: string;
}

/** The container changes a room-authoring answer committed before resuming. */
export interface HistoryCommittedPatch {
  resources: HistoryCommittedResource[];
  /** base64 replacement WORDS.TOK / OBJECT / TESTS.JSON payloads. */
  words?: string;
  object?: string;
  tests?: string;
}

export type HistoryEndReason = "boot" | "walkthrough" | "resume" | "quit" | "budget" | "eject";

const END_REASONS: ReadonlySet<HistoryEndReason> = new Set([
  "boot",
  "walkthrough",
  "resume",
  "quit",
  "budget",
  "eject",
]);

export type HistoryEventCause =
  | { kind: "key"; code: number }
  | { kind: "direction"; dir: number }
  | { kind: "release" }
  | { kind: "input"; text: string }
  | { kind: "edit"; text: string }
  | { kind: "dismiss" }
  | {
      kind: "answer";
      op: string;
      request: number;
      response: string;
      /** op "room": which room was authored and what the patch committed. */
      room?: number;
      prepared?: boolean;
      patch?: HistoryCommittedPatch;
    }
  | { kind: "patch"; resource: HistoryPatchKind; num: number; data: string }
  | { kind: "patchMeta"; words?: string; object?: string; tests?: string }
  | { kind: "reenter"; room?: number }
  | { kind: "restart" }
  | { kind: "pause"; paused: boolean }
  | { kind: "sound"; enabled: boolean }
  | {
      /**
       * 60 Hz sound discharges that ran between host polls — the sound
       * timer or a mid-dispatch clock advance. They ride the event stream,
       * not the next poll's clock observation: a pause or input can be
       * recorded between the discharge and that poll, and only an ordered
       * event keeps replay from applying it after the boundary that
       * already observed its effect.
       */
      kind: "clock";
      ticks: number;
    }
  | { kind: "device"; device: number }
  | {
      kind: "debugWrite";
      vars: [number, number][];
      flags: [number, number][];
    }
  | {
      /**
       * The host-side authoring session's state at a committed change — the
       * sources, vocabulary, bindings and world plan the AgentSession works
       * from. The tape carries it so a Resume here adoption can reinstall
       * the state belonging to the adopted bytes rather than keeping a
       * future the player can no longer see. Replay treats it as metadata:
       * it is not an engine input.
       */
      kind: "authoring";
      snapshot: Record<string, unknown>;
    }
  | {
      /**
       * One BIOS-clock word the RNG consumed on a zero-state draw
       * (docs/fidelity.md, "Original RNG"): an external input, recorded
       * because zero is reachable mid-stream — recording only the boot's
       * seed could never reproduce a later clock read. Replay feeds the
       * stream's recorded words back in draw order; the event itself is
       * positional, applied through the reseed lane inside the pass.
       */
      kind: "reseed";
      value: number;
    }
  | { kind: "end"; reason: HistoryEndReason };

export interface HistoryEvent {
  /** Position in the segment's event stream. */
  seq: number;
  /** 60 Hz sound-clock tick within the segment; frozen while paused. */
  tick: number;
  /** Completed interpreter cycles within the segment. */
  cycle: number;
  cause: HistoryEventCause;
}

/** A journal room transition pinned to its position in the event stream. */
export interface HistoryRoomMark {
  seq: number;
  tick: number;
  cycle: number;
  room: number;
  via: string;
  edge?: string;
}

/**
 * A cheap checksum of interpreter state at a stream position: vars, flags,
 * screen-object positions and the text surface, plus diagnostic fields.
 * Marks detect divergence; they do not prove equivalence.
 */
export interface HistorySyncMark {
  seq: number;
  tick: number;
  cycle: number;
  /** FNV-1a over vars, flags, object positions and the 25 text rows. */
  digest: string;
  room: number;
  score: number;
  patchGeneration: number;
  modal: string | null;
}

/** Cycle-clock accumulators at a boundary (the host's time base is restored). */
export interface HistoryClock {
  remainder: number;
  increments: number;
  paused: boolean;
}

/**
 * A run of identical per-poll clock observations, run-length encoded on the
 * segment's tick axis: `n` consecutive host polls beginning at `tick` each
 * discharged `sound` 60 Hz sound ticks and did (`cycle`) or did not fire a
 * logic cycle. Wall-clock scheduling is a recorded input — replay feeds the
 * observation back instead of re-deriving discharge counts from a virtual
 * clock, so timer jitter and suspended-tab gaps replay identically.
 */
export interface HistoryClockRun {
  tick: number;
  n: number;
  /** 60 Hz sound ticks each covered poll discharged — any count. */
  sound: number;
  /** Whether each covered poll's cycle poll fired a logic cycle. */
  cycle: boolean;
}

/**
 * A complete mid-play restore point: the recording image (save bytes, screen
 * and parked continuation) plus everything outside it — transient replay
 * state, the worker's input queues and request serial, the RNG word and
 * clocks. History deliberately restores the RNG position the authentic
 * save excludes (docs/fidelity.md, save/restart audit).
 */
export interface HistoryAnchor {
  /** Position in the segment's event stream (events applied before it). */
  seq: number;
  tick: number;
  cycle: number;
  reason: "boot" | "room" | "autosave" | "flush" | "pause" | "resume";
  /** base64 recordingImage() bytes. */
  image: string;
  replay: EngineReplayState;
  inputQueue: number[];
  directionQueue: number[];
  /** Submitted command lines not yet consumed by takeInputLine. */
  inputLines: string[];
  /** Host-request serial, so replayed requests keep their answer pairing. */
  requestSerial: number;
  rng: number;
  clock: HistoryClock;
  /** Sound-clock fractional carry (ms·60 units) at this boundary. */
  soundRemainder?: number;
  soundDevice: number;
  /** resourceSetHint of the container at this anchor — a cache hint, not identity. */
  resourceSet: string;
  patchGeneration: number;
  /** Recorded semantic fingerprint — replay must re-derive it after restore. */
  fingerprint?: HistoryFingerprint;
}

/**
 * A segment's starting state — self-contained: the full file set and
 * dictionary at segment start, plus the resume point when the segment
 * continues mid-play (autosave resume, replay takeover, budget rollover).
 */
export interface HistoryBoot {
  /** base64 per file name — the exact resources the segment replays onto. */
  files: Record<string, string>;
  /** liveDictionary entries at segment start. */
  dictionary: [string, number][];
  /** The recorded session allowed the prepareRoom host hook (authored games). */
  authorRooms: boolean;
  /** Set when the segment continues an earlier one (replay takeover, budget rollover). */
  resumedFrom?: { segment: string; seq: number; tick: number };
  image?: string;
  replay?: EngineReplayState;
  menus?: EngineMenuState;
  inputQueue?: number[];
  directionQueue?: number[];
  inputLines?: string[];
  /** The RNG's 16-bit state word at this point (docs/fidelity.md, "Original RNG"). */
  rng: number;
  clock?: HistoryClock;
  /** Sound-clock fractional carry (ms·60 units) at this resume point. */
  soundRemainder?: number;
  soundDevice: number;
  /** resourceSetHint of `files` — a cache hint, not identity. */
  resourceSet: string;
  requestSerial: number;
  /** Recorded semantic fingerprint — replay must re-derive it after restore. */
  fingerprint?: HistoryFingerprint;
}

/**
 * One continuous run of play: boot state, anchors, the event stream and its
 * marks. A segment ends explicitly — a walkthrough takeover, a new boot, a
 * quit, a budget rollover — or stays open as the live tail.
 */
export interface HistorySegment {
  id: string;
  boot: HistoryBoot;
  anchors: HistoryAnchor[];
  events: HistoryEvent[];
  marks: HistoryRoomMark[];
  sync: HistorySyncMark[];
  /** Per-poll clock observations, RLE on the tick axis; absent on pre-lane tapes. */
  clock?: HistoryClockRun[];
  /** seq of the next unrecorded event at end; a gap before it marks a dropped tail. */
  end?: { seq: number; tick: number; cycle: number; reason: HistoryEndReason };
}

export interface HistoryRecording {
  version: number;
  /** The library entry and playable-bytes revision this tape belongs to. */
  identity: GameIdentity;
  /** Interpreter profile id the first segment booted under. */
  profile: string;
  /** resourceSetHint at the first segment's start — a cache hint, not identity. */
  resourceSet: string;
  startedAt: number;
  segments: HistorySegment[];
  /** Segments the retention bound evicted; segment[0] is the earliest kept. */
  dropped?: number;
}

/** One transport unit: stream data up to and including its closing anchor. */
export interface HistoryBatch {
  segment: string;
  batch: number;
  /** Event range covered: [seqStart, seqEnd). */
  seqStart: number;
  seqEnd: number;
  boot?: HistoryBoot;
  events: HistoryEvent[];
  marks: HistoryRoomMark[];
  sync: HistorySyncMark[];
  /** The clock observations recorded while this batch accumulated. */
  clock?: HistoryClockRun[];
  anchor?: HistoryAnchor;
  end?: { seq: number; tick: number; cycle: number; reason: HistoryEndReason };
  /**
   * Batch numbers this batch's sender deliberately abandoned — the queue
   * overflow's dropped tail. Storage may skip exactly these in the commit
   * ledger; an `end` marker alone never grants a jump, so a normal closer
   * still waits for its missing predecessors.
   */
  gap?: number[];
}

// ---------- sync marks ----------

const V_ROOM = 0;
const V_SCORE = 3;

/** The engine surface the sync digest reads — the worker's Engine satisfies it. */
export interface HistorySyncSource {
  vars: ArrayLike<number>;
  flags: ArrayLike<number>;
  readObjects(): readonly { num: number; x: number; y: number }[];
  textRow(row: number): string;
  patchGeneration: number;
  modalKind: string | null;
}

export function historySyncDigest(engine: HistorySyncSource): string {
  let hash = 0x811c9dc5;
  const feed = (v: number): void => {
    hash = Math.imul(hash ^ (v & 0xffff), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ (v >>> 16), 0x01000193) >>> 0;
  };
  for (let i = 0; i < engine.vars.length; i++) feed(engine.vars[i]!);
  for (let i = 0; i < engine.flags.length; i++) feed(engine.flags[i]!);
  for (const o of engine.readObjects()) {
    feed(o.num);
    feed(o.x);
    feed(o.y);
  }
  for (let row = 0; row < 25; row++) {
    const text = engine.textRow(row);
    for (let i = 0; i < text.length; i++) feed(text.charCodeAt(i));
    feed(0x10000);
  }
  return hash.toString(16).padStart(8, "0");
}

export function computeSyncMark(
  engine: HistorySyncSource,
  seq: number,
  tick: number,
  cycle: number,
): HistorySyncMark {
  return {
    seq,
    tick,
    cycle,
    digest: historySyncDigest(engine),
    room: engine.vars[V_ROOM] ?? 0,
    score: engine.vars[V_SCORE] ?? 0,
    patchGeneration: engine.patchGeneration,
    modal: engine.modalKind,
  };
}

// ---------- semantic fingerprints ----------

/** The fingerprint format riding anchors and segment boots. */
export const HISTORY_FINGERPRINT_VERSION = 1;

/**
 * A recorded hash over the semantic state at a resume point. Replay
 * re-captures the same fields from the restored scratch session and the
 * two must agree — the recorded expectation is compared against the
 * restore, never a hash recomputed over state that was never checked.
 */
export interface HistoryFingerprint {
  v: number;
  /** 16 hex chars: FNV-1a-64 over the canonical semantic record. */
  hash: string;
}

/**
 * The fields a fingerprint covers — everything that decides future
 * behavior at a resume point: the save image (vars, flags, strings, item
 * locations, the object table's motion/cycle records, screen and the
 * parked continuation), the host replay state (parser, controllers, menu
 * state, sound playback, the engine's own input queue and continuation),
 * the worker's queued input and request serial, the PRNG word, both
 * scheduler accumulators, the sound device and the container identity.
 *
 * Excluded host-only fields, and why:
 * - `files`: `resourceSet` is their identity — hashing megabytes of
 *   container bytes per resume point buys nothing the revision does not.
 * - `seq`/`tick`/`cycle`/`reason`/`resumedFrom`: position and provenance —
 *   where the record sits, not what it means.
 * - Wall-clock bases (`previous` on both clocks): re-based onto the host
 *   clock at restore by contract; only the accumulators are state.
 * - Engine fields `restoreReplayState` deliberately re-arms
 *   (pendingAnswer, saveDialogMode, modal serials): they describe an
 *   in-flight interaction, not resumable state.
 */
export interface HistorySemanticState {
  authorRooms?: boolean;
  dictionary?: [string, number][];
  image?: string;
  replay?: unknown;
  menus?: unknown;
  inputQueue?: number[];
  directionQueue?: number[];
  inputLines?: string[];
  requestSerial: number;
  rng: number;
  clock?: HistoryClock;
  soundRemainder?: number;
  soundDevice: number;
  resourceSet: string;
  patchGeneration?: number;
}

const sortDictionary = (entries: readonly [string, number][]): [string, number][] =>
  [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** The semantic view of a recorded anchor — every resumable-state field it carries. */
export function historyAnchorSemantic(anchor: HistoryAnchor): HistorySemanticState {
  const out: HistorySemanticState = {
    image: anchor.image,
    replay: anchor.replay,
    inputQueue: anchor.inputQueue,
    directionQueue: anchor.directionQueue,
    inputLines: anchor.inputLines,
    requestSerial: anchor.requestSerial,
    rng: anchor.rng,
    clock: anchor.clock,
    soundDevice: anchor.soundDevice,
    resourceSet: anchor.resourceSet,
    patchGeneration: anchor.patchGeneration,
  };
  if (anchor.soundRemainder !== undefined) out.soundRemainder = anchor.soundRemainder;
  return out;
}

/** The semantic view of a segment boot — every resumable-state field it carries. */
export function historyBootSemantic(boot: HistoryBoot): HistorySemanticState {
  const out: HistorySemanticState = {
    authorRooms: boot.authorRooms,
    dictionary: sortDictionary(boot.dictionary),
    requestSerial: boot.requestSerial,
    rng: boot.rng,
    soundDevice: boot.soundDevice,
    resourceSet: boot.resourceSet,
  };
  if (boot.image !== undefined) out.image = boot.image;
  if (boot.replay !== undefined) out.replay = boot.replay;
  if (boot.menus !== undefined) out.menus = boot.menus;
  if (boot.inputQueue !== undefined) out.inputQueue = boot.inputQueue;
  if (boot.directionQueue !== undefined) out.directionQueue = boot.directionQueue;
  if (boot.inputLines !== undefined) out.inputLines = boot.inputLines;
  if (boot.clock !== undefined) out.clock = boot.clock;
  if (boot.soundRemainder !== undefined) out.soundRemainder = boot.soundRemainder;
  return out;
}

/** Deterministic serialization: sorted object keys, arrays in order, undefined dropped. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalize(child)}`);
  }
  return `{${parts.join(",")}}`;
}

export function historyFingerprint(state: HistorySemanticState): HistoryFingerprint {
  const text = canonicalize(state);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return { v: HISTORY_FINGERPRINT_VERSION, hash: hash.toString(16).padStart(16, "0") };
}

// ---------- validation (project archives are untrusted input) ----------

const MAX_HISTORY_EVENTS = 2_000_000;
const MAX_HISTORY_TEXT = 64 * 1024;
const MAX_HISTORY_B64 = 64 * 1024 * 1024;
const MAX_HISTORY_STRING = 256 * 1024;

function fail(message: string): never {
  throw new Error(`Invalid history recording: ${message}`);
}

/**
 * The committed stream is a contiguous prefix — a batch lands only as its
 * segment's next sequence, so every lane reads in stream order: events
 * strictly (each owns its seq), marks, sync marks and anchors not
 * decreasing (a boundary stamps the position without consuming it). A tape
 * whose lanes are out of order was written badly; replay would apply it
 * wrongly, so validation refuses it at the boundary.
 */
function checkSeqOrder(list: readonly { seq: number }[], name: string, strict: boolean): void {
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]!.seq;
    const cur = list[i]!.seq;
    if (strict ? cur <= prev : cur < prev) fail(`segment ${name} must be ordered by seq.`);
  }
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function int(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max)
    fail(`${name} must be an integer in range.`);
  return value;
}

function num(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max)
    fail(`${name} must be a number in range.`);
  return value;
}

function text(value: unknown, name: string, max = MAX_HISTORY_TEXT): string {
  if (typeof value !== "string" || value.length > max) fail(`${name} must be bounded text.`);
  return value;
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
function b64(value: unknown, name: string, max = MAX_HISTORY_B64): string {
  if (typeof value !== "string" || value.length > max || !B64.test(value))
    fail(`${name} must be bounded base64.`);
  return value;
}

function numberList(value: unknown, name: string, max = 4096): number[] {
  if (!Array.isArray(value) || value.length > max) fail(`${name} must be a bounded list.`);
  return value.map((v) => int(v, name));
}

function stringList(value: unknown, name: string, max = 1024): string[] {
  if (!Array.isArray(value) || value.length > max) fail(`${name} must be a bounded list.`);
  return value.map((v) => text(v, name, 1024));
}

function dictionary(value: unknown): [string, number][] {
  if (!Array.isArray(value) || value.length > 65536) fail("dictionary must be a bounded list.");
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2)
      fail("dictionary entries must be [word, id] pairs.");
    return [text(entry[0], "dictionary word", 64), int(entry[1], "dictionary id", 0xffff)];
  });
}

function clock(value: unknown): HistoryClock {
  if (!isObj(value)) fail("clock must be an object.");
  return {
    remainder: num(value["remainder"], "clock.remainder", 1000),
    increments: int(value["increments"], "clock.increments"),
    paused: value["paused"] === true,
  };
}

/**
 * The clock-observation lane: runs must be ordered by start tick and
 * non-overlapping; coverage gaps are tolerated (a torn batch's tail) and
 * replay falls back to virtual derivation for uncovered polls.
 */
function clockRuns(value: unknown): HistoryClockRun[] {
  if (!Array.isArray(value) || value.length > MAX_HISTORY_EVENTS)
    fail("clock runs must be a bounded list.");
  let covered = 0;
  return value.map((r) => {
    if (!isObj(r)) fail("clock run must be an object.");
    const run: HistoryClockRun = {
      tick: int(r["tick"], "clock run tick"),
      n: int(r["n"], "clock run n"),
      sound: int(r["sound"], "clock run sound"),
      cycle: r["cycle"] === true,
    };
    if (run.n === 0 || run.tick < covered) fail("clock runs must be ordered and non-overlapping.");
    covered = run.tick + run.n;
    return run;
  });
}

/** Mirrors the engine's restoreMenuState contract so archives validate ahead of restore. */
function menus(value: unknown): EngineMenuState {
  const fail_ = () => fail("menus must be a valid engine menu state.");
  if (!isObj(value)) return fail_();
  const headings = value["headings"];
  if (
    !Array.isArray(headings) ||
    headings.length > 40 ||
    typeof value["finalized"] !== "boolean" ||
    typeof value["requested"] !== "boolean" ||
    !Number.isInteger(value["heading"]) ||
    (value["heading"] as number) < 0 ||
    (value["heading"] as number) >= Math.max(1, headings.length)
  )
    return fail_();
  return {
    headings: headings.map((heading) => {
      if (!isObj(heading)) return fail_();
      const items = heading["items"];
      if (
        typeof heading["title"] !== "string" ||
        heading["title"].length > 1000 ||
        typeof heading["enabled"] !== "boolean" ||
        !Array.isArray(items) ||
        items.length > 255 ||
        !Number.isInteger(heading["current"]) ||
        (heading["current"] as number) < 0 ||
        (heading["current"] as number) >= Math.max(1, items.length)
      )
        return fail_();
      return {
        title: heading["title"],
        enabled: heading["enabled"],
        current: heading["current"] as number,
        items: items.map((item) => {
          if (
            !isObj(item) ||
            typeof item["text"] !== "string" ||
            item["text"].length > 1000 ||
            typeof item["enabled"] !== "boolean" ||
            !Number.isInteger(item["id"]) ||
            (item["id"] as number) < 0 ||
            (item["id"] as number) > 255
          )
            return fail_();
          return { text: item["text"], id: item["id"] as number, enabled: item["enabled"] };
        }),
      };
    }),
    finalized: value["finalized"],
    heading: value["heading"] as number,
    requested: value["requested"],
  };
}

function committedPatch(value: unknown): HistoryCommittedPatch {
  if (!isObj(value)) fail("patch must be an object.");
  const resources = value["resources"];
  if (!Array.isArray(resources) || resources.length > 256)
    fail("patch.resources must be a bounded list.");
  const out: HistoryCommittedPatch = {
    resources: resources.map((r) => {
      if (!isObj(r) || !["logic", "picture", "view", "sound"].includes(String(r["kind"])))
        fail("patch resource kind is invalid.");
      return {
        kind: r["kind"] as HistoryPatchKind,
        num: int(r["num"], "patch num", 255),
        data: b64(r["data"], "patch data"),
      };
    }),
  };
  if (value["words"] !== undefined) out.words = b64(value["words"], "patch words");
  if (value["object"] !== undefined) out.object = b64(value["object"], "patch object");
  if (value["tests"] !== undefined) out.tests = b64(value["tests"], "patch tests");
  return out;
}

function eventCause(value: unknown): HistoryEventCause {
  if (!isObj(value)) fail("event cause must be an object.");
  switch (value["kind"]) {
    case "key":
      return { kind: "key", code: int(value["code"], "key code", 0xffff) };
    case "direction":
      return { kind: "direction", dir: int(value["dir"], "direction", 0xff) };
    case "release":
      return { kind: "release" };
    case "input":
      return { kind: "input", text: text(value["text"], "input text", 1024) };
    case "edit":
      return { kind: "edit", text: text(value["text"], "edit text", 1024) };
    case "dismiss":
      return { kind: "dismiss" };
    case "answer": {
      const out: HistoryEventCause & { kind: "answer" } = {
        kind: "answer",
        op: text(value["op"], "answer op", 64),
        request: int(value["request"], "answer request"),
        response: text(value["response"], "answer response", MAX_HISTORY_B64),
      };
      if (value["room"] !== undefined) out.room = int(value["room"], "answer room", 255);
      if (value["prepared"] !== undefined) out.prepared = value["prepared"] === true;
      if (value["patch"] !== undefined) out.patch = committedPatch(value["patch"]);
      return out;
    }
    case "patch":
      if (!["logic", "picture", "view", "sound"].includes(String(value["resource"])))
        fail("patch resource kind is invalid.");
      return {
        kind: "patch",
        resource: value["resource"] as HistoryPatchKind,
        num: int(value["num"], "patch num", 255),
        data: b64(value["data"], "patch data"),
      };
    case "patchMeta": {
      const out: HistoryEventCause & { kind: "patchMeta" } = { kind: "patchMeta" };
      if (value["words"] !== undefined) out.words = b64(value["words"], "words");
      if (value["object"] !== undefined) out.object = b64(value["object"], "object");
      if (value["tests"] !== undefined) out.tests = b64(value["tests"], "tests");
      return out;
    }
    case "reenter": {
      const out: HistoryEventCause & { kind: "reenter" } = { kind: "reenter" };
      if (value["room"] !== undefined) out.room = int(value["room"], "reenter room", 255);
      return out;
    }
    case "restart":
      return { kind: "restart" };
    case "pause":
      return { kind: "pause", paused: value["paused"] === true };
    case "sound":
      return { kind: "sound", enabled: value["enabled"] === true };
    case "clock":
      return { kind: "clock", ticks: int(value["ticks"], "clock ticks", 1_000_000) };
    case "device":
      return { kind: "device", device: int(value["device"], "device", 0xff) };
    case "debugWrite": {
      const pairs = (v: unknown, name: string): [number, number][] => {
        if (!Array.isArray(v) || v.length > 256) fail(`${name} must be a bounded list.`);
        return v.map((p) => {
          if (!Array.isArray(p) || p.length !== 2) fail(`${name} entries must be pairs.`);
          return [int(p[0], name, 0xff), int(p[1], name, 0xff)];
        });
      };
      return {
        kind: "debugWrite",
        vars: pairs(value["vars"] ?? [], "debugWrite.vars"),
        flags: pairs(value["flags"] ?? [], "debugWrite.flags"),
      };
    }
    case "authoring": {
      const snapshot = value["snapshot"];
      if (!isObj(snapshot) || JSON.stringify(snapshot).length > 4 * 1024 * 1024)
        fail("authoring snapshot is invalid.");
      return { kind: "authoring", snapshot };
    }
    case "reseed":
      return { kind: "reseed", value: int(value["value"], "reseed value", 0xffff) };
    case "end":
      return { kind: "end", reason: text(value["reason"], "end reason", 64) as HistoryEndReason };
    default:
      fail(`unknown event cause ${String(value["kind"])}.`);
  }
}

function events(value: unknown): HistoryEvent[] {
  if (!Array.isArray(value) || value.length > MAX_HISTORY_EVENTS)
    fail("events must be a bounded list.");
  return value.map((e) => {
    if (!isObj(e)) fail("event must be an object.");
    return {
      seq: int(e["seq"], "event seq"),
      tick: int(e["tick"], "event tick"),
      cycle: int(e["cycle"], "event cycle"),
      cause: eventCause(e["cause"]),
    };
  });
}

function roomMarks(value: unknown): HistoryRoomMark[] {
  if (!Array.isArray(value) || value.length > 1_000_000) fail("marks must be a bounded list.");
  return value.map((m) => {
    if (!isObj(m)) fail("mark must be an object.");
    const out: HistoryRoomMark = {
      seq: int(m["seq"], "mark seq"),
      tick: int(m["tick"], "mark tick"),
      cycle: int(m["cycle"], "mark cycle"),
      room: int(m["room"], "mark room", 255),
      via: text(m["via"], "mark via", 64),
    };
    if (m["edge"] !== undefined) out.edge = text(m["edge"], "mark edge", 16);
    return out;
  });
}

function syncMarks(value: unknown): HistorySyncMark[] {
  if (!Array.isArray(value) || value.length > 1_000_000) fail("sync marks must be a bounded list.");
  return value.map((m) => {
    if (!isObj(m)) fail("sync mark must be an object.");
    return {
      seq: int(m["seq"], "sync seq"),
      tick: int(m["tick"], "sync tick"),
      cycle: int(m["cycle"], "sync cycle"),
      digest: text(m["digest"], "sync digest", 64),
      room: int(m["room"], "sync room", 255),
      score: int(m["score"], "sync score", 0xffff),
      patchGeneration: int(m["patchGeneration"], "sync patchGeneration"),
      modal:
        m["modal"] === null || m["modal"] === undefined ? null : text(m["modal"], "sync modal", 64),
    };
  });
}

function fingerprint(value: unknown): HistoryFingerprint {
  if (!isObj(value)) fail("fingerprint must be an object.");
  return {
    v: int(value["v"], "fingerprint v", 0xffff),
    hash: text(value["hash"], "fingerprint hash", 64),
  };
}

function anchor(value: unknown): HistoryAnchor {
  if (!isObj(value)) fail("anchor must be an object.");
  const reason = value["reason"];
  if (!["boot", "room", "autosave", "flush", "pause", "resume"].includes(String(reason)))
    fail("anchor reason is invalid.");
  const out: HistoryAnchor = {
    seq: int(value["seq"], "anchor seq"),
    tick: int(value["tick"], "anchor tick"),
    cycle: int(value["cycle"], "anchor cycle"),
    reason: reason as HistoryAnchor["reason"],
    image: b64(value["image"], "anchor image"),
    replay: (() => {
      try {
        return validateEngineReplayState(value["replay"]);
      } catch {
        return fail("anchor.replay must be a valid engine replay state.");
      }
    })(),
    inputQueue: numberList(value["inputQueue"], "anchor inputQueue"),
    directionQueue: numberList(value["directionQueue"], "anchor directionQueue"),
    inputLines: stringList(value["inputLines"], "anchor inputLines"),
    requestSerial: int(value["requestSerial"], "anchor requestSerial"),
    rng: int(value["rng"], "anchor rng", 0xffff),
    clock: clock(value["clock"]),
    ...(value["soundRemainder"] !== undefined
      ? { soundRemainder: num(value["soundRemainder"], "anchor soundRemainder", 1000) }
      : {}),
    soundDevice: int(value["soundDevice"], "anchor soundDevice", 0xff),
    resourceSet: text(value["resourceSet"], "anchor resourceSet", MAX_HISTORY_STRING),
    patchGeneration: int(value["patchGeneration"], "anchor patchGeneration"),
  };
  if (value["fingerprint"] !== undefined) {
    out.fingerprint = fingerprint(value["fingerprint"]);
    if (historyFingerprint(historyAnchorSemantic(out)).hash !== out.fingerprint.hash)
      fail("anchor fingerprint does not match its recorded state.");
  }
  return out;
}

function boot(value: unknown): HistoryBoot {
  if (!isObj(value)) fail("boot must be an object.");
  const files = value["files"];
  if (!isObj(files) || Object.keys(files).length > 1024) fail("boot.files must be a bounded map.");
  const out: HistoryBoot = {
    files: Object.fromEntries(
      Object.entries(files).map(([name, data]) => {
        if (!/^[A-Z0-9._-]+$/i.test(name)) fail("boot file name is invalid.");
        return [name, b64(data, `boot file ${name}`)];
      }),
    ),
    dictionary: dictionary(value["dictionary"]),
    authorRooms: value["authorRooms"] === true,
    rng: int(value["rng"], "boot rng", 0xffff),
    ...(value["resumedFrom"] !== undefined
      ? {
          resumedFrom: (() => {
            const r = value["resumedFrom"];
            if (!isObj(r)) fail("boot.resumedFrom must be an object.");
            return {
              segment: text(r["segment"], "resumedFrom segment", 64),
              seq: int(r["seq"], "resumedFrom seq"),
              tick: int(r["tick"], "resumedFrom tick"),
            };
          })(),
        }
      : {}),
    soundDevice: int(value["soundDevice"], "boot soundDevice", 0xff),
    resourceSet: text(value["resourceSet"], "boot resourceSet", MAX_HISTORY_STRING),
    requestSerial: int(value["requestSerial"], "boot requestSerial"),
  };
  if (value["image"] !== undefined) out.image = b64(value["image"], "boot image");
  if (value["replay"] !== undefined) {
    try {
      out.replay = validateEngineReplayState(value["replay"]);
    } catch {
      fail("boot.replay must be a valid engine replay state.");
    }
  }
  if (value["menus"] !== undefined) out.menus = menus(value["menus"]);
  if (value["inputQueue"] !== undefined)
    out.inputQueue = numberList(value["inputQueue"], "boot inputQueue");
  if (value["directionQueue"] !== undefined)
    out.directionQueue = numberList(value["directionQueue"], "boot directionQueue");
  if (value["inputLines"] !== undefined)
    out.inputLines = stringList(value["inputLines"], "boot inputLines");
  if (value["clock"] !== undefined) out.clock = clock(value["clock"]);
  if (value["soundRemainder"] !== undefined)
    out.soundRemainder = num(value["soundRemainder"], "boot soundRemainder", 1000);
  if (value["fingerprint"] !== undefined) {
    out.fingerprint = fingerprint(value["fingerprint"]);
    if (historyFingerprint(historyBootSemantic(out)).hash !== out.fingerprint.hash)
      fail("boot fingerprint does not match its recorded state.");
  }
  return out;
}

/** Validate a standalone boot record (a retained original carried over messages). */
export function validateHistoryBoot(value: unknown): HistoryBoot {
  return boot(value);
}

/** Validate untrusted history data (a project archive's HISTORY.JSON). */
export function validateHistoryRecording(value: unknown): HistoryRecording {
  if (!isObj(value)) fail("recording must be an object.");
  if (value["version"] !== HISTORY_FORMAT_VERSION)
    fail(`unsupported version ${String(value["version"])}.`);
  const segments = value["segments"];
  if (!Array.isArray(segments) || segments.length > 4096) fail("segments must be a bounded list.");
  const rawIdentity = value["identity"];
  const rawRevision =
    isObj(rawIdentity) && typeof rawIdentity["revision"] === "string"
      ? rawIdentity["revision"].toLowerCase()
      : undefined;
  const identity = gameIdentity(
    isObj(rawIdentity) && rawRevision !== undefined
      ? { project: rawIdentity["project"], revision: rawRevision }
      : rawIdentity,
  );
  if (identity === null) fail("recording identity is invalid.");
  return {
    version: HISTORY_FORMAT_VERSION,
    identity,
    profile: text(value["profile"], "profile", 64),
    resourceSet: text(value["resourceSet"], "resourceSet", MAX_HISTORY_STRING),
    startedAt: int(value["startedAt"], "startedAt"),
    ...(value["dropped"] !== undefined ? { dropped: int(value["dropped"], "dropped") } : {}),
    segments: segments.map((s): HistorySegment => {
      if (!isObj(s)) fail("segment must be an object.");
      const segment: HistorySegment = {
        id: text(s["id"], "segment id", 64),
        boot: boot(s["boot"]),
        anchors: Array.isArray(s["anchors"])
          ? s["anchors"].map(anchor)
          : fail("anchors must be a list."),
        events: events(s["events"]),
        marks: roomMarks(s["marks"]),
        sync: syncMarks(s["sync"]),
        ...(s["clock"] !== undefined ? { clock: clockRuns(s["clock"]) } : {}),
      };
      if (s["end"] !== undefined) {
        const e = s["end"];
        if (!isObj(e)) fail("segment end must be an object.");
        const reason = e["reason"];
        if (!END_REASONS.has(reason as HistoryEndReason)) fail("end reason is invalid.");
        segment.end = {
          seq: int(e["seq"], "end seq"),
          tick: int(e["tick"], "end tick"),
          cycle: int(e["cycle"], "end cycle"),
          reason: reason as HistoryEndReason,
        };
      }
      checkSeqOrder(segment.events, "events", true);
      checkSeqOrder(segment.marks, "marks", false);
      checkSeqOrder(segment.sync, "sync marks", false);
      checkSeqOrder(segment.anchors, "anchors", false);
      return segment;
    }),
  };
}

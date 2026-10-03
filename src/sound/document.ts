/**
 * Strict, lossless in-memory native SOUND document for the cue editor.
 *
 * The authoritative layout is the four-stream AGI SOUND payload: an 8-byte
 * header of four little-endian stream offsets, then for each lane a run of
 * 5-byte records
 *
 *   duration u16le | toneLow | toneHigh | control
 *
 *   - duration word 0xffff is the lane terminator; word 0 plays 65,536 ticks.
 *   - tone lanes 0..2 hold a 10-bit divisor:
 *     toneHigh = 0x80 | lane<<5 | (divisor & 0x0f), toneLow = (divisor>>4)&0x3f,
 *     control = 0x90 | lane<<5 | attenuation (0..15; 15 is silence).
 *   - the noise lane 3 holds control 0..7 (bit 2 white/periodic, low two bits
 *     the rate, rate 3 following tone lane 2): toneHigh = 0xe0 | control with
 *     the control repeated in toneLow for early profiles that emit both bytes.
 *   - the canonical rest is a zero divisor at full silence: toneLow 0,
 *     toneHigh 0x80|lane<<5, attenuation 15.
 *
 * Documents are immutable values: every edit returns a new document and an
 * earlier document is a valid undo snapshot. Event ids are deterministic
 * (`e1`, `e2`, ... allocated in order) within a document lineage. Imported
 * payloads keep their exact bytes: records whose selector or data bits are
 * structurally valid but noncanonical decode as `raw` events (duration-only
 * editable until an explicit `replaceEventData`), and payloads that are not
 * exactly representable as four contiguous in-order streams — short headers,
 * overlaps, aliasing, gaps, trailing bytes, missing terminators, oversized
 * resources, or a profile whose family is not four-stream (PC booter register
 * rows, IIgs event/sample streams) — import as `opaque`: inspectable and
 * re-exportable byte-for-byte, never normalized or silently reinterpreted.
 *
 * Persistence is the bounded `agi.sound-document` version-1 envelope
 * ({@link SoundDocument.serialize} / {@link readSoundDocumentEnvelope}). The
 * envelope versions only this JSON container; the `payload` field carries the
 * exact native SOUND bytes, which keep their own interpreter-level format
 * untouched. The envelope adds the profile identity, the per-lane event id
 * layout and the id allocator cursor so a reopened document edits on without
 * reusing a retained or deleted id.
 */

import { PROFILES } from "../runtime/profile.ts";
import type { ProfileId } from "../runtime/profile.ts";

const HEADER_BYTES = 8;
const RECORD_BYTES = 5;
const TERMINATOR = 0xffff;
const MAX_PAYLOAD_BYTES = 65_535;
const LANE_COUNT = 4;
const NOISE_LANE = 3;
const MIN_TONE_DIVISOR = 1;
const MAX_TONE_DIVISOR = 1023;
const MIN_MIDI_NOTE = 0;
const MAX_MIDI_NOTE = 127;
const TONE_CLOCK_HZ = 99_431.67;
const DEFAULT_TICKS = 6;
const DEFAULT_TONE_DIVISOR = 226;
const DEFAULT_ATTENUATION = 4;
const DEFAULT_NOISE_CONTROL = 4;

/** The persisted envelope's format marker. */
export const SOUND_DOCUMENT_FORMAT = "agi.sound-document";
const ENVELOPE_FIELDS = [
  "format",
  "version",
  "profileId",
  "payload",
  "eventIds",
  "nextEventId",
] as const;
/** Event ids are `e` + a canonical decimal integer; the allocator never pads. */
const EVENT_ID_PATTERN = /^e[1-9][0-9]*$/;
/** `e` plus the 16 digits of Number.MAX_SAFE_INTEGER bounds any valid id. */
const EVENT_ID_MAX_LENGTH = 17;

const NOTE_NAME_SEMITONES: Record<string, number> = {
  c: 0,
  "c#": 1,
  db: 1,
  d: 2,
  "d#": 3,
  eb: 3,
  e: 4,
  f: 5,
  "f#": 6,
  gb: 6,
  g: 7,
  "g#": 8,
  ab: 8,
  a: 9,
  "a#": 10,
  bb: 10,
  b: 11,
};
const NOTE_NAME_PATTERN = /^([a-g][#b]?)(-?\d+)$/;
const MIDI_NUMBER_PATTERN = /^[+-]?\d+$/;

export type SoundDocumentErrorCode =
  | "unknown-profile"
  | "unsupported-family"
  | "opaque"
  | "invalid-lane"
  | "invalid-index"
  | "unknown-event"
  | "invalid-value"
  | "invalid-field"
  | "lane-kind"
  | "raw-field"
  | "duration-not-representable"
  | "resource-too-large"
  | "unsupported-format"
  | "unsupported-version"
  | "invalid-envelope"
  | "ids-exhausted";

/** A rejected edit or import option; `code` is stable for programmatic handling. */
export class SoundDocumentError extends Error {
  readonly code: SoundDocumentErrorCode;

  constructor(code: SoundDocumentErrorCode, message: string) {
    super(message);
    this.name = "SoundDocumentError";
    this.code = code;
  }
}

/**
 * Decoded event content. `raw` preserves the three data bytes of a
 * noncanonical but structurally valid record exactly.
 */
type SoundEventData =
  | { readonly kind: "tone"; readonly divisor: number; readonly attenuation: number }
  | { readonly kind: "noise"; readonly control: number; readonly attenuation: number }
  | { readonly kind: "rest" }
  | {
      readonly kind: "raw";
      readonly toneLow: number;
      readonly toneHigh: number;
      readonly control: number;
    };

export interface SoundEvent {
  /** Deterministic per-document id, stable across edits of other events. */
  readonly id: string;
  /** Stream lane 0..3 (0..2 tone, 3 noise). */
  readonly lane: number;
  /** The stored duration word: 1..65534, or 0 encoding 65,536 ticks. */
  readonly durationWord: number;
  /** The event's length in sound ticks; duration word 0 counts as 65,536. */
  readonly durationTicks: number;
  readonly data: SoundEventData;
}

/** Event content for inserts and explicit replacements. */
export type SoundEventDataInput =
  | {
      readonly kind: "tone";
      /** 10-bit divisor 1..1023; mutually exclusive with `note`. */
      readonly divisor?: number;
      /**
       * Input aid only: a full note name ("A4", "F#3", "Bb2") or an integer
       * MIDI number 0..127, as a number or fully numeric string. The pitch
       * must map into the divisor range 1..1023; the integer divisor is
       * stored, never the aid.
       */
      readonly note?: string | number;
      readonly attenuation?: number;
    }
  | { readonly kind: "noise"; readonly control?: number; readonly attenuation?: number }
  | { readonly kind: "rest" }
  | {
      readonly kind: "raw";
      readonly toneLow: number;
      readonly toneHigh: number;
      readonly control: number;
    };

export interface SoundEventInput {
  readonly ticks?: number;
  readonly data?: SoundEventDataInput;
}

/**
 * Field-level edit. `ticks` applies to every kind. `divisor`/`note`/
 * `attenuation` apply to tone events, `control`/`attenuation` to noise
 * events; other fields, and any field on a `rest` or `raw` event, are
 * rejected — changing kind or canonicalizing raw bytes is the explicit
 * `replaceEventData` operation.
 */
export interface SoundEventEdit {
  readonly ticks?: number;
  readonly divisor?: number;
  readonly note?: string | number;
  readonly attenuation?: number;
  readonly control?: number;
}

/** The payload family the selected profile's interpreter actually reads. */
export type SoundFamily = "four-stream" | "booter-2.001" | "iigs";

/**
 * The bounded persisted form of a document: a plain JSON-safe structure with
 * fields in this order so `JSON.stringify` output is byte-stable.
 *
 * `version` governs the envelope only. `payload` is the document's exact
 * native SOUND bytes — the same buffer `encode()` returns — which have their
 * own interpreter-level layout and are never re-encoded by the container.
 * `eventIds` lists each editable lane's ids in order (`null` for an opaque
 * document, which invents no editable tracks), and `nextEventId` preserves
 * the allocator cursor including deletion gaps.
 */
export interface SoundDocumentEnvelope {
  readonly format: typeof SOUND_DOCUMENT_FORMAT;
  readonly version: 1;
  readonly profileId: ProfileId;
  readonly payload: readonly number[];
  readonly eventIds: readonly (readonly string[])[] | null;
  readonly nextEventId: number;
}

interface StoredEvent {
  readonly id: string;
  readonly durationWord: number;
  readonly toneLow: number;
  readonly toneHigh: number;
  readonly control: number;
}

interface DocumentState {
  readonly profileId: ProfileId;
  readonly family: SoundFamily;
  readonly representation: "four-stream" | "opaque";
  readonly tracks: readonly (readonly StoredEvent[])[] | null;
  /** Retained source bytes for opaque documents; owned copy. */
  readonly payload: Uint8Array | null;
  readonly diagnostics: readonly string[];
  readonly nextId: number;
}

function fail(code: SoundDocumentErrorCode, message: string): never {
  throw new SoundDocumentError(code, message);
}

function integerIn(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return fail("invalid-value", `${label} must be an integer in ${min}..${max}.`);
  }
  return value;
}

/** The stored duration word for a tick count; 65,535 is the terminator. */
function durationWordOf(ticks: number, label: string): number {
  if (typeof ticks !== "number" || !Number.isInteger(ticks)) {
    return fail("invalid-value", `${label} must be an integer tick count.`);
  }
  if (ticks === 65535) {
    return fail(
      "duration-not-representable",
      "65,535 ticks collides with the 0xffff stream terminator and cannot be one event. " +
        "Split it into shorter events (for example 65,534 + 1 tick) or retrigger the note; " +
        "be aware a split restarts the profile's per-note envelope.",
    );
  }
  if (ticks < 1 || ticks > 65536) {
    return fail("invalid-value", `${label} must be an integer in 1..65536 ticks.`);
  }
  return ticks === 65536 ? 0 : ticks;
}

function ticksOf(durationWord: number): number {
  return durationWord === 0 ? 65536 : durationWord;
}

function byte(value: unknown, label: string): number {
  return integerIn(value, label, 0, 255);
}

/**
 * The strict note-entry grammar: an integral MIDI number in 0..127, given as
 * a number or a fully numeric string, or a complete note name such as "A4",
 * "F#3" or "Bb2" (optionally a negative octave). Unlike the legacy builder
 * aid, nothing is rounded or prefix-parsed — 69.25, "69.25", "69junk" and
 * "1e2" are invalid input, and rest words are not pitches.
 */
function strictNoteToMidi(note: string | number): number {
  const outsideMidiRange = () =>
    fail(
      "invalid-value",
      `Note '${String(note)}' is outside the MIDI range ${MIN_MIDI_NOTE}..${MAX_MIDI_NOTE}.`,
    );
  if (typeof note === "number") {
    if (!Number.isInteger(note)) {
      return fail(
        "invalid-value",
        `Note ${note} must be an integer MIDI number or a full note name like "A4".`,
      );
    }
    if (note < MIN_MIDI_NOTE || note > MAX_MIDI_NOTE) return outsideMidiRange();
    return note;
  }
  if (typeof note !== "string") {
    return fail(
      "invalid-value",
      `A note must be an integer MIDI number or a full note name like "A4".`,
    );
  }
  const text = note.trim().toLowerCase();
  const named = NOTE_NAME_PATTERN.exec(text);
  if (named !== null) {
    const semitone = NOTE_NAME_SEMITONES[named[1]!];
    const midi = (Number.parseInt(named[2]!, 10) + 1) * 12 + semitone!;
    if (midi < MIN_MIDI_NOTE || midi > MAX_MIDI_NOTE) return outsideMidiRange();
    return midi;
  }
  if (MIDI_NUMBER_PATTERN.test(text)) {
    const midi = Number.parseInt(text, 10);
    if (midi < MIN_MIDI_NOTE || midi > MAX_MIDI_NOTE) return outsideMidiRange();
    return midi;
  }
  return fail(
    "invalid-value",
    `Unrecognized note '${note}'; use a full note name like "A4", an integer MIDI number, ` +
      `or a rest event for silence.`,
  );
}

/**
 * Nearest representable 10-bit divisor for a strict note input. The requested
 * pitch is checked against the native divisor range before quantization: a
 * note whose ideal divisor falls outside 1..1023 is rejected, never clamped
 * to a different note.
 */
function toneDivisorOfNote(note: string | number): number {
  const midi = strictNoteToMidi(note);
  const frequency = 440 * Math.pow(2, (midi - 69) / 12);
  const ideal = TONE_CLOCK_HZ / frequency;
  if (ideal < MIN_TONE_DIVISOR || ideal > MAX_TONE_DIVISOR) {
    return fail(
      "invalid-value",
      `Note '${String(note)}' needs tone divisor ~${Math.round(ideal)}, outside the native ` +
        `${MIN_TONE_DIVISOR}..${MAX_TONE_DIVISOR} range; the pitch is not representable.`,
    );
  }
  return Math.round(ideal);
}

function rejectKeys(value: object, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      return fail("invalid-value", `${label} has no field '${key}'.`);
    }
  }
}

function profileOrFail(profileId: ProfileId): (typeof PROFILES)[ProfileId] {
  const profile = PROFILES[profileId];
  if (profile === undefined) {
    return fail("unknown-profile", `Unknown interpreter profile '${String(profileId)}'.`);
  }
  return profile;
}

/** The payload family a profile's sound driver consumes. */
function familyOf(profileId: ProfileId): SoundFamily {
  const sound = profileOrFail(profileId).sound;
  if (sound === "booter-2.001") return "booter-2.001";
  if (sound === "iigs") return "iigs";
  return "four-stream";
}

/** Canonical bytes for event data on a lane, or a failure. */
function encodeData(
  lane: number,
  data: SoundEventDataInput,
): { toneLow: number; toneHigh: number; control: number } {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return fail("invalid-value", "Event data must be an object.");
  }
  switch (data.kind) {
    case "tone": {
      if (lane === NOISE_LANE) {
        return fail("lane-kind", "A tone event belongs on lanes 0..2; lane 3 is the noise lane.");
      }
      rejectKeys(data, ["kind", "divisor", "note", "attenuation"], "Tone event");
      if (data.divisor !== undefined && data.note !== undefined) {
        return fail("invalid-value", "Give either 'divisor' or the 'note' input aid, not both.");
      }
      let divisor = data.divisor;
      if (divisor === undefined && data.note !== undefined) {
        divisor = toneDivisorOfNote(data.note);
      }
      divisor ??= DEFAULT_TONE_DIVISOR;
      integerIn(divisor, "Tone divisor", MIN_TONE_DIVISOR, MAX_TONE_DIVISOR);
      const attenuation = integerIn(data.attenuation ?? DEFAULT_ATTENUATION, "Attenuation", 0, 15);
      return {
        toneLow: (divisor >> 4) & 0x3f,
        toneHigh: 0x80 | (lane << 5) | (divisor & 0x0f),
        control: 0x90 | (lane << 5) | attenuation,
      };
    }
    case "noise": {
      if (lane !== NOISE_LANE) {
        return fail("lane-kind", "A noise event belongs on lane 3; lanes 0..2 are tone lanes.");
      }
      rejectKeys(data, ["kind", "control", "attenuation"], "Noise event");
      const control = integerIn(data.control ?? DEFAULT_NOISE_CONTROL, "Noise control", 0, 7);
      const attenuation = integerIn(data.attenuation ?? DEFAULT_ATTENUATION, "Attenuation", 0, 15);
      return { toneLow: control, toneHigh: 0xe0 | control, control: 0xf0 | attenuation };
    }
    case "rest": {
      rejectKeys(data, ["kind"], "Rest event");
      return { toneLow: 0, toneHigh: 0x80 | (lane << 5), control: 0x9f | (lane << 5) };
    }
    case "raw": {
      rejectKeys(data, ["kind", "toneLow", "toneHigh", "control"], "Raw event");
      return {
        toneLow: byte(data.toneLow, "Raw tone-low byte"),
        toneHigh: byte(data.toneHigh, "Raw tone-high byte"),
        control: byte(data.control, "Raw control byte"),
      };
    }
    default:
      return fail("invalid-value", "Unknown sound event kind.");
  }
}

/** The editable view of a stored record on its lane. */
function classify(
  lane: number,
  toneLow: number,
  toneHigh: number,
  control: number,
): SoundEventData {
  const attenuation = control & 15;
  if (toneLow === 0 && toneHigh === (0x80 | (lane << 5)) && control === (0x9f | (lane << 5))) {
    return { kind: "rest" };
  }
  if (lane < NOISE_LANE) {
    const latch = 0x80 | (lane << 5);
    if (
      (toneHigh & 0xf0) === latch &&
      (toneLow & 0xc0) === 0 &&
      (control & 0xf0) === (0x90 | (lane << 5))
    ) {
      const divisor = ((toneLow & 0x3f) << 4) | (toneHigh & 0x0f);
      if (divisor >= 1) return { kind: "tone", divisor, attenuation };
    }
  } else if (
    (toneHigh & 0xf8) === 0xe0 &&
    (control & 0xf0) === 0xf0 &&
    toneLow === (toneHigh & 0x0f)
  ) {
    return { kind: "noise", control: toneHigh & 0x0f, attenuation };
  }
  return { kind: "raw", toneLow, toneHigh, control };
}

function viewEvent(lane: number, stored: StoredEvent): SoundEvent {
  return Object.freeze({
    id: stored.id,
    lane,
    durationWord: stored.durationWord,
    durationTicks: ticksOf(stored.durationWord),
    data: Object.freeze(classify(lane, stored.toneLow, stored.toneHigh, stored.control)),
  });
}

/**
 * Strictly decode a four-stream payload: contiguous streams in lane order
 * tiling [8, length), each a run of complete 5-byte records ended by the
 * 0xffff terminator. Anything else is a diagnostic, not a document.
 */
function decodeFourStream(
  payload: Uint8Array,
): { tracks: StoredEvent[][]; diagnostics: string[] } | { error: string } {
  if (payload.length > MAX_PAYLOAD_BYTES) {
    return { error: `the payload is ${payload.length} bytes, over the 65,535-byte resource bound` };
  }
  if (payload.length < HEADER_BYTES) {
    return {
      error: `the payload is ${payload.length} bytes, shorter than the 8-byte offset header`,
    };
  }
  const offsets: number[] = [];
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const offset = payload[lane * 2]! | (payload[lane * 2 + 1]! << 8);
    if (offset < HEADER_BYTES) {
      return { error: `lane ${lane} offset ${offset} lies inside the 8-byte header` };
    }
    if (offset + 2 > payload.length) {
      return {
        error: `lane ${lane} offset ${offset} leaves no room for the 0xffff terminator in a ${payload.length}-byte payload`,
      };
    }
    offsets.push(offset);
  }

  const tracks: StoredEvent[][] = [];
  const ends: number[] = [];
  let nextId = 0;
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const events: StoredEvent[] = [];
    let cursor = offsets[lane]!;
    for (;;) {
      const duration = payload[cursor]! | (payload[cursor + 1]! << 8);
      if (duration === TERMINATOR) {
        ends.push(cursor + 2);
        break;
      }
      if (cursor + RECORD_BYTES > payload.length) {
        return {
          error: `lane ${lane} has a truncated event record at byte ${cursor}`,
        };
      }
      events.push({
        id: `e${++nextId}`,
        durationWord: duration,
        toneLow: payload[cursor + 2]!,
        toneHigh: payload[cursor + 3]!,
        control: payload[cursor + 4]!,
      });
      cursor += RECORD_BYTES;
    }
    tracks.push(events);
  }

  if (
    offsets[0] !== HEADER_BYTES ||
    offsets[1] !== ends[0] ||
    offsets[2] !== ends[1] ||
    offsets[3] !== ends[2] ||
    ends[3] !== payload.length
  ) {
    return {
      error:
        "the four stream regions do not tile the payload contiguously in lane order " +
        "(overlap, aliasing, gaps or trailing bytes are preserved opaque instead)",
    };
  }

  const diagnostics: string[] = [];
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    tracks[lane]!.forEach((event, index) => {
      if (classify(lane, event.toneLow, event.toneHigh, event.control).kind === "raw") {
        diagnostics.push(
          `lane ${lane} event ${index} keeps noncanonical data bytes as a raw event; ` +
            "only its duration is editable unless it is explicitly replaced.",
        );
      }
    });
  }
  return { tracks, diagnostics };
}

export class SoundDocument {
  private readonly state: DocumentState;

  /**
   * @internal Construct through {@link createSoundDocument} /
   * {@link importSoundDocument}; the state argument is module-private.
   */
  constructor(state: DocumentState) {
    this.state = state;
  }

  /** The interpreter profile identity this document was created or imported under. */
  get profileId(): ProfileId {
    return this.state.profileId;
  }

  /** The payload family the profile's driver consumes. */
  get family(): SoundFamily {
    return this.state.family;
  }

  /** `four-stream` when losslessly editable, `opaque` for retained bytes. */
  get representation(): "four-stream" | "opaque" {
    return this.state.representation;
  }

  /** Why an import is opaque, and which events were retained as raw. */
  get diagnostics(): readonly string[] {
    return this.state.diagnostics;
  }

  /** The four editable lanes, or null for an opaque document. */
  tracks(): readonly (readonly SoundEvent[])[] | null {
    if (this.state.tracks === null) return null;
    return this.state.tracks.map((lane, index) =>
      Object.freeze(lane.map((event) => viewEvent(index, event))),
    );
  }

  /** One event by id, or undefined. */
  event(id: string): SoundEvent | undefined {
    if (this.state.tracks === null) return undefined;
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const found = this.state.tracks[lane]!.find((event) => event.id === id);
      if (found !== undefined) return viewEvent(lane, found);
    }
    return undefined;
  }

  /** Longest lane's length in ticks; null for an opaque document. */
  extentTicks(): number | null {
    if (this.state.tracks === null) return null;
    let extent = 0;
    for (const lane of this.state.tracks) {
      let ticks = 0;
      for (const event of lane) ticks += ticksOf(event.durationWord);
      if (ticks > extent) extent = ticks;
    }
    return extent;
  }

  /** One lane's length in ticks. */
  trackExtentTicks(lane: number): number {
    const stored = this.requireLane(lane);
    let ticks = 0;
    for (const event of stored) ticks += ticksOf(event.durationWord);
    return ticks;
  }

  /** The native payload; the untouched original for an opaque document. */
  encode(): Uint8Array {
    if (this.state.tracks === null) return new Uint8Array(this.state.payload!);
    const total =
      HEADER_BYTES +
      this.state.tracks.reduce((sum, lane) => sum + lane.length * RECORD_BYTES + 2, 0);
    const out = new Uint8Array(total);
    let offset = HEADER_BYTES;
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      out[lane * 2] = offset & 0xff;
      out[lane * 2 + 1] = (offset >> 8) & 0xff;
      for (const event of this.state.tracks[lane]!) {
        out[offset++] = event.durationWord & 0xff;
        out[offset++] = (event.durationWord >> 8) & 0xff;
        out[offset++] = event.toneLow;
        out[offset++] = event.toneHigh;
        out[offset++] = event.control;
      }
      out[offset++] = 0xff;
      out[offset++] = 0xff;
    }
    return out;
  }

  /**
   * The bounded `agi.sound-document` version-1 envelope for persistence.
   *
   * `payload` carries the exact native bytes (the same buffer `encode()`
   * returns, including a retained opaque payload) — this is a container, not
   * an alternative note compiler. A document whose payload exceeds the
   * 65,535-byte resource bound — possible only for an oversized opaque
   * import — is refused rather than truncated: it may continue losslessly in
   * memory, but this bounded form cannot express it. The result is a frozen
   * JSON-safe structure that shares no mutable state with the document.
   */
  serialize(): SoundDocumentEnvelope {
    const payload = this.encode();
    if (payload.length > MAX_PAYLOAD_BYTES) {
      return fail(
        "resource-too-large",
        `The document's ${payload.length}-byte payload exceeds the 65,535-byte bound ` +
          "of the persisted envelope; the oversized document stays lossless in memory " +
          "but cannot be written in this bounded form.",
      );
    }
    const tracks = this.state.tracks;
    return Object.freeze({
      format: SOUND_DOCUMENT_FORMAT,
      version: 1,
      profileId: this.state.profileId,
      payload: Object.freeze(Array.from(payload)),
      eventIds:
        tracks === null
          ? null
          : Object.freeze(tracks.map((lane) => Object.freeze(lane.map((event) => event.id)))),
      nextEventId: this.state.nextId,
    });
  }

  /** Insert an event; defaults are 6 ticks and a lane-appropriate record. */
  insertEvent(lane: number, index: number, input?: SoundEventInput): SoundDocument {
    const stored = this.requireLane(lane);
    if (
      input !== undefined &&
      (typeof input !== "object" || input === null || Array.isArray(input))
    ) {
      return fail("invalid-value", "Event input must be an object.");
    }
    if (input !== undefined) rejectKeys(input, ["ticks", "data"], "Event input");
    if (!Number.isInteger(index) || index < 0 || index > stored.length) {
      return fail("invalid-index", `Insert index must be an integer in 0..${stored.length}.`);
    }
    const durationWord = durationWordOf(input?.ticks ?? DEFAULT_TICKS, "Event duration");
    const data = encodeData(
      lane,
      input?.data ?? (lane === NOISE_LANE ? { kind: "noise" } : { kind: "tone" }),
    );
    const event: StoredEvent = { id: `e${this.state.nextId}`, durationWord, ...data };
    const next = Object.freeze([...stored.slice(0, index), event, ...stored.slice(index)]);
    return this.derive(this.replaceLane(lane, next), 1);
  }

  /** Field-level edit of a tone or noise event, or any event's duration. */
  updateEvent(id: string, edit: SoundEventEdit): SoundDocument {
    const located = this.requireEvent(id);
    if (edit === null || typeof edit !== "object" || Array.isArray(edit)) {
      return fail("invalid-value", "Event edit must be an object.");
    }
    const keys = ["ticks", "divisor", "note", "attenuation", "control"] as const;
    rejectKeys(edit, keys, "Event edit");
    let fields = 0;
    for (const key of keys) if (edit[key] !== undefined) fields++;
    if (fields === 0) return fail("invalid-value", "Event edit names no field.");

    const current = located.event.data;
    const touched =
      edit.divisor !== undefined ||
      edit.note !== undefined ||
      edit.attenuation !== undefined ||
      edit.control !== undefined;
    let data: SoundEventDataInput | undefined;
    if (current.kind === "raw") {
      if (touched) {
        return fail(
          "raw-field",
          "Raw event fields are not safely interpretable; replace the event data explicitly with replaceEventData.",
        );
      }
    } else if (current.kind === "rest") {
      if (touched) {
        return fail(
          "invalid-field",
          "A rest has no pitch or attenuation fields; replace it with replaceEventData.",
        );
      }
    } else if (current.kind === "tone") {
      if (edit.control !== undefined) {
        return fail("invalid-field", "A tone event has no noise 'control' field.");
      }
      data = {
        kind: "tone",
        ...(edit.divisor !== undefined
          ? { divisor: edit.divisor }
          : edit.note === undefined
            ? { divisor: current.divisor }
            : {}),
        ...(edit.note !== undefined ? { note: edit.note } : {}),
        attenuation: edit.attenuation ?? current.attenuation,
      };
    } else {
      if (edit.divisor !== undefined || edit.note !== undefined) {
        return fail("invalid-field", "A noise event has no pitch fields.");
      }
      data = {
        kind: "noise",
        control: edit.control ?? current.control,
        attenuation: edit.attenuation ?? current.attenuation,
      };
    }

    const durationWord =
      edit.ticks === undefined
        ? located.stored.durationWord
        : durationWordOf(edit.ticks, "Event duration");
    const bytes =
      data === undefined
        ? {
            toneLow: located.stored.toneLow,
            toneHigh: located.stored.toneHigh,
            control: located.stored.control,
          }
        : encodeData(located.lane, data);
    const next: StoredEvent = { ...located.stored, durationWord, ...bytes };
    return this.replaceStored(located, next);
  }

  /**
   * Explicitly replace an event's data — the way a raw record becomes a
   * canonical event, or a kind changes within the lane's capability.
   */
  replaceEventData(id: string, data: SoundEventDataInput): SoundDocument {
    const located = this.requireEvent(id);
    const next: StoredEvent = { ...located.stored, ...encodeData(located.lane, data) };
    return this.replaceStored(located, next);
  }

  /** Copy an event right after itself with a fresh id. */
  duplicateEvent(id: string): SoundDocument {
    const located = this.requireEvent(id);
    const copy: StoredEvent = { ...located.stored, id: `e${this.state.nextId}` };
    const lane = this.state.tracks![located.lane]!;
    const next = Object.freeze([
      ...lane.slice(0, located.index + 1),
      copy,
      ...lane.slice(located.index + 1),
    ]);
    return this.derive(this.replaceLane(located.lane, next), 1);
  }

  /** Remove one event. */
  removeEvent(id: string): SoundDocument {
    const located = this.requireEvent(id);
    const lane = this.state.tracks![located.lane]!;
    const next = Object.freeze([...lane.slice(0, located.index), ...lane.slice(located.index + 1)]);
    return this.derive(this.replaceLane(located.lane, next), 0);
  }

  private requireLane(lane: number): readonly StoredEvent[] {
    if (this.state.tracks === null) {
      return fail(
        "opaque",
        "This document is an opaque retained payload; it can be inspected and exported, not edited.",
      );
    }
    if (!Number.isInteger(lane) || lane < 0 || lane >= LANE_COUNT) {
      return fail("invalid-lane", `Lane must be an integer in 0..${LANE_COUNT - 1}.`);
    }
    return this.state.tracks[lane]!;
  }

  private requireEvent(id: string): {
    lane: number;
    index: number;
    stored: StoredEvent;
    event: SoundEvent;
  } {
    if (this.state.tracks === null) {
      return fail(
        "opaque",
        "This document is an opaque retained payload; it can be inspected and exported, not edited.",
      );
    }
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const index = this.state.tracks[lane]!.findIndex((event) => event.id === id);
      if (index >= 0) {
        const stored = this.state.tracks[lane]![index]!;
        return { lane, index, stored, event: viewEvent(lane, stored) };
      }
    }
    return fail("unknown-event", `No sound event '${String(id)}' in this document.`);
  }

  private replaceLane(
    lane: number,
    events: readonly StoredEvent[],
  ): readonly (readonly StoredEvent[])[] {
    const tracks = this.state.tracks!;
    return [...tracks.slice(0, lane), events, ...tracks.slice(lane + 1)];
  }

  private replaceStored(
    located: { lane: number; index: number },
    event: StoredEvent,
  ): SoundDocument {
    const lane = this.state.tracks![located.lane]!;
    const next = Object.freeze([
      ...lane.slice(0, located.index),
      event,
      ...lane.slice(located.index + 1),
    ]);
    return this.derive(this.replaceLane(located.lane, next), 0);
  }

  /** A new document over edited lanes, after the allocator and resource-size bounds. */
  private derive(tracks: readonly (readonly StoredEvent[])[], addedIds: number): SoundDocument {
    const nextId = this.state.nextId + addedIds;
    if (!Number.isSafeInteger(nextId)) {
      return fail(
        "ids-exhausted",
        "The event id allocator is exhausted; the document stays readable but accepts no new events.",
      );
    }
    const total =
      HEADER_BYTES + tracks.reduce((sum, lane) => sum + lane.length * RECORD_BYTES + 2, 0);
    if (total > MAX_PAYLOAD_BYTES) {
      return fail(
        "resource-too-large",
        `The edit needs ${total} bytes, over the 65,535-byte resource bound; shorten or split the cue.`,
      );
    }
    return new SoundDocument({
      ...this.state,
      representation: "four-stream",
      tracks: tracks.map((lane) => Object.freeze([...lane])),
      payload: null,
      nextId,
    });
  }
}

/** A new blank four-stream document (four terminated empty streams). */
export function createSoundDocument(options?: { profileId?: ProfileId }): SoundDocument {
  const profileId = options?.profileId ?? "2.936";
  const family = familyOf(profileId);
  if (family !== "four-stream") {
    return fail(
      "unsupported-family",
      `Profile '${profileId}' plays the ${family} sound family, which has no editable four-stream document.`,
    );
  }
  return new SoundDocument({
    profileId,
    family,
    representation: "four-stream",
    tracks: [[], [], [], []].map((lane) => Object.freeze(lane)),
    payload: null,
    diagnostics: Object.freeze([]),
    nextId: 1,
  });
}

/**
 * Import a native SOUND payload under an explicit, verified profile identity.
 * The family comes from the profile — booter register-row and IIgs payloads
 * are never guessed as four-stream — and a payload that is not exactly the
 * strict four-stream layout is retained as an opaque document: inspectable
 * through `diagnostics`/`encode`, byte-for-byte exportable, never normalized.
 */
export function importSoundDocument(
  payload: Uint8Array,
  options: { profileId: ProfileId },
): SoundDocument {
  if (!(payload instanceof Uint8Array)) {
    return fail("invalid-value", "Sound payload must be a Uint8Array.");
  }
  return new SoundDocument(importState(payload, options?.profileId));
}

/**
 * The one import path: family from the verified profile, then the strict
 * four-stream decode. Also used by the envelope reader, so a persisted
 * payload is classified by the real decoder, never a second one.
 */
function importState(payload: Uint8Array, profileId: ProfileId): DocumentState {
  const family = familyOf(profileId);
  const owned = new Uint8Array(payload);
  if (family !== "four-stream") {
    return {
      profileId,
      family,
      representation: "opaque",
      tracks: null,
      payload: owned,
      diagnostics: Object.freeze([
        `Profile '${profileId}' plays the ${family} sound family, not the editable four-stream layout; ` +
          "the payload is retained byte-exact for inspection and export.",
      ]),
      nextId: 1,
    };
  }
  const decoded = decodeFourStream(owned);
  if ("error" in decoded) {
    return {
      profileId,
      family,
      representation: "opaque",
      tracks: null,
      payload: owned,
      diagnostics: Object.freeze([
        `Not a strict four-stream SOUND payload: ${decoded.error}. ` +
          "The payload is retained byte-exact for inspection and export.",
      ]),
      nextId: 1,
    };
  }
  return {
    profileId,
    family,
    representation: "four-stream",
    tracks: decoded.tracks.map((lane) => Object.freeze(lane)),
    payload: null,
    diagnostics: Object.freeze(decoded.diagnostics),
    nextId: 1 + decoded.tracks.reduce((sum, lane) => sum + lane.length, 0),
  };
}

function envelopeObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("invalid-envelope", "A sound document envelope must be an object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    return fail("invalid-envelope", "A sound document envelope must be a plain object.");
  }
  return value as Record<string, unknown>;
}

/**
 * Validate a serialized `agi.sound-document` version-1 envelope and rebuild
 * the document. Format and version identify the container before any field
 * is read; every field set is exact and all bounds (payload ≤ 65,535 bytes,
 * exactly four id lanes, per-lane counts bounded by what the payload can
 * physically hold) hold before a single byte value or id string is examined
 * or any output allocated. The stored profile identity is used verbatim —
 * the payload is then classified by the same strict import path as a native
 * import, so an envelope that claims an editable document over opaque bytes
 * (or the reverse) is a mismatch, not a reinterpretation. For an editable
 * document the persisted ids replace the freshly decoded ones positionally
 * and the stored allocator cursor is restored; for an opaque document the
 * retained bytes and cursor carry over untouched.
 */
export function readSoundDocumentEnvelope(value: unknown): SoundDocument {
  const envelope = envelopeObject(value);
  if (envelope["format"] !== SOUND_DOCUMENT_FORMAT) {
    return fail(
      "unsupported-format",
      `Unsupported sound document format '${String(envelope["format"])}' (expected '${SOUND_DOCUMENT_FORMAT}').`,
    );
  }
  if (envelope["version"] !== 1) {
    return fail(
      "unsupported-version",
      `Unsupported sound document envelope version ${String(envelope["version"])} (expected 1).`,
    );
  }
  if (
    Object.keys(envelope).length !== ENVELOPE_FIELDS.length ||
    ENVELOPE_FIELDS.some((name) => !Object.hasOwn(envelope, name))
  ) {
    return fail(
      "invalid-envelope",
      `A sound document envelope must have exactly the fields ${ENVELOPE_FIELDS.join(", ")}.`,
    );
  }

  const profileField = envelope["profileId"];
  if (typeof profileField !== "string") {
    return fail("invalid-envelope", "Envelope 'profileId' must be a profile id string.");
  }
  if (!Object.hasOwn(PROFILES, profileField)) {
    return fail(
      "unknown-profile",
      `Envelope 'profileId' is not a known profile: '${profileField}'.`,
    );
  }
  const profileId = profileField as ProfileId;

  const nextEventId = envelope["nextEventId"];
  if (typeof nextEventId !== "number" || !Number.isSafeInteger(nextEventId) || nextEventId < 1) {
    return fail("invalid-envelope", "Envelope 'nextEventId' must be a safe integer of at least 1.");
  }

  const payloadField = envelope["payload"];
  if (!Array.isArray(payloadField)) {
    return fail("invalid-envelope", "Envelope 'payload' must be an array of byte values.");
  }
  if (payloadField.length > MAX_PAYLOAD_BYTES) {
    return fail(
      "resource-too-large",
      `Envelope 'payload' is ${payloadField.length} bytes, over the 65,535-byte bound.`,
    );
  }
  const bytes = new Uint8Array(payloadField.length);
  for (let index = 0; index < payloadField.length; index++) {
    const value = payloadField[index];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
      return fail(
        "invalid-envelope",
        `Envelope 'payload' byte ${index} must be an integer in 0..255.`,
      );
    }
    bytes[index] = value;
  }

  // `null` claims an opaque document; an array claims an editable one with
  // exactly four lanes. Anything else is malformed.
  const eventIdsField = envelope["eventIds"];
  let eventIds: string[][] | null = null;
  if (eventIdsField !== null) {
    if (!Array.isArray(eventIdsField) || eventIdsField.length !== LANE_COUNT) {
      return fail(
        "invalid-envelope",
        `Envelope 'eventIds' must be null or an array of exactly ${LANE_COUNT} lane id lists.`,
      );
    }
    // A 5-byte record per event bounds any lane's ids by the payload size.
    const maxLaneEvents = Math.floor(bytes.length / RECORD_BYTES);
    const seen = new Set<string>();
    eventIds = [];
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const laneField = eventIdsField[lane];
      if (!Array.isArray(laneField) || laneField.length > maxLaneEvents) {
        return fail(
          "invalid-envelope",
          `Envelope 'eventIds' lane ${lane} must be an array of at most ${maxLaneEvents} ids for this payload.`,
        );
      }
      const laneIds: string[] = [];
      for (const id of laneField) {
        if (
          typeof id !== "string" ||
          id.length > EVENT_ID_MAX_LENGTH ||
          !EVENT_ID_PATTERN.test(id)
        ) {
          return fail(
            "invalid-envelope",
            `Envelope 'eventIds' lane ${lane} holds a malformed event id.`,
          );
        }
        const ordinal = Number.parseInt(id.slice(1), 10);
        if (!Number.isSafeInteger(ordinal) || ordinal >= nextEventId) {
          return fail(
            "invalid-envelope",
            `Event id '${id}' is outside the allocator range below nextEventId ${nextEventId}.`,
          );
        }
        if (seen.has(id)) {
          return fail("invalid-envelope", `Duplicate event id '${id}' in envelope 'eventIds'.`);
        }
        seen.add(id);
        laneIds.push(id);
      }
      eventIds.push(laneIds);
    }
  }

  const state = importState(bytes, profileId);
  if (eventIds === null) {
    if (state.representation !== "opaque") {
      return fail(
        "invalid-envelope",
        "Envelope 'eventIds' is null but the payload decodes as an editable four-stream document.",
      );
    }
    return new SoundDocument({ ...state, nextId: nextEventId });
  }
  if (state.representation !== "four-stream") {
    return fail(
      "invalid-envelope",
      "Envelope 'eventIds' claims an editable document but the payload stays opaque under the stored profile.",
    );
  }
  const decoded = state.tracks!;
  const restoredIds = eventIds;
  const tracks = decoded.map((lane, laneIndex) => {
    const ids = restoredIds[laneIndex]!;
    if (ids.length !== lane.length) {
      return fail(
        "invalid-envelope",
        `Envelope 'eventIds' lane ${laneIndex} has ${ids.length} ids but the decoded lane has ${lane.length} events.`,
      );
    }
    return Object.freeze(lane.map((event, index) => ({ ...event, id: ids[index]! })));
  });
  return new SoundDocument({ ...state, tracks, nextId: nextEventId });
}

/**
 * Authentic AGI sound resource decoder.
 *
 * Clean-room from Peter Kelly's agi-re behavioral specification:
 * "Sound Resources and Playback".
 *
 * Sound payloads begin with four little-endian 16-bit channel offsets.
 * Each channel consists of 5-byte event records:
 *   - 2 bytes duration (u16le) countdown in sound ticks (approx 60 Hz).
 *     Duration 0xffff is the channel terminator. Duration 0 is treated as 65536.
 *   - 2 bytes tone word (10-bit frequency divisor).
 *   - 1 byte control (low nibble is attenuation; 0x0f = silence).
 */

import type { AgiProfile } from "../runtime/profile.ts";
import { validatePlaybackState, type PlaybackState } from "../runtime/replayState.ts";

export interface SoundNote {
  readonly tone: number; // Original device-profile tone word.
  readonly control: number; // Original command byte, including channel selector.
  readonly duration: number; // in sound ticks (60 ticks/s)
  readonly freqDivisor: number; // 10-bit divisor (0..1023)
  readonly frequency: number; // frequency in Hz (0 for silence / rest)
  readonly attenuation: number; // 0 (full volume) .. 15 (silence)
  readonly volume: number; // normalized gain 0.0 .. 1.0
}

export interface SoundChannel {
  readonly channelIndex: number; // 0..3 (0..2 tone voices, 3 noise voice)
  readonly notes: readonly SoundNote[];
  readonly totalDuration: number; // duration in sound ticks
}

export interface AgiSound {
  readonly channels: readonly SoundChannel[];
  readonly duration: number; // max duration across channels in ticks
  readonly durationSeconds: number; // duration / 60
}

/**
 * Standard AGI PIT frequency calculation constant:
 * PC PIT clock 1,193,180 Hz / 12 = 99,431.67 Hz.
 * frequency = 99431.67 / freqDivisor.
 */
export const PIT_BASE_FREQ = 99431.67;

/**
 * The decay envelope executed on KQ1 2.917 — 67 steps then the 0x80 hold
 * sentinel (docs/fidelity.md, "Original sound player audit"). Each tick the
 * signed delta is applied to the note's base attenuation until the hold.
 */
export const DEFAULT_ENVELOPE_TABLE: readonly number[] = [
  -2, -3, -2, -1, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 6, 6, 6, 6, 6, 7, 7, 7, 7, 8, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 10, 11, 11, 11, 11, 11, 11,
  12, 12, 12, 12, 12, 12, 13, 0x80,
];

/**
 * The decay envelope executed on MH1 3.002.107 and GR1 3.002.149 — 77 steps,
 * a slower decay, same 0x80 hold sentinel (docs/fidelity.md, sound audit).
 * Selected through `AgiProfile.soundEnvelope`; unmeasured common-family
 * profiles keep the 2.917 table.
 */
export const V3_ENVELOPE_TABLE: readonly number[] = [
  -2, -3, -2, -1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3,
  3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 7, 7, 7, 7, 8, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10,
  10, 11, 11, 11, 11, 11, 11, 12, 12, 12, 12, 12, 12, 13, 0x80,
];

/**
 * The per-tick attenuation offsets executed by the Amiga sound driver — 61
 * longwords then the 0x80 hold sentinel, stored big-endian at the start of
 * data hunk 198 (docs/fidelity.md, "Original Amiga sound player"). Each tick
 * the offset applies to the note's own attenuation; the entries do not
 * accumulate.
 */
export const AMIGA_ENVELOPE_TABLE: readonly number[] = [
  2, 1, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5,
  5, 5, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 10, 10, 10, 10, 10, 11, 0x80,
];

/**
 * The envelope table inside KQ2's 0x12c-byte data hunk 198 — a signed
 * attack curve opening at -2 (louder than the note's attenuation) where the
 * shared 2.202+ table opens at +2, 64 steps then the 0x80 hold sentinel
 * (docs/fidelity.md, "Original Amiga sound player"). The driver code has
 * the same instruction sequence as 2.202+ and clamps the sum to 0..15, so
 * the attack saturates at full volume. Selected through
 * `AgiProfile.soundEnvelope`.
 */
export const AMIGA_2176_ENVELOPE_TABLE: readonly number[] = [
  -2, -3, -2, -1, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 6, 6, 6, 6, 7, 7, 7, 7, 8, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 10, 11, 11, 11, 11, 11, 12, 12,
  12, 12, 12, 13, 0x80,
];

/**
 * The 8-byte waveform the driver loads into every tone voice's AUDx buffer,
 * signed PCM copied from hunk 198 offset 0xf8 (docs/fidelity.md, "Original
 * Amiga sound player").
 */
export const AMIGA_TONE_SAMPLE: readonly number[] = [0, 64, 127, 64, 0, -64, -127, -64];

/**
 * The AUDxPER values a noise note's control type selects on the fourth
 * voice: types 0, 1 and 2, with 3 falling through to the last case
 * (docs/fidelity.md, "Original Amiga sound player").
 */
const AMIGA_NOISE_PERIODS: readonly number[] = [0x200, 0x400, 0x800, 0x800];

/**
 * The older driver's noise-control periods: the SQ1 2.082 build writes the
 * control byte's two type bits as the AUDxPER values {6, 3, 1, 1} — below
 * Paula's DMA minimum, nothing like the 2.176+ bank (docs/fidelity.md,
 * "The older 2.082 driver").
 */
const AMIGA_2082_NOISE_PERIODS: readonly number[] = [6, 3, 1, 1];

/**
 * The older driver's 4-byte tone buffer, built at init as signed PCM
 * `00 80 00 80` and played with AUDxLEN 2 — a two-sample square cycle
 * (docs/fidelity.md, "The older 2.082 driver").
 */
export const AMIGA_2082_TONE_SAMPLE: readonly number[] = [0, -128, 0, -128];

/** The older driver's noise buffer length: 0x400 bytes of the same LFSR PCM. */
export const AMIGA_2082_NOISE_BYTES = 0x400;

/**
 * The 4,096-byte PCM the driver synthesizes at init for the noise voice:
 * a Galois LFSR seeded with 1 and tapped with 0x0ca0, storing the low byte
 * of each successive state (docs/fidelity.md, "Original Amiga sound
 * player").
 */
export function amigaNoisePcm(length = 4096): Int8Array {
  const pcm = new Int8Array(length);
  let state = 1;
  for (let i = 0; i < length; i++) {
    state = state & 1 ? (state >> 1) ^ 0x0ca0 : state >> 1;
    pcm[i] = state & 0xff;
  }
  return pcm;
}

/**
 * Parses an authentic binary AGI sound resource.
 */
export function parseSound(payload: Uint8Array): AgiSound {
  return decodeSound(payload, 4, false);
}
/**
 * PC booter 2.001 sound payload (docs/fidelity.md pc-booter-sound-rows): rows
 * of raw SN76489 register writes, each row terminated by a zero byte, one row
 * per sound tick. A row of no writes (two adjacent terminators) skips its
 * tick. A trailing row without a terminator still plays.
 */
export function booterSoundRows(payload: Uint8Array): readonly (readonly number[])[] {
  const rows: number[][] = [];
  let start = 0;
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] !== 0) continue;
    rows.push([...payload.subarray(start, i)]);
    start = i + 1;
  }
  if (start < payload.length) rows.push([...payload.subarray(start)]);
  return rows;
}

/** Playback recovers bounded channel data; authoring keeps strict offset validation. */
function decodeSound(
  payload: Uint8Array,
  channelCount: number,
  recover: boolean,
  onWarning?: (message: string) => void,
): AgiSound {
  if (payload.length < 8 && !recover) {
    throw new Error(`Invalid sound payload: length ${payload.length} < 8`);
  }

  const channelOffsets: number[] = [];
  for (let ch = 0; ch < channelCount; ch++) {
    const off = payload[ch * 2]! | (payload[ch * 2 + 1]! << 8);
    if (recover && (payload.length < 8 || off < 8 || off + 2 > payload.length)) {
      onWarning?.(`channel ${ch} is unavailable within the resource; playing it silently.`);
      channelOffsets.push(payload.length);
      continue;
    }
    if (off > payload.length) {
      throw new Error(`Channel offset ${off} exceeds payload size ${payload.length}`);
    }
    channelOffsets.push(off);
  }

  const channels: SoundChannel[] = [];
  let maxDuration = 0;

  for (let ch = 0; ch < channelCount; ch++) {
    const offset = channelOffsets[ch]!;
    const notes: SoundNote[] = [];
    let cursor = offset;
    let channelTicks = 0;
    let terminated = false;

    // A channel terminates with duration 0xffff or when reaching payload end
    while (cursor + 2 <= payload.length) {
      const durLo = payload[cursor++]!;
      const durHi = payload[cursor++]!;
      const rawDuration = durLo | (durHi << 8);

      if (rawDuration === 0xffff) {
        terminated = true;
        break; // Channel terminator
      }

      const duration = rawDuration === 0 ? 65536 : rawDuration;

      if (cursor + 3 > payload.length) {
        // Truncated event record; stop gracefully
        break;
      }

      const byte0 = payload[cursor++]!;
      const byte1 = payload[cursor++]!;
      const control = payload[cursor++]!;

      // Divisor is 10-bit: ((tone & 0x003f) << 4) + ((tone >> 8) & 0x000f)
      const freqDivisor = ((byte0 & 0x3f) << 4) | (byte1 & 0x0f);
      const attenuation = control & 0x0f;

      const isRest = attenuation === 15 || freqDivisor === 0;
      const frequency = isRest ? 0 : PIT_BASE_FREQ / freqDivisor;
      const volume = isRest ? 0 : Math.pow(10, -attenuation / 10);

      notes.push({
        tone: byte0 | (byte1 << 8),
        control,
        duration,
        freqDivisor,
        frequency,
        attenuation,
        volume,
      });

      channelTicks += duration;
    }

    if (recover && offset < payload.length && !terminated) {
      onWarning?.(
        `channel ${ch} ends without a terminator; playback stops at the resource boundary.`,
      );
    }

    if (channelTicks > maxDuration) {
      maxDuration = channelTicks;
    }

    channels.push({
      channelIndex: ch,
      notes,
      totalDuration: channelTicks,
    });
  }

  return {
    channels,
    duration: maxDuration,
    durationSeconds: maxDuration / 60,
  };
}

export type SoundOutput =
  | { kind: "speaker"; divisor: number | null }
  | { kind: "psg"; bytes: readonly number[] }
  | {
      kind: "paula";
      /** The Paula voice, 0..3; voice 3 is the noise voice. */
      channel: number;
      /** The AUDxPER period count; null silences the voice. */
      period: number | null;
      /** The AUDxVOL value, 0..64. */
      volume: number;
      /**
       * Set on the older SQ1 2.082 driver, whose voices loop a 4-byte square
       * and a 1,024-byte noise PCM instead of the 2.176+ buffers. Each voice's
       * buffer is fixed by its channel either way.
       */
      driver?: "2.082";
    }
  | IigsOutput;

/**
 * Apple IIgs Note Synthesizer events (docs/fidelity.md "IIgs sound"). A
 * note-on starts a generator on the channel's current instrument; its voice
 * id pairs it with the note-off that releases it. "volume" is a controller-7
 * change the original applies to the channel's sounding generators; "sample"
 * starts a type-1 resource's one-shot on its embedded instrument; "all-off"
 * is AllNotesOff, sent when a sound starts, ends or stops.
 */
export type IigsOutput =
  | {
      kind: "iigs";
      event: "note-on";
      voice: number;
      /** The stream channel, 0..15. */
      channel: number;
      /** The Note Synthesizer semitone: the stream's note byte, unmodified. */
      note: number;
      /** The channel's controller value at note-on, 0..127 (127 until set). */
      volume: number;
      /** The program of the channel's last program change, or -1 for the default instrument. */
      program: number;
    }
  | { kind: "iigs"; event: "note-off"; voice: number }
  | { kind: "iigs"; event: "volume"; channel: number; volume: number }
  | {
      kind: "iigs";
      event: "sample";
      voice: number;
      /**
       * The type-1 resource after its type word: semitone and volume words,
       * wave offset and byte count, then the instrument record at +8 and the
       * unsigned 8-bit PCM at +8 + wave offset.
       */
      data: Uint8Array;
    }
  | { kind: "iigs"; event: "all-off" };

interface PlaybackChannel {
  notes: readonly SoundNote[];
  cursor: number;
  countdown: number;
  terminated: boolean;
  base: number;
  envelopeIndex: number;
  envelopeValue: number;
}

// ---- Apple IIgs sound resources (docs/fidelity.md "IIgs sound") ----

/**
 * One decoded IIgs step: the Note Synthesizer event a heartbeat produces, or
 * the end marker (output null) on the tick the original's cleanup runs.
 */
interface IigsEvent {
  /** 1-based sound tick (the 60 Hz heartbeat) on which the event executes. */
  readonly tick: number;
  readonly output: IigsOutput | null;
}

interface IigsDecoded {
  /**
   * Every event of the resource in execution order, ending with the end
   * marker — except a looping sample, which never completes.
   */
  readonly events: readonly IigsEvent[];
  /** Tick on which the sound completes; Infinity for a looping sample. */
  readonly endTick: number;
}

const IIGS_CHANNELS = 16;

/**
 * Decode a type-2 stream the way the seg3 heartbeat plays it (seg3+0x1dcd).
 * The resource's type word is skipped; the stream starts in the timing state.
 * Each heartbeat first spends a pending delay: a nonzero delay is decremented
 * and the tick ends. Otherwise the heartbeat loops: a timing byte adds its
 * value to the delay (0xf8 sets 255 and stays in the timing state), and an
 * event byte runs at once and returns to the timing state — so an event runs
 * exactly its timing byte's value in ticks after the previous one, and events
 * behind zero timing bytes run in the same tick. A status byte (bit 7) sets
 * the class and channel; a data byte keeps the running status. Note-on with
 * velocity 0 is a note-off; any controller stores its value as the channel's
 * note volume, and controller 7 also re-levels the sounding notes; program
 * change selects the channel's instrument; 0xfc (class 0xf0, channel 12) ends
 * the sound. Other classes have no handler: their data bytes are read as
 * timing bytes.
 */
function decodeIigsStream(payload: Uint8Array, onWarning?: (m: string) => void): IigsDecoded {
  const events: IigsEvent[] = [];
  const volume = new Array<number>(IIGS_CHANNELS).fill(127);
  const program = new Array<number>(IIGS_CHANNELS).fill(-1);
  // Each channel's sounding notes in allocation order; a note-off releases
  // the first generator holding that note.
  const sounding: { note: number; voice: number }[][] = Array.from(
    { length: IIGS_CHANNELS },
    () => [],
  );
  let voices = 0;
  let pos = 2;
  let tick = 0;
  let delay = 0;
  let timing = true;
  let status = 0x90;
  let channel = 0;
  let ended = false;
  const emit = (output: IigsOutput): void => {
    events.push({ tick, output });
  };
  const noteOff = (note: number): void => {
    const list = sounding[channel]!;
    const at = list.findIndex((entry) => entry.note === note);
    if (at < 0) return;
    emit({ kind: "iigs", event: "note-off", voice: list[at]!.voice });
    list.splice(at, 1);
  };

  events.push({ tick: 1, output: { kind: "iigs", event: "all-off" } });
  heartbeat: while (!ended) {
    tick++;
    if (delay > 0) {
      delay--;
      continue;
    }
    for (;;) {
      if (delay > 0) {
        delay--;
        continue heartbeat;
      }
      if (pos >= payload.length) {
        onWarning?.("iigs stream ends without the 0xfc terminator.");
        break heartbeat;
      }
      if (timing) {
        const byte = payload[pos++]!;
        if (byte === 0xf8) delay = 0xff;
        else {
          delay += byte;
          timing = false;
        }
        continue;
      }
      timing = true;
      const head = payload[pos]!;
      if ((head & 0x80) !== 0) {
        status = head & 0xf0;
        channel = head & 0x0f;
        pos++;
      }
      const d0 = payload[pos] ?? 0;
      const d1 = payload[pos + 1] ?? 0;
      if (status === 0x80 || (status === 0x90 && d1 === 0)) {
        pos += 2;
        noteOff(d0);
      } else if (status === 0x90) {
        pos += 2;
        const voice = voices++;
        sounding[channel]!.push({ note: d0, voice });
        emit({
          kind: "iigs",
          event: "note-on",
          voice,
          channel,
          note: d0,
          volume: volume[channel]!,
          program: program[channel]!,
        });
      } else if (status === 0xb0) {
        pos += 2;
        volume[channel] = d1;
        if (d0 === 7) emit({ kind: "iigs", event: "volume", channel, volume: d1 });
      } else if (status === 0xc0) {
        pos += 1;
        program[channel] = d0;
      } else if (status === 0xf0 && channel === 0x0c) ended = true;
      if (ended) break;
    }
  }
  events.push({ tick: Math.max(1, tick), output: null });
  return { events, endTick: Math.max(1, tick) };
}

/**
 * Decode a type-1 resource (seg3+0x1460): a Note Synthesizer note on the
 * instrument embedded at data+8, whose waves read the unsigned 8-bit PCM the
 * original copies to DOC RAM $C000. The heartbeat polls FFSoundDoneStatus
 * until the generator halts. The embedded envelopes sustain, so only the
 * Ensoniq DOC stops the note: on a zero sample, or at the end of its table in
 * one-shot mode. A free-running wave with no zero loops until the sound is
 * stopped, and its done flag never sets. The Note Synthesizer plays 256 bytes
 * per cycle of the note's pitch, so a halt comes after (bytes played) /
 * (256 * f(semitone)) seconds, f equal-tempered with semitone 69 at 440 Hz —
 * an inference: the pitch table is in the toolset ROM (docs/fidelity.md).
 */
function decodeIigsWave(payload: Uint8Array, onWarning?: (m: string) => void): IigsDecoded {
  const data = payload.subarray(2);
  const u16 = (at: number): number => (data[at] ?? 0) | ((data[at + 1] ?? 0) << 8);
  const semitone = u16(0);
  const waveOffset = u16(4);
  const byteCount = u16(6);
  const pcmStart = 8 + waveOffset;
  const pcm = data.subarray(pcmStart, pcmStart + byteCount);
  if (pcm.length < byteCount) onWarning?.("iigs wave resource is shorter than its byte count.");
  // The first A wave decides the halt: its table size (256 << T) and mode.
  const waveSize = data[8 + 34] ?? 0;
  const docMode = data[8 + 35] ?? 0;
  const zero = pcm.indexOf(0);
  const oneShot = ((docMode >> 1) & 3) === 1;
  const played = zero >= 0 ? zero : oneShot ? 256 << ((waveSize >> 3) & 7) : null;
  const start: IigsEvent[] = [
    { tick: 1, output: { kind: "iigs", event: "all-off" } },
    { tick: 1, output: { kind: "iigs", event: "sample", voice: 0, data } },
  ];
  if (played === null) return { events: start, endTick: Infinity };
  const bytesPerSecond = 256 * 440 * 2 ** ((semitone - 69) / 12);
  const endTick = Math.max(1, Math.ceil((played * 60) / bytesPerSecond));
  return { events: [...start, { tick: endTick, output: null }], endTick };
}

function decodeIigs(payload: Uint8Array, onWarning?: (m: string) => void): IigsDecoded {
  // The player dispatches on the type word: 1 is a sample, anything else a stream.
  if (payload.length > 2 && payload[0] === 0x01 && payload[1] === 0x00)
    return decodeIigsWave(payload, onWarning);
  if (payload.length > 2) return decodeIigsStream(payload, onWarning);
  if (payload.length > 0) onWarning?.("iigs sound resource is too short.");
  return { events: [{ tick: 1, output: null }], endTick: 1 };
}

/** Tick-driven command interpreter; the host owns the clock, never the synthesizer. */
export class SoundPlayback {
  private readonly profile: AgiProfile;
  private readonly device: number;
  private readonly single: boolean;
  /** The profile-selected decay table; its length also bounds snapshot restore. */
  private readonly envelope: readonly number[];
  private readonly channels: PlaybackChannel[];
  /**
   * PC booter 2.001 row stream; the single pseudo-channel's cursor is the row
   * position so snapshot/restore validation applies unchanged. The notes array
   * carries one placeholder per row purely to bound the recorded cursor.
   */
  private readonly rows: readonly (readonly number[])[] | null;
  /**
   * IIgs stream events per channel; the notes array carries one placeholder
   * per event purely to bound the recorded cursor, like the booter rows.
   */
  private readonly iigsEvents: readonly IigsEvent[] | null;
  /**
   * IIgs volume-fade watchdog (docs/fidelity.md "Apple IIgs sound fade"):
   * the original's ~globals $df/$e1/$e3 — the pace in heartbeats, its
   * countdown, and the stepped volume budget latched from GetSoundVolume.
   * Null while disarmed (the original's $df = 0xffff sentinel).
   */
  private iigsFade: { pace: number; countdown: number; budget: number } | null = null;
  /** Longest voice this device plays, in sound ticks; a zero duration counts as 65536 without being ticked through. */
  readonly durationTicks: number;
  private active = true;

  constructor(
    profile: AgiProfile,
    payload: Uint8Array,
    device: number,
    onWarning?: (message: string) => void,
  ) {
    this.profile = profile;
    this.device = device & 255;
    this.envelope =
      profile.sound === "amiga"
        ? profile.soundEnvelope === "amiga-2.176"
          ? AMIGA_2176_ENVELOPE_TABLE
          : AMIGA_ENVELOPE_TABLE
        : profile.soundEnvelope === "3.002"
          ? V3_ENVELOPE_TABLE
          : DEFAULT_ENVELOPE_TABLE;
    // The booter payload is already raw chip writes; there is no speaker rendition.
    this.single =
      profile.sound === "booter-2.001" ||
      profile.sound === "amiga" ||
      profile.sound === "amiga-2.082" ||
      profile.sound === "iigs"
        ? false
        : this.device === 0 || (profile.sound === "common" && this.device === 8);
    if (profile.sound === "iigs") {
      const decoded = decodeIigs(payload, onWarning);
      const placeholder: SoundNote = {
        tone: 0,
        control: 0,
        duration: 1,
        freqDivisor: 0,
        frequency: 0,
        attenuation: 15,
        volume: 0,
      };
      this.rows = null;
      this.iigsEvents = decoded.events;
      this.durationTicks = decoded.endTick;
      // One timeline: the Note Synthesizer events carry their own channels.
      this.channels = [
        {
          notes: decoded.events.map(() => placeholder),
          cursor: 0,
          countdown: decoded.events[0]?.tick ?? 0,
          terminated: decoded.events.length === 0,
          base: 0,
          envelopeIndex: -1,
          envelopeValue: 0,
        },
      ];
      return;
    }
    this.iigsEvents = null;
    if (profile.sound === "booter-2.001") {
      const rows = booterSoundRows(payload);
      const placeholder: SoundNote = {
        tone: 0,
        control: 0,
        duration: 1,
        freqDivisor: 0,
        frequency: 0,
        attenuation: 15,
        volume: 0,
      };
      this.rows = rows;
      this.durationTicks = rows.length;
      this.channels = [
        {
          notes: rows.map(() => placeholder),
          cursor: 0,
          countdown: 1,
          terminated: false,
          base: 15,
          envelopeIndex: -1,
          envelopeValue: 0,
        },
      ];
      return;
    }
    this.rows = null;
    const decoded = decodeSound(payload, this.single ? 1 : 4, true, onWarning);
    this.durationTicks = decoded.duration;
    this.channels = decoded.channels.map((channel) => ({
      notes: channel.notes,
      cursor: 0,
      countdown: 1,
      terminated: false,
      base: 15,
      // The Amiga driver starts every channel's envelope cursor at the table
      // start; the PC families arm theirs on each decoded note instead.
      envelopeIndex: profile.sound === "amiga" ? 0 : -1,
      envelopeValue: 0,
    }));
  }

  /**
   * Arm the IIgs volume-fade watchdog on the playing sound (docs/fidelity.md
   * "Apple IIgs sound fade"): the heartbeat steps the latched volume budget
   * down by 0x10 every `pace` beats and completes the sound once the budget
   * falls below 0x10. A pace of zero completes it on the next beat. The
   * original latches the budget from GetSoundVolume only while the watchdog
   * is disarmed; re-arming updates pace and countdown without re-latching.
   * The host has no GS system volume, so the latch substitutes the maximum.
   */
  armFade(pace: number): void {
    this.iigsFade ??= { pace: 0, countdown: 0, budget: 0xff };
    this.iigsFade.pace = pace;
    this.iigsFade.countdown = pace;
  }

  snapshot(): PlaybackState {
    return {
      device: this.device,
      active: this.active,
      fade: this.iigsFade === null ? null : { ...this.iigsFade },
      channels: this.channels.map(({ notes: _notes, ...channel }) => ({ ...channel })),
    };
  }

  restore(value: unknown): void {
    const state = validatePlaybackState(value);
    if (state.device !== this.device || state.channels.length !== this.channels.length)
      throw new Error("Recorded sound device differs from playback.");
    for (let i = 0; i < state.channels.length; i++) {
      const channel = state.channels[i]!;
      if (
        channel.cursor > this.channels[i]!.notes.length + 1 ||
        channel.envelopeIndex >= this.envelope.length
      )
        throw new Error("Recorded sound position is outside the current resource.");
    }
    this.active = state.active;
    this.iigsFade = state.fade;
    for (let i = 0; i < state.channels.length; i++)
      Object.assign(this.channels[i]!, state.channels[i]!);
  }

  tick(enabled: boolean, adjustment: number): { outputs: SoundOutput[]; complete: boolean } {
    if (!this.active) return { outputs: [], complete: true };
    if (!enabled) return { outputs: this.stop(), complete: true };
    // The IIgs fade watchdog runs before the per-family stream work in the
    // original's heartbeat: pace zero completes the armed sound immediately;
    // each pace expiry checks the stepped budget before decrementing it, so
    // a fresh 0xff budget completes on the sixteenth expiry.
    const fade = this.iigsFade;
    if (fade !== null) {
      if (fade.pace === 0) return { outputs: this.stop(), complete: true };
      if (--fade.countdown <= 0) {
        fade.countdown = fade.pace;
        if (fade.budget < 0x10) return { outputs: this.stop(), complete: true };
        fade.budget -= 0x10;
      }
    }
    const outputs: SoundOutput[] = [];
    adjustment &= 255;
    if (this.rows) {
      // One zero-terminated row per tick; completion is payload exhaustion.
      const channel = this.channels[0]!;
      if (!channel.terminated) {
        const row = this.rows[channel.cursor++];
        if (row === undefined || channel.cursor >= this.rows.length) channel.terminated = true;
        if (row !== undefined && row.length > 0) outputs.push({ kind: "psg", bytes: row });
      }
      if (channel.terminated) outputs.push(...this.stop());
      return { outputs, complete: !this.active };
    }
    if (this.iigsEvents) {
      // The countdown arms the gap to the next event; the end marker's tick
      // runs the original's cleanup, which completes the sound.
      const channel = this.channels[0]!;
      const events = this.iigsEvents;
      // Past the last event of a looping sample the note simply sounds on.
      if (!channel.terminated && channel.cursor < events.length && --channel.countdown === 0)
        for (;;) {
          const event = events[channel.cursor];
          if (event === undefined) break;
          if (event.output === null) {
            channel.terminated = true;
            break;
          }
          outputs.push(event.output);
          channel.cursor++;
          const next = events[channel.cursor];
          const gap = next === undefined ? 0 : next.tick - event.tick;
          if (gap > 0) {
            channel.countdown = gap;
            break;
          }
        }
      if (channel.terminated) outputs.push(...this.stop());
      return { outputs, complete: !this.active };
    }
    if (this.profile.sound === "amiga-2.082") {
      // The older driver has no envelope and no held-tick register writes:
      // a voice's AUDx registers are programmed only when a note decodes,
      // and the period is 16 times the note divisor rather than 4
      // (docs/fidelity.md, "Original Amiga sound player").
      for (let index = 0; index < this.channels.length; index++) {
        const channel = this.channels[index]!;
        if (channel.terminated) continue;
        channel.countdown--;
        if (channel.countdown !== 0) continue;
        const note = channel.notes[channel.cursor++];
        if (!note) {
          channel.terminated = true;
          outputs.push({ kind: "paula", channel: index, period: null, volume: 0, driver: "2.082" });
          continue;
        }
        channel.countdown = note.duration;
        channel.base = note.attenuation;
        // SQ1 h138 0xe8ca..0xe8f8: attenuation minus v23, floored at 0
        // (`cmp.l d1,d0; bls` zeroes it when v23 >= attenuation), then
        // ((15 - it) << 6) / 15 — v23 raises the volume.
        const attenuation = note.attenuation > adjustment ? note.attenuation - adjustment : 0;
        outputs.push({
          kind: "paula",
          channel: index,
          period:
            index === 3 ? AMIGA_2082_NOISE_PERIODS[(note.tone >> 8) & 3]! : 16 * note.freqDivisor,
          volume: (((15 - attenuation) << 6) / 15) | 0,
          driver: "2.082",
        });
      }
      if (this.channels.every((channel) => channel.terminated)) outputs.push(...this.stop());
      return { outputs, complete: !this.active };
    }
    if (this.profile.sound === "amiga") {
      // The Paula driver steps each live voice's envelope and rewrites its
      // AUDxVOL on every tick; AUDxPER is written when a note decodes, so
      // the repeated period is the value the register already holds. The
      // driver never reads v23 (docs/fidelity.md, "Original Amiga sound
      // player").
      for (let index = 0; index < this.channels.length; index++) {
        const channel = this.channels[index]!;
        if (channel.terminated) continue;
        channel.countdown--;
        if (channel.countdown === 0) {
          const note = channel.notes[channel.cursor++];
          if (!note) {
            channel.terminated = true;
            outputs.push({ kind: "paula", channel: index, period: null, volume: 0 });
            continue;
          }
          channel.countdown = note.duration;
          channel.base = note.attenuation;
          // Tone voices restart the envelope cursor on each note; the noise
          // voice's cursor runs the table once from its start.
          if (index < 3) channel.envelopeIndex = 0;
        }
        if (channel.envelopeIndex >= 0) {
          const delta = this.envelope[channel.envelopeIndex++]!;
          if (delta === 0x80) {
            channel.envelopeIndex = -1;
            channel.base = channel.envelopeValue;
          } else {
            // GR h197 0xf494..0xf4a6: base + delta clamped to 0..15, so
            // KQ2's signed attack saturates at attenuation 0.
            channel.envelopeValue = Math.max(0, Math.min(15, channel.base + delta));
          }
        }
        const note = channel.notes[channel.cursor - 1];
        const attenuation = channel.envelopeIndex > 0 ? channel.envelopeValue : channel.base;
        outputs.push({
          kind: "paula",
          channel: index,
          period:
            note === undefined
              ? null
              : index === 3
                ? AMIGA_NOISE_PERIODS[(note.tone >> 8) & 3]!
                : 4 * note.freqDivisor,
          // AUDxVOL = ((15 - attenuation) << 6) / 15 on the 0..64 scale.
          volume: (((15 - attenuation) << 6) / 15) | 0,
        });
      }
      if (this.channels.every((channel) => channel.terminated)) outputs.push(...this.stop());
      return { outputs, complete: !this.active };
    }
    for (let index = 0; index < this.channels.length; index++) {
      const channel = this.channels[index]!;
      if (channel.terminated) continue;
      const selector = 0x90 | (index << 5);
      channel.countdown--;
      if (channel.countdown === 0) {
        const note = channel.notes[channel.cursor++];
        if (!note) {
          channel.terminated = true;
          channel.base = 15;
          if (!this.single) outputs.push({ kind: "psg", bytes: [selector | 15] });
          continue;
        }
        channel.countdown = note.duration;
        channel.base = note.attenuation;
        if (this.single) {
          outputs.push({
            kind: "speaker",
            divisor: note.attenuation === 15 ? null : 12 * note.freqDivisor,
          });
          continue;
        }
        const high = note.tone >> 8;
        const low = note.tone & 255;
        const earlyBoth =
          this.profile.sound === "early-2.089" ||
          this.profile.sound === "early-2.272" ||
          this.profile.sound === "early-2.411";
        // Rest notes (tone == 0) suppress frequency divisor commands (docs/fidelity.md: SN76489 attenuation latching and rest notes).
        if (note.tone !== 0) {
          outputs.push({
            kind: "psg",
            bytes: !earlyBoth && (high & 0xe0) === 0xe0 ? [high] : [high, low],
          });
        }
        if (this.profile.sound !== "common") {
          let control = note.control;
          if (this.profile.sound === "early-2.089" || this.profile.sound === "early-2.272") {
            if (this.device === 2 && (control & 15) < 8) control += 3;
            if (this.profile.sound === "early-2.272") {
              control = (control + adjustment) & 255;
              if (control < 128 && control > 15) control = 15;
            }
          } else control = (control & 0xf0) | Math.min(15, (control & 15) + adjustment);
          outputs.push({ kind: "psg", bytes: [control] });
          continue;
        }
        if (index < 3) channel.envelopeIndex = 0;
      }
      if (this.single || this.profile.sound !== "common") continue;
      let attenuation = channel.base;
      if (attenuation !== 15) {
        if (channel.envelopeIndex >= 0) {
          const delta = this.envelope[channel.envelopeIndex++]!;
          if (delta === 0x80) {
            channel.envelopeIndex = -1;
            channel.base = channel.envelopeValue;
            attenuation = channel.base;
          } else {
            attenuation = Math.max(0, Math.min(15, channel.base + delta));
            channel.envelopeValue = attenuation;
            // v23 attenuates only while the envelope actively advances: the
            // hold transition, held ticks and the envelope-free noise channel
            // all reuse the stored value without it (docs/fidelity.md,
            // sound player audit).
            // The original adds into AL and compares it as signed, so high
            // v23 values can survive the clamp or wrap into another register
            // selector (docs/fidelity.md, sound player audit).
            attenuation = (attenuation + adjustment) & 255;
            if (attenuation > 15 && attenuation < 128) attenuation = 15;
          }
        }
        if (this.device === 2 && (attenuation < 8 || attenuation >= 128))
          attenuation = (attenuation + 2) & 255;
      }
      outputs.push({ kind: "psg", bytes: [selector | attenuation] });
    }
    if (this.channels.every((channel) => channel.terminated)) outputs.push(...this.stop());
    return { outputs, complete: !this.active };
  }

  stop(): SoundOutput[] {
    if (!this.active) return [];
    this.active = false;
    // The original's completion path also disarms the watchdog ($df = 0xffff)
    // and restores the latched volume; the volume side is a native GS call.
    this.iigsFade = null;
    // The cleanup's AllNotesOff silences every generator.
    if (this.iigsEvents) return [{ kind: "iigs", event: "all-off" }];
    if (this.profile.sound === "amiga" || this.profile.sound === "amiga-2.082")
      return this.channels.map((_, channel) => ({
        kind: "paula" as const,
        channel,
        period: null,
        volume: 0,
        ...(this.profile.sound === "amiga-2.082" ? { driver: "2.082" as const } : {}),
      }));
    return this.single
      ? [{ kind: "speaker", divisor: null }]
      : [{ kind: "psg", bytes: [0x9f, 0xbf, 0xdf, 0xff] }];
  }
}

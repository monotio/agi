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
      /** True while the voice plays the LFSR noise buffer instead of the tone sample. */
      noise?: boolean;
    }
  | {
      kind: "iigs";
      /** The Note Synthesizer channel, 0..15. */
      channel: number;
      /** True while a note sounds on the channel; false releases the voice. */
      on: boolean;
      /** The MIDI note number of the event (or of the last sounding note). */
      note: number;
      /** The note-on velocity 1..127; 0 on release. */
      velocity: number;
      /** The channel volume set by controller 7, 0..127; 127 until set. */
      volume: number;
      /** The program number of the last program change, or -1 before the first. */
      program: number;
    };
interface PlaybackChannel {
  notes: readonly SoundNote[];
  cursor: number;
  countdown: number;
  terminated: boolean;
  base: number;
  envelopeIndex: number;
  envelopeValue: number;
}

// ---- Apple IIgs stream resources (docs/fidelity.md, "Apple IIgs interpreter") ----

type IigsOutput = Extract<SoundOutput, { kind: "iigs" }>;

/**
 * One decoded IIgs stream step: the channel state a command produces on its
 * execution tick, or a stream-end marker (output null) that bounds the
 * resource's duration the way the original scheduler's 0xf0-class terminator
 * does.
 */
interface IigsEvent {
  /** 1-based sound tick (the 60 Hz heartbeat) on which the event executes. */
  readonly tick: number;
  readonly output: IigsOutput | null;
}

interface IigsDecoded {
  /** Per Note-Synthesizer-channel event queues, in stream order. */
  readonly events: readonly (readonly IigsEvent[])[];
  /** Tick on which the stream terminator executes. */
  readonly endTick: number;
}

/** Bytes consumed by each handled command class (running-status aware). */
const IIGS_DATA_BYTES: Readonly<Record<number, number>> = {
  0x80: 2,
  0x90: 2,
  0xb0: 2,
  0xc0: 1,
};

const IIGS_CHANNELS = 16;

/**
 * Decode a type-0x02 IIgs stream the way the seg3 scheduler interprets it:
 * one micro-step per 60 Hz heartbeat tick — a delta-byte read (1 tick), its
 * countdown (1 tick per unit), or one command execution (1 tick, including
 * the command's data bytes). 0xf8 in delta position sets a 255-tick wait and
 * stays in the delta phase, so a following byte extends the same wait.
 * Commands carry running status: a byte below 0x80 re-dispatches the stored
 * status. Classes 0x80/0x90/0xb0/0xc0 consume their data bytes inside the
 * execution step; every other class dispatches to no handler, so its data
 * bytes fall to the delta phase and accumulate as wait time. Execution
 * begins with the byte at offset 2 as the leading delta — the `[02][u16]`
 * header's high byte — so commands start at offset 3.
 */
function decodeIigsStream(payload: Uint8Array, onWarning?: (m: string) => void): IigsDecoded {
  const events: IigsEvent[][] = Array.from({ length: IIGS_CHANNELS }, () => []);
  // The original keeps a note table per channel; a note-off releases only
  // the named note, and the channel sounds until its table is empty.
  const sounding: { note: number; velocity: number }[][] = Array.from(
    { length: IIGS_CHANNELS },
    () => [],
  );
  const volume = new Array<number>(IIGS_CHANNELS).fill(127);
  const program = new Array<number>(IIGS_CHANNELS).fill(-1);
  const lastNote = new Array<number>(IIGS_CHANNELS).fill(0);

  let pos = 2;
  let tick = 0;
  let countdown = 0;
  let deltaPhase = true;
  let status = 0x90;
  let channel = 0;
  let terminated = false;

  const stateOutput = (ch: number, note: number): IigsOutput => {
    const active = sounding[ch]!.at(-1);
    return {
      kind: "iigs",
      channel: ch,
      on: active !== undefined,
      note: active?.note ?? note,
      velocity: active?.velocity ?? 0,
      volume: volume[ch]!,
      program: program[ch]!,
    };
  };

  while (pos < payload.length || countdown > 0) {
    tick++;
    if (countdown > 0) {
      countdown--;
      continue;
    }
    if (pos >= payload.length) break;
    if (deltaPhase) {
      const delta = payload[pos++]!;
      if (delta === 0xf8) {
        countdown = 0xff;
        continue;
      }
      countdown += delta;
      deltaPhase = false;
      continue;
    }
    const head = payload[pos]!;
    if ((head & 0x80) !== 0) {
      if ((head & 0xf0) === 0xf0) {
        terminated = true;
        break;
      }
      status = head & 0xf0;
      channel = head & 0x0f;
      pos++;
    }
    const dataBytes = IIGS_DATA_BYTES[status];
    if (dataBytes !== undefined) {
      if (pos + dataBytes > payload.length) break;
      const d0 = payload[pos]!;
      const d1 = dataBytes === 2 ? payload[pos + 1]! : 0;
      pos += dataBytes;
      if (status === 0x90 && d1 !== 0) {
        sounding[channel]!.push({ note: d0, velocity: d1 });
        lastNote[channel] = d0;
        events[channel]!.push({ tick, output: stateOutput(channel, d0) });
      } else if (status === 0x90 || status === 0x80) {
        const list = sounding[channel]!;
        const at = list.findIndex((entry) => entry.note === d0);
        if (at >= 0) list.splice(at, 1);
        events[channel]!.push({ tick, output: stateOutput(channel, d0) });
      } else if (status === 0xc0) {
        program[channel] = d0;
        events[channel]!.push({ tick, output: stateOutput(channel, lastNote[channel]!) });
      } else if (d0 === 7) {
        volume[channel] = d1;
        events[channel]!.push({ tick, output: stateOutput(channel, lastNote[channel]!) });
      }
      // Other controllers reach the same stub the unhandled classes do:
      // consumed without an emitted state change.
    }
    deltaPhase = true;
  }
  const endTick = tick;
  if (!terminated) onWarning?.("iigs stream ends without the 0xfc terminator.");

  for (let ch = 0; ch < IIGS_CHANNELS; ch++) {
    if (events[ch]!.length === 0) continue;
    const active = sounding[ch]!.at(-1);
    events[ch]!.push({
      tick: endTick,
      output:
        active === undefined
          ? null
          : {
              kind: "iigs",
              channel: ch,
              on: false,
              note: active.note,
              velocity: 0,
              volume: volume[ch]!,
              program: program[ch]!,
            },
    });
  }
  if (events.every((queue) => queue.length === 0)) events[0]!.push({ tick: endTick, output: null });
  return { events, endTick };
}

/**
 * Decode a type-0x01 IIgs wave resource into a silent, finite-length event
 * stream. The resource holds Free-Form Synthesizer wave data the original
 * feeds to FFStartSound and polls until the toolbox reports completion; the
 * setup block's stream semantics are a documented gap (docs/fidelity.md), so
 * the resource's duration comes from the wave byte count at offset 8 played
 * at the documented rate — the freqOffset in the wave record at offset 44
 * times 51.40625 Hz — and playback emits silence.
 */
function decodeIigsWave(payload: Uint8Array, onWarning?: (m: string) => void): IigsDecoded {
  const u16 = (at: number) => (payload[at] ?? 0) | ((payload[at + 1] ?? 0) << 8);
  const waveBytes = Math.min(u16(8), Math.max(0, payload.length - 54));
  // The wave record at offset 44: freqOffset, two zeros, the 0x7f 0xc0 tag,
  // then the same three fields. Without the tag the freqOffset cannot be
  // located reliably; fall back to a mid-range rate.
  const tagged = payload[0x30] === 0x7f && payload[0x31] === 0xc0;
  const freqOffset = tagged ? u16(0x2c) : 0x100;
  if (!tagged) onWarning?.("iigs wave resource lacks the 0x7f 0xc0 rate tag.");
  // rate = freqOffset * 1645/32 Hz; ticks = waveBytes / rate * 60.
  const endTick = Math.max(1, Math.round((waveBytes * 1920) / (freqOffset * 1645)));
  const events: IigsEvent[][] = Array.from({ length: IIGS_CHANNELS }, () => []);
  events[0]!.push(
    {
      tick: 1,
      output: {
        kind: "iigs",
        channel: 0,
        on: false,
        note: 0,
        velocity: 0,
        volume: 0,
        program: -1,
      },
    },
    { tick: endTick, output: null },
  );
  return { events, endTick };
}

function decodeIigs(payload: Uint8Array, onWarning?: (m: string) => void): IigsDecoded {
  if (payload.length > 2 && payload[0] === 0x02) return decodeIigsStream(payload, onWarning);
  if (payload.length > 2 && payload[0] === 0x01) return decodeIigsWave(payload, onWarning);
  if (payload.length > 0)
    onWarning?.(`unrecognized iigs sound resource type ${payload[0]?.toString(16)}.`);
  return { events: [[{ tick: 1, output: null }]], endTick: 1 };
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
  private readonly iigsEvents: readonly (readonly IigsEvent[])[] | null;
  /** Last state emitted per IIgs channel, for stop() releases. */
  private readonly iigsLast: (IigsOutput | undefined)[] = [];
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
        ? AMIGA_ENVELOPE_TABLE
        : profile.soundEnvelope === "3.002"
          ? V3_ENVELOPE_TABLE
          : DEFAULT_ENVELOPE_TABLE;
    // The booter payload is already raw chip writes; there is no speaker rendition.
    this.single =
      profile.sound === "booter-2.001" || profile.sound === "amiga" || profile.sound === "iigs"
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
      this.channels = decoded.events.map((events) => ({
        notes: events.map(() => placeholder),
        cursor: 0,
        countdown: events.length > 0 ? events[0]!.tick : 0,
        terminated: events.length === 0,
        // base doubles as the sounding flag: 1 while the channel holds a note.
        base: 0,
        envelopeIndex: -1,
        envelopeValue: 0,
      }));
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

  snapshot(): PlaybackState {
    return {
      device: this.device,
      active: this.active,
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
    for (let i = 0; i < state.channels.length; i++)
      Object.assign(this.channels[i]!, state.channels[i]!);
  }

  tick(enabled: boolean, adjustment: number): { outputs: SoundOutput[]; complete: boolean } {
    if (!this.active) return { outputs: [], complete: true };
    if (!enabled) return { outputs: this.stop(), complete: true };
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
      // Each channel's countdown arms the gap to its next stream event; an
      // exhausted queue terminates the channel at the terminator's tick.
      for (let index = 0; index < this.channels.length; index++) {
        const channel = this.channels[index]!;
        if (channel.terminated) continue;
        channel.countdown--;
        if (channel.countdown !== 0) continue;
        const events = this.iigsEvents[index]!;
        while (true) {
          const event = events[channel.cursor];
          if (event === undefined) {
            channel.terminated = true;
            break;
          }
          if (event.output !== null) {
            channel.base = event.output.on ? 1 : 0;
            this.iigsLast[index] = event.output;
            outputs.push(event.output);
          }
          channel.cursor++;
          const next = events[channel.cursor];
          if (next === undefined) {
            channel.terminated = true;
            break;
          }
          const gap = next.tick - event.tick;
          if (gap > 0) {
            channel.countdown = gap;
            break;
          }
        }
      }
      if (this.channels.every((channel) => channel.terminated)) outputs.push(...this.stop());
      return { outputs, complete: !this.active };
    }
    if (this.profile.sound === "amiga") {
      // The Paula driver rewrites each live voice's AUDx registers on every
      // tick: the note's period with the envelope-adjusted volume
      // (docs/fidelity.md, "Original Amiga sound player").
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
          ...(index === 3 ? { noise: true } : {}),
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
    if (this.iigsEvents)
      return this.channels.flatMap((channel, index) => {
        if (channel.base !== 1) return [];
        const last = this.iigsLast[index];
        return [
          {
            kind: "iigs" as const,
            channel: index,
            on: false,
            note: last?.note ?? 0,
            velocity: 0,
            volume: last?.volume ?? 0,
            program: last?.program ?? -1,
          },
        ];
      });
    if (this.profile.sound === "amiga")
      return this.channels.map((_, channel) => ({
        kind: "paula" as const,
        channel,
        period: null,
        volume: 0,
      }));
    return this.single
      ? [{ kind: "speaker", divisor: null }]
      : [{ kind: "psg", bytes: [0x9f, 0xbf, 0xdf, 0xff] }];
  }
}

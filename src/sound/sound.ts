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
 * Default AGI 2.917+ decay envelope table from the agi-re behavioral specification.
 * Each tick, signed delta is applied to base attenuation until 0x80 hold.
 */
export const DEFAULT_ENVELOPE_TABLE: readonly number[] = [
  -2, -3, -2, -1, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 6, 6, 6, 6, 6, 7, 7, 7, 7, 8, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 10, 11, 11, 11, 11, 11, 11,
  12, 12, 12, 12, 12, 12, 13, 0x80,
];

/**
 * Parses an authentic binary AGI sound resource.
 */
export function parseSound(payload: Uint8Array): AgiSound {
  return decodeSound(payload, 4, false);
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
  { kind: "speaker"; divisor: number | null } | { kind: "psg"; bytes: readonly number[] };
interface PlaybackChannel {
  notes: readonly SoundNote[];
  cursor: number;
  countdown: number;
  terminated: boolean;
  base: number;
  envelopeIndex: number;
  envelopeValue: number;
}

/** Tick-driven command interpreter; the host owns the clock, never the synthesizer. */
export class SoundPlayback {
  private readonly profile: AgiProfile;
  private readonly device: number;
  private readonly single: boolean;
  private readonly channels: PlaybackChannel[];
  private active = true;

  constructor(
    profile: AgiProfile,
    payload: Uint8Array,
    device: number,
    onWarning?: (message: string) => void,
  ) {
    this.profile = profile;
    this.device = device & 255;
    this.single = this.device === 0 || (profile.sound === "common" && this.device === 8);
    this.channels = decodeSound(payload, this.single ? 1 : 4, true, onWarning).channels.map(
      (channel) => ({
        notes: channel.notes,
        cursor: 0,
        countdown: 1,
        terminated: false,
        base: 15,
        envelopeIndex: -1,
        envelopeValue: 0,
      }),
    );
  }

  tick(enabled: boolean, adjustment: number): { outputs: SoundOutput[]; complete: boolean } {
    if (!this.active) return { outputs: [], complete: true };
    if (!enabled) return { outputs: this.stop(), complete: true };
    const outputs: SoundOutput[] = [];
    adjustment &= 255;
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
        outputs.push({
          kind: "psg",
          bytes: !earlyBoth && (high & 0xe0) === 0xe0 ? [high] : [high, low],
        });
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
          const delta = DEFAULT_ENVELOPE_TABLE[channel.envelopeIndex++]!;
          if (delta === 0x80) {
            channel.envelopeIndex = -1;
            channel.base = channel.envelopeValue;
            attenuation = channel.base;
          } else {
            attenuation = Math.max(0, Math.min(15, channel.base + delta));
            channel.envelopeValue = attenuation;
          }
        }
        attenuation = Math.min(15, attenuation + adjustment);
        if (this.device === 2 && attenuation < 8) attenuation += 2;
      }
      outputs.push({ kind: "psg", bytes: [selector | attenuation] });
    }
    if (this.channels.every((channel) => channel.terminated)) outputs.push(...this.stop());
    return { outputs, complete: !this.active };
  }

  stop(): SoundOutput[] {
    if (!this.active) return [];
    this.active = false;
    return this.single
      ? [{ kind: "speaker", divisor: null }]
      : [{ kind: "psg", bytes: [0x9f, 0xbf, 0xdf, 0xff] }];
  }
}

/** VGM 1.50/1.51 PSG command reconstruction, independently from the format spec. */
import { createSoundDocument, type SoundEventDataInput } from "./document.ts";
import type { ProfileId } from "../runtime/profile.ts";
import { PSG_BASE_FREQ } from "./sound.ts";
import { insertSoundSpan } from "./sequencer.ts";
import { MusicReader, type SoundImport } from "./musicImport.ts";

const CHIP_CLOCKS: Readonly<Record<number, string>> = {
  0x10: "YM2413",
  0x2c: "YM2612",
  0x30: "YM2151",
  0x38: "Sega PCM",
  0x40: "RF5C68",
  0x44: "YM2203",
  0x48: "YM2608",
  0x4c: "YM2610",
  0x50: "YM3812",
  0x54: "YM3526",
  0x58: "Y8950",
  0x5c: "YMF262",
  0x60: "YMF278B",
  0x64: "YMF271",
  0x68: "YMZ280B",
  0x6c: "RF5C164",
  0x70: "PWM",
  0x74: "AY8910",
};
const CHIP_COMMANDS: Readonly<Record<number, string>> = {
  0x30: "second SN76489",
  0x51: "YM2413",
  0x52: "YM2612",
  0x53: "YM2612",
  0x54: "YM2151",
  0x55: "YM2203",
  0x56: "YM2608",
  0x57: "YM2608",
  0x58: "YM2610",
  0x59: "YM2610",
  0x5a: "YM3812",
  0x5b: "YM3526",
  0x5c: "Y8950",
  0x5d: "YMZ280B",
  0x5e: "YMF262",
  0x5f: "YMF262",
  0xa0: "AY8910",
};

export function importVgm(bytes: Uint8Array, profileId?: ProfileId): SoundImport {
  const reader = new MusicReader(bytes, "VGM");
  if (reader.text(4) !== "Vgm ")
    throw new Error("VGM header is missing. Choose an uncompressed .vgm file.");
  const eof = reader.number(4, true) + 4,
    version = reader.number(4, true),
    clockWord = reader.number(4, true);
  if (version !== 0x150 && version !== 0x151)
    throw new Error("VGM 1.50 or 1.51 is required. Export an SN76489 VGM 1.5x file.");
  if (bytes.length < 64 || eof > bytes.length || eof < 64)
    throw new Error("VGM header is truncated. Choose a complete file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getUint32(0x34, true),
    start = offset ? offset + 0x34 : 0x40;
  if (start < 64 || start >= eof)
    throw new Error("VGM data offset is invalid. Choose a complete file.");
  for (const [field, name] of Object.entries(CHIP_CLOCKS))
    if (Number(field) + 4 <= start && view.getUint32(Number(field), true))
      throw new Error(
        `This VGM uses ${name}. Export music for the SN76489 PSG chip or import MIDI.`,
      );
  if (!clockWord || clockWord & 0x40000000)
    throw new Error(
      "This VGM needs one SN76489 PSG chip. Export a single-chip SN76489 VGM or import MIDI.",
    );
  const clock = clockWord & 0x3fffffff;
  if (!clock) throw new Error("VGM PSG clock is invalid. Export a valid SN76489 VGM.");
  const input = new MusicReader(bytes, "VGM", start, eof);
  const divisors = [0, 0, 0],
    attenuation = [15, 15, 15, 15];
  let noise = 0,
    latch = 0,
    samples = 0,
    ended = false,
    stereo = false;
  let noiseRetrigger = false;
  const segments: { start: number; end: number; data: SoundEventDataInput }[][] = [[], [], [], []];
  function wait(length: number): void {
    const from = Math.round(samples / 735);
    samples += length;
    const to = Math.round(samples / 735);
    if (to <= from) return;
    for (let lane = 0; lane < 4; lane++) {
      const div = Math.max(
        1,
        Math.min(1023, Math.round((divisors[lane]! * PSG_BASE_FREQ * 32) / clock)),
      );
      const data: SoundEventDataInput =
        attenuation[lane] === 15
          ? { kind: "rest" }
          : lane === 3
            ? { kind: "noise", control: noise, attenuation: attenuation[lane]! }
            : divisors[lane] === 0
              ? {
                  kind: "raw",
                  toneLow: 0,
                  toneHigh: 0x80 | (lane << 5),
                  control: 0x90 | (lane << 5) | attenuation[lane]!,
                }
              : { kind: "tone", divisor: div, attenuation: attenuation[lane]! };
      const track = segments[lane]!,
        previous = track.at(-1);
      if (
        previous &&
        !(lane === 3 && noiseRetrigger) &&
        JSON.stringify(previous.data) === JSON.stringify(data)
      )
        previous.end = to;
      else track.push({ start: from, end: to, data });
    }
    noiseRetrigger = false;
  }
  while (input.position < input.end) {
    const command = input.byte();
    if (command === 0x50) {
      const value = input.byte();
      if (value & 128) latch = (value >> 4) & 7;
      const lane = latch >> 1;
      if (latch & 1) attenuation[lane] = value & 15;
      else if (lane === 3) {
        noise = value & 7;
        noiseRetrigger = true;
      } else if (value & 128) divisors[lane] = (divisors[lane]! & 0x3f0) | (value & 15);
      else divisors[lane] = (divisors[lane]! & 15) | ((value & 63) << 4);
    } else if (command === 0x61) wait(input.number(2, true));
    else if (command === 0x62) wait(735);
    else if (command === 0x63) wait(882);
    else if (command >= 0x70 && command <= 0x7f) wait((command & 15) + 1);
    else if (command === 0x4f) {
      input.byte();
      stereo = true;
    } else if (command === 0x66) {
      ended = true;
      break;
    } else
      throw new Error(
        `VGM command 0x${command.toString(16)} uses ${CHIP_COMMANDS[command] ?? "unsupported chip data"}. Export a single-chip SN76489 VGM or import MIDI.`,
      );
  }
  if (!ended) throw new Error("VGM end marker is missing. Choose a complete file.");
  if (!segments.flat().some((s) => s.data.kind !== "rest"))
    throw new Error("VGM has no playable PSG notes. Choose a recording with SN76489 notes.");
  let document = createSoundDocument(profileId ? { profileId } : undefined);
  for (let lane = 0; lane < 4; lane++)
    for (const segment of segments[lane]!)
      document = insertSoundSpan(
        document,
        lane,
        document.tracks()![lane]!.length,
        segment.end - segment.start,
        segment.data,
      );
  return {
    document,
    tempo: 120,
    summary: `Four PSG voices · One pass · Timing rounded to 60 Hz${Math.abs(clock - PSG_BASE_FREQ * 32) > 2 ? " · Pitches scaled to the game chip clock" : ""}${stereo ? " · Stereo folded to mono" : ""}`,
  };
}

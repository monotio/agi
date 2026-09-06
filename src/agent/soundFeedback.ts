/** Pure, bounded score/timeline feedback for compiled AGI sound resources. */
import { encodePngPaletteRgb } from "../picture/png.ts";
import { parseSound, PIT_BASE_FREQ } from "../sound/sound.ts";

const WIDTH = 800;
const HEIGHT = 400;
const PLOT_LEFT = 96;
const PLOT_RIGHT = 779;
const MUSIC_TOP = 54;
const MUSIC_BOTTOM = 300;
const NOISE_TOP = 338;
const NOISE_BOTTOM = 365;
const MAX_PREVIEW_TICKS = 20 * 60;
const MAX_PAYLOAD_BYTES = 65_535;
const MAX_EVENTS = 65_536;

const BACKGROUND = [15, 23, 42] as const;
const PANEL = [24, 35, 55] as const;
const GRID = [55, 69, 91] as const;
const TEXT = [226, 232, 240] as const;
const MUTED = [112, 128, 148] as const;
const CHANNEL_COLORS = [
  [56, 189, 248],
  [192, 132, 252],
  [251, 191, 36],
  [74, 222, 128],
] as const;
const CHANNEL_LABELS = ["tone 1", "tone 2", "tone 3", "noise"] as const;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOISE_NAMES: Record<string, string> = {
  "0": "periodic-high",
  "1": "periodic-medium",
  "2": "periodic-low",
  "3": "periodic-tone3-clock",
  "4": "white-high",
  "5": "white-medium",
  "6": "white-low",
  "7": "white-tone3-clock",
};

export interface SoundFeedbackOptions {
  num: number;
  channel: number | null;
  offset: number;
  limit: number;
  tempo?: number | undefined;
  /** Unknown/imported sounds default to a neutral sound-effects timeline. */
  representation?: "music" | "sound" | undefined;
}

export interface SoundFeedbackEvent {
  channel: number;
  index: number;
  tone: number | null;
  control: number;
  freqDivisor: number | null;
  duration: number;
  attenuation: number;
  noiseSelector?: number;
  noise?: string;
  rest: boolean;
  frequencyHz: number | null;
  startTick: number;
  endTick: number;
  startSeconds: number;
  durationSeconds: number;
  /** Human-facing loudness: 15 is loudest and 0 is silent. */
  volume: number;
  noteName?: string | null;
  midiNote?: number | null;
  centsOffset?: number | null;
  startBeat?: number;
  durationBeats?: number;
}

export interface SoundFeedbackChannel {
  channel: number;
  label: string;
  notes: number;
  durationTicks: number;
  durationSeconds: number;
}

export interface SoundFeedbackPreview {
  startTick: number;
  endTick: number;
  startSeconds: number;
  endSeconds: number;
  truncated: boolean;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
  width: number;
  height: number;
}

export interface SoundFeedback {
  events: SoundFeedbackEvent[];
  channels: SoundFeedbackChannel[];
  totalNotes: number;
  image: { png: Uint8Array; caption: string };
  preview: SoundFeedbackPreview;
}

type Color = readonly [number, number, number];

const GLYPHS: Record<string, string> = {
  " ": "000000000000000",
  A: "010101111101101",
  B: "110101110101110",
  C: "011100100100011",
  D: "110101101101110",
  E: "111100110100111",
  F: "111100110100100",
  G: "011100101101011",
  H: "101101111101101",
  I: "111010010010111",
  J: "001001001101010",
  K: "101101110101101",
  L: "100100100100111",
  M: "101111111101101",
  N: "101111111111101",
  O: "010101101101010",
  P: "110101110100100",
  Q: "010101101111011",
  R: "110101110101101",
  S: "011100010001110",
  T: "111010010010010",
  U: "101101101101111",
  V: "101101101101010",
  W: "101101111111101",
  X: "101101010101101",
  Y: "101101010010010",
  Z: "111001010100111",
  "0": "111101101101111",
  "1": "010110010010111",
  "2": "110001010100111",
  "3": "110001010001110",
  "4": "101101111001001",
  "5": "111100110001110",
  "6": "011100110101010",
  "7": "111001010010010",
  "8": "010101010101010",
  "9": "010101011001110",
  "#": "101111101111101",
  ".": "000000000000010",
  ":": "000010000010000",
  "-": "000000111000000",
  "/": "001001010100100",
};

function put(rgb: Uint8Array, x: number, y: number, color: Color): void {
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  const at = (y * WIDTH + x) * 3;
  rgb[at] = color[0];
  rgb[at + 1] = color[1];
  rgb[at + 2] = color[2];
}

function rect(
  rgb: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  color: Color,
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(WIDTH, Math.ceil(x + width));
  const y1 = Math.min(HEIGHT, Math.ceil(y + height));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) put(rgb, px, py, color);
  }
}

function hline(rgb: Uint8Array, x0: number, x1: number, y: number, color: Color): void {
  for (let x = Math.max(0, x0); x <= Math.min(WIDTH - 1, x1); x++) put(rgb, x, y, color);
}

function vline(rgb: Uint8Array, x: number, y0: number, y1: number, color: Color): void {
  for (let y = Math.max(0, y0); y <= Math.min(HEIGHT - 1, y1); y++) put(rgb, x, y, color);
}

function text(rgb: Uint8Array, x: number, y: number, value: string, color: Color, scale = 2): void {
  let cursor = x;
  for (const raw of value.toUpperCase()) {
    const glyph = GLYPHS[raw] ?? GLYPHS[" "]!;
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy * 3 + gx] !== "1") continue;
        rect(rgb, cursor + gx * scale, y + gy * scale, scale, scale, color);
      }
    }
    cursor += 4 * scale;
  }
}

function noteName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function musicPitchBounds(
  events: readonly SoundFeedbackEvent[],
  startTick: number,
  endTick: number,
): [number, number] {
  const notes = events.flatMap((event) =>
    event.channel < 3 &&
    !event.rest &&
    event.midiNote !== null &&
    event.midiNote !== undefined &&
    overlaps(event, startTick, endTick)
      ? [event.midiNote]
      : [],
  );
  if (notes.length === 0) return [48, 72];
  let lower = Math.floor((Math.min(...notes) - 1) / 12) * 12;
  const upper = Math.ceil((Math.max(...notes) + 1) / 12) * 12;
  while (upper - lower < 24) lower -= 12;
  return [lower, upper];
}

function musicPitchY(midi: number, lower: number, upper: number): number {
  return MUSIC_BOTTOM - Math.round(((midi - lower) / (upper - lower)) * (MUSIC_BOTTOM - MUSIC_TOP));
}

function pageLabel(offset: number, returned: number, total: number): string {
  if (returned === 0) return `no events returned from offset ${offset} of ${total}`;
  if (returned === 1) return `event ${offset + 1} of ${total}`;
  return `events ${offset + 1}-${offset + returned} of ${total}`;
}

function timeX(tick: number, startTick: number, endTick: number): number {
  const span = Math.max(1, endTick - startTick);
  return PLOT_LEFT + Math.round(((tick - startTick) / span) * (PLOT_RIGHT - PLOT_LEFT));
}

function overlaps(event: SoundFeedbackEvent, startTick: number, endTick: number): boolean {
  return event.endTick > startTick && event.startTick < endTick;
}

function drawTimeGrid(rgb: Uint8Array, startTick: number, endTick: number, top: number): void {
  for (let part = 0; part <= 4; part++) {
    const x = PLOT_LEFT + Math.round(((PLOT_RIGHT - PLOT_LEFT) * part) / 4);
    vline(rgb, x, top, NOISE_BOTTOM, GRID);
    const seconds = (startTick + ((endTick - startTick) * part) / 4) / 60;
    text(rgb, x - 20, 374, `${seconds.toFixed(1)}S`, MUTED, 2);
  }
}

function eventX(event: SoundFeedbackEvent, startTick: number, endTick: number): [number, number] {
  const x0 = Math.max(PLOT_LEFT, timeX(Math.max(event.startTick, startTick), startTick, endTick));
  const x1 = Math.min(PLOT_RIGHT, timeX(Math.min(event.endTick, endTick), startTick, endTick));
  return [x0, Math.max(x0 + 2, x1)];
}

function renderMusic(
  num: number,
  events: readonly SoundFeedbackEvent[],
  startTick: number,
  endTick: number,
): Uint8Array {
  const [pitchLower, pitchUpper] = musicPitchBounds(events, startTick, endTick);
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  rect(rgb, 0, 0, WIDTH, HEIGHT, BACKGROUND);
  rect(rgb, PLOT_LEFT, MUSIC_TOP, PLOT_RIGHT - PLOT_LEFT + 1, MUSIC_BOTTOM - MUSIC_TOP + 1, PANEL);
  rect(rgb, PLOT_LEFT, NOISE_TOP, PLOT_RIGHT - PLOT_LEFT + 1, NOISE_BOTTOM - NOISE_TOP + 1, PANEL);
  text(rgb, 16, 14, `SOUND ${num}  MUSIC PIANO ROLL`, TEXT, 2);
  for (let channel = 0; channel < 4; channel++) {
    text(rgb, 438 + channel * 88, 18, CHANNEL_LABELS[channel]!, CHANNEL_COLORS[channel]!, 2);
  }
  drawTimeGrid(rgb, startTick, endTick, MUSIC_TOP);
  for (let midi = pitchLower; midi <= pitchUpper; midi += 12) {
    const y = musicPitchY(midi, pitchLower, pitchUpper);
    hline(rgb, PLOT_LEFT, PLOT_RIGHT, y, GRID);
    text(rgb, 63, y - 5, noteName(midi), MUTED, 2);
  }
  text(rgb, 8, NOISE_TOP + 7, "NOISE", MUTED, 2);
  text(rgb, 56, 307, "REST", MUTED, 2);

  for (const event of events) {
    if (!overlaps(event, startTick, endTick)) continue;
    const [x0, x1] = eventX(event, startTick, endTick);
    const color = CHANNEL_COLORS[event.channel]!;
    if (event.channel === 3) {
      if (event.rest) hline(rgb, x0, x1, NOISE_BOTTOM - 2, MUTED);
      else {
        rect(rgb, x0, NOISE_TOP + 7, x1 - x0 + 1, 13, color);
        if (x1 - x0 >= 88) text(rgb, x0 + 4, NOISE_TOP + 9, event.noise ?? "NOISE", BACKGROUND, 2);
      }
      continue;
    }
    if (event.rest || event.midiNote === null || event.midiNote === undefined) {
      hline(rgb, x0, x1, 315 + event.channel * 4, MUTED);
      continue;
    }
    const y = musicPitchY(event.midiNote, pitchLower, pitchUpper);
    const stripeY = y + [-4, 0, 4][event.channel]!;
    rect(rgb, x0, stripeY - 1, x1 - x0 + 1, 3, color);
    if (x1 - x0 >= 40 + event.channel * 24)
      text(rgb, x0 + 4 + event.channel * 24, stripeY - 12, event.noteName ?? "", color, 2);
  }
  return encodePngPaletteRgb(WIDTH, HEIGHT, rgb);
}

function soundFrequencyY(frequency: number, top: number, bottom: number): number {
  if (frequency <= 0) return bottom - 2;
  const ratio = Math.log(Math.max(50, Math.min(5000, frequency)) / 50) / Math.log(100);
  return bottom - Math.round(ratio * (bottom - top));
}

function renderSound(
  num: number,
  events: readonly SoundFeedbackEvent[],
  startTick: number,
  endTick: number,
): Uint8Array {
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  rect(rgb, 0, 0, WIDTH, HEIGHT, BACKGROUND);
  text(rgb, 16, 14, `SOUND ${num}  PULSE / NOISE TIMELINE`, TEXT, 2);
  const laneTops = [54, 130, 206, 304];
  const laneBottoms = [116, 192, 268, 365];
  for (let channel = 0; channel < 4; channel++) {
    const top = laneTops[channel]!;
    const bottom = laneBottoms[channel]!;
    rect(rgb, PLOT_LEFT, top, PLOT_RIGHT - PLOT_LEFT + 1, bottom - top + 1, PANEL);
    text(rgb, 8, top + 4, CHANNEL_LABELS[channel]!, CHANNEL_COLORS[channel]!, 2);
    if (channel < 3) {
      for (const [frequency, label] of [
        [50, "50"],
        [440, "440"],
        [5000, "5K"],
      ] as const) {
        const y = soundFrequencyY(frequency, top + 5, bottom - 5);
        hline(rgb, PLOT_LEFT, PLOT_RIGHT, y, GRID);
        text(rgb, 68, y - 5, label, MUTED, 2);
      }
    }
  }
  drawTimeGrid(rgb, startTick, endTick, laneTops[0]!);

  for (const event of events) {
    if (!overlaps(event, startTick, endTick)) continue;
    const [x0, x1] = eventX(event, startTick, endTick);
    const top = laneTops[event.channel]!;
    const bottom = laneBottoms[event.channel]!;
    const color = CHANNEL_COLORS[event.channel]!;
    if (event.channel === 3) {
      if (event.rest) hline(rgb, x0, x1, bottom - 2, MUTED);
      else {
        const height = Math.max(2, Math.round(((bottom - top - 18) * event.volume) / 15));
        rect(rgb, x0, bottom - 9 - height, x1 - x0 + 1, height, color);
        if (x1 - x0 >= 104)
          text(
            rgb,
            x0 + 4,
            bottom - 7 - height,
            `V${event.volume} ${event.noise ?? "NOISE"}`,
            BACKGROUND,
            2,
          );
      }
    } else {
      const y = soundFrequencyY(event.frequencyHz ?? 0, top + 5, bottom - 5);
      if (event.rest) hline(rgb, x0, x1, bottom - 2, MUTED);
      else {
        const thickness = Math.max(1, Math.ceil(event.volume / 3));
        rect(rgb, x0, y - Math.floor(thickness / 2), x1 - x0 + 1, thickness, color);
        if (x1 - x0 >= 32) text(rgb, x0 + 4, y - 12, `V${event.volume}`, color, 2);
      }
    }
  }
  return encodePngPaletteRgb(WIDTH, HEIGHT, rgb);
}

function checkedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`${label} must be an integer in ${min}..${max}.`);
  return value;
}

/** Decode, enrich, page, and visualize a compiled four-channel AGI sound. */
export function soundFeedback(payload: Uint8Array, options: SoundFeedbackOptions): SoundFeedback {
  if (payload.length > MAX_PAYLOAD_BYTES)
    throw new RangeError(`Sound feedback payload exceeds ${MAX_PAYLOAD_BYTES} bytes.`);
  const num = checkedInteger(options.num, "Sound number", 0, 255);
  const channel =
    options.channel === null ? null : checkedInteger(options.channel, "Channel", 0, 3);
  const offset = checkedInteger(options.offset, "Offset", 0, 65_535);
  const limit = checkedInteger(options.limit, "Limit", 1, 64);
  const representation = options.representation ?? "sound";
  if (representation !== "music" && representation !== "sound")
    throw new RangeError("Sound representation must be 'music' or 'sound'.");
  const tempo = options.tempo;
  if (tempo !== undefined && (!Number.isFinite(tempo) || tempo <= 0))
    throw new RangeError("Sound tempo must be a positive finite number.");

  const sound = parseSound(payload);
  const allByChannel: SoundFeedbackEvent[][] = sound.channels.map((item) => {
    let onset = 0;
    return item.notes.map((note, index) => {
      const startTick = onset;
      onset += note.duration;
      const noiseSelector = item.channelIndex === 3 ? (note.tone >> 8) & 0x07 : undefined;
      const rest =
        item.channelIndex === 3
          ? note.attenuation === 15
          : note.attenuation === 15 || note.freqDivisor === 0;
      const frequencyHz =
        item.channelIndex === 3
          ? null
          : note.freqDivisor === 0
            ? 0
            : PIT_BASE_FREQ / note.freqDivisor;
      const event: SoundFeedbackEvent = {
        channel: item.channelIndex,
        index,
        tone: item.channelIndex === 3 ? null : note.tone,
        control: note.control,
        freqDivisor: item.channelIndex === 3 ? null : note.freqDivisor,
        duration: note.duration,
        attenuation: note.attenuation,
        ...(noiseSelector === undefined
          ? {}
          : {
              noiseSelector,
              noise: NOISE_NAMES[String(noiseSelector)] ?? `unknown-${noiseSelector}`,
            }),
        rest,
        frequencyHz,
        startTick,
        endTick: onset,
        startSeconds: startTick / 60,
        durationSeconds: note.duration / 60,
        volume: rest ? 0 : 15 - note.attenuation,
      };
      if (representation === "music") {
        if (item.channelIndex < 3) {
          if (rest || frequencyHz === null || frequencyHz <= 0) {
            event.noteName = null;
            event.midiNote = null;
            event.centsOffset = null;
          } else {
            const exactMidi = 69 + 12 * Math.log2(frequencyHz / 440);
            const midi = Math.round(exactMidi);
            event.noteName = noteName(midi);
            event.midiNote = midi;
            event.centsOffset = (exactMidi - midi) * 100;
          }
        }
        if (tempo !== undefined) {
          event.startBeat = (startTick * tempo) / 3600;
          event.durationBeats = (note.duration * tempo) / 3600;
        }
      }
      return event;
    });
  });
  const eventCount = allByChannel.reduce((sum, events) => sum + events.length, 0);
  if (eventCount > MAX_EVENTS)
    throw new RangeError(`Sound feedback exceeds ${MAX_EVENTS} decoded events.`);

  const selectedChannels = channel === null ? sound.channels : [sound.channels[channel]!];
  const selectedEvents = channel === null ? allByChannel.flat() : allByChannel[channel]!;
  const events = selectedEvents.slice(offset, offset + limit);
  let startTick = sound.duration;
  let pageEndTick = sound.duration;
  if (events.length > 0) {
    startTick = Math.min(...events.map((event) => event.startTick));
    pageEndTick = Math.max(...events.map((event) => event.endTick));
  }
  const endTick = Math.min(pageEndTick, startTick + MAX_PREVIEW_TICKS);
  const truncatedBefore = startTick > 0;
  const truncatedAfter = endTick < sound.duration || endTick < pageEndTick;
  const preview: SoundFeedbackPreview = {
    startTick,
    endTick,
    startSeconds: startTick / 60,
    endSeconds: endTick / 60,
    truncated:
      truncatedBefore ||
      truncatedAfter ||
      offset > 0 ||
      offset + events.length < selectedEvents.length,
    truncatedBefore,
    truncatedAfter,
    width: WIDTH,
    height: HEIGHT,
  };
  const concurrentEvents = allByChannel.flat();
  const selection = channel === null ? "all channels" : CHANNEL_LABELS[channel]!;
  const pitchBounds = musicPitchBounds(concurrentEvents, startTick, endTick);
  const kind =
    representation === "music"
      ? `estimated-pitch piano roll, pitch range ${noteName(pitchBounds[0])}-${noteName(pitchBounds[1])}`
      : "pulse / noise sound timeline, log frequency range 50-5000 Hz (values outside the range clamp to its bounds; bar thickness and height show volume 0-15)";
  const cap = endTick < pageEndTick ? " Preview capped at 20.00 seconds." : "";
  const caption = `Sound ${num} ${kind}, ${preview.startSeconds.toFixed(2)}-${preview.endSeconds.toFixed(2)} seconds (ticks ${startTick}-${endTick}); ${pageLabel(offset, events.length, selectedEvents.length)} selected ${selection}. Includes concurrent events from all channels.${cap}`;
  const png =
    representation === "music"
      ? renderMusic(num, concurrentEvents, startTick, endTick)
      : renderSound(num, concurrentEvents, startTick, endTick);
  return {
    events,
    channels: selectedChannels.map((item) => ({
      channel: item.channelIndex,
      label: CHANNEL_LABELS[item.channelIndex]!,
      notes: item.notes.length,
      durationTicks: item.totalDuration,
      durationSeconds: item.totalDuration / 60,
    })),
    totalNotes: selectedEvents.length,
    image: { png, caption },
    preview,
  };
}

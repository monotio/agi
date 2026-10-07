import { writeFileSync } from "node:fs";
import { expect, test } from "../test.ts";
import { buildTutorial } from "../../../games/adventure-department/game.ts";
import { openContainer } from "../../../src/container/container.ts";
import { PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";
import { SoundPlayback } from "../../../src/sound/sound.ts";
import type { SoundTick } from "../../src/audio/soundTiming.ts";

/**
 * Spectrograms of the tutorial's own SOUND resources, rendered the way the
 * game plays them: the interpreter's SoundPlayback emits each platform's
 * register writes per 60 Hz tick, and the shipped AgiAudio graph renders
 * them in an OfflineAudioContext. Only original project SOUNDs appear here.
 */

const SAMPLE_RATE = 48000;
/** AgiAudio schedules every tick two ticks ahead (SOUND_LOOKAHEAD_SECONDS). */
const LOOKAHEAD = 2 / 60;
const TAIL_SECONDS = 0.15;

interface Platform {
  label: string;
  detail: string;
  profile: ProfileId;
  device: number;
}

const PLATFORMS: Platform[] = [
  { label: "PC speaker", detail: "one voice", profile: "2.936", device: 0 },
  { label: "PCjr and Tandy", detail: "three voices and noise", profile: "2.936", device: 1 },
  { label: "Amiga", detail: "Paula, four sampled voices", profile: "amiga-2.310", device: 1 },
];

const SOUNDS = [
  { num: 1, label: "SOUND 1 · opening music" },
  { num: 3, label: "SOUND 3 · lever" },
];

/** Every tick's register writes until the stream completes. */
function packets(payload: Uint8Array, platform: Platform): SoundTick[] {
  const playback = new SoundPlayback(PROFILES[platform.profile], payload, platform.device);
  const out: SoundTick[] = [];
  for (let tick = 0; tick < 60 * 30; tick++) {
    const { outputs, complete } = playback.tick(true, 0);
    out.push({ stream: "media", tick, outputs, complete });
    if (complete) break;
  }
  return out;
}

test("sound-platforms", async ({ page }) => {
  const container = openContainer(new Map(Object.entries(buildTutorial().files)));
  const renders = SOUNDS.map((sound) => {
    const payload = container.getResource("sound", sound.num);
    if (!payload) throw new Error(`Tutorial SOUND ${sound.num} is missing`);
    const streams = PLATFORMS.map((platform) => packets(payload, platform));
    const seconds = Math.max(...streams.map((stream) => stream.length)) / 60 + TAIL_SECONDS;
    return { label: sound.label, seconds, streams };
  });

  await page.goto("/");
  const png = await page.evaluate(
    async ({ renders, platforms, sampleRate, lookahead }) => {
      const { AgiAudio } = await import("/src/audio/AgiAudio.ts");

      async function render(stream: SoundTick[], seconds: number): Promise<Float32Array> {
        // The PSG noise source draws Math.random; a fixed sequence keeps the figure stable.
        const random = Math.random;
        let state = 1;
        Math.random = () => {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          return state / 4294967296;
        };
        const frames = Math.ceil((seconds + lookahead) * sampleRate);
        const ctx = new OfflineAudioContext(1, frames, sampleRate);
        const audio = new AgiAudio({
          volume: 1,
          contextFactory: () => ctx as unknown as AudioContext,
        });
        for (const packet of stream) audio.outputTick(packet);
        const buffer = await ctx.startRendering();
        Math.random = random;
        // Time zero is the first tick, after the scheduling cushion.
        return buffer.getChannelData(0).slice(Math.round(lookahead * sampleRate));
      }

      const WINDOW = 2048;
      const FFT = 8192;
      const hann = Float64Array.from(
        { length: WINDOW },
        (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (WINDOW - 1)),
      );
      /** Power spectrum of the window centred at `centre`, zero-padded to FFT. */
      function spectrum(pcm: Float32Array, centre: number): Float64Array {
        const re = new Float64Array(FFT);
        const im = new Float64Array(FFT);
        for (let n = 0; n < WINDOW; n++) re[n] = (pcm[centre - WINDOW / 2 + n] ?? 0) * hann[n]!;
        for (let i = 1, j = 0; i < FFT; i++) {
          let bit = FFT >> 1;
          for (; j & bit; bit >>= 1) j ^= bit;
          j ^= bit;
          if (i < j) {
            [re[i], re[j]] = [re[j]!, re[i]!];
            [im[i], im[j]] = [im[j]!, im[i]!];
          }
        }
        for (let length = 2; length <= FFT; length *= 2) {
          const step = (-2 * Math.PI) / length;
          for (let start = 0; start < FFT; start += length)
            for (let k = 0; k < length / 2; k++) {
              const cos = Math.cos(step * k);
              const sin = Math.sin(step * k);
              const a = start + k;
              const b = a + length / 2;
              const tr = re[b]! * cos - im[b]! * sin;
              const ti = re[b]! * sin + im[b]! * cos;
              re[b] = re[a]! - tr;
              im[b] = im[a]! - ti;
              re[a] = re[a]! + tr;
              im[a] = im[a]! + ti;
            }
        }
        const power = new Float64Array(FFT / 2);
        for (let k = 0; k < FFT / 2; k++) power[k] = re[k]! ** 2 + im[k]! ** 2;
        return power;
      }

      // Layout in output pixels; GitHub shows README images about 880 px wide.
      const PX_PER_SECOND = 250;
      const PLOT_HEIGHT = 190;
      const LEFT = 92;
      const GAP = 44;
      const TOP = 132;
      const ROW = PLOT_HEIGHT + 92;
      const COLOUR_BAR = 120;
      const widths = renders.map((r) => Math.round(r.seconds * PX_PER_SECOND));
      const width =
        LEFT + widths.reduce((sum, w) => sum + w, 0) + GAP * (renders.length - 1) + COLOUR_BAR;
      const height = TOP + ROW * platforms.length + 8;
      const MIN_HZ = 60;
      const MAX_HZ = 12000;
      const FLOOR_DB = -80;

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext("2d")!;
      const ink = "#e4efed";
      const muted = "#9bb5b1";
      const font = (size: number, weight = 400) =>
        `${weight} ${size}px "Inter", "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
      g.fillStyle = "#0e1b1d";
      g.fillRect(0, 0, width, height);
      g.fillStyle = ink;
      g.font = font(26, 600);
      g.textBaseline = "alphabetic";
      g.fillText("Adventure Department SOUNDs, as each platform plays them", LEFT, 42);
      g.fillStyle = muted;
      g.font = font(18);
      g.fillText(
        "Rendered through the app's own audio path from the interpreter's register writes",
        LEFT,
        70,
      );

      /** Approximates the inferno colour map from dark (silence) to pale yellow (loud). */
      const stops = [
        [0, [14, 27, 29]],
        [0.18, [40, 11, 84]],
        [0.38, [120, 28, 109]],
        [0.58, [204, 66, 72]],
        [0.78, [246, 140, 30]],
        [1, [252, 245, 160]],
      ] as const;
      function colour(t: number): [number, number, number] {
        const x = Math.max(0, Math.min(1, t));
        for (let i = 1; i < stops.length; i++) {
          const [p1, c1] = stops[i]!;
          const [p0, c0] = stops[i - 1]!;
          if (x <= p1) {
            const f = (x - p0) / (p1 - p0);
            return [0, 1, 2].map((c) => Math.round(c0[c]! + (c1[c]! - c0[c]!) * f)) as [
              number,
              number,
              number,
            ];
          }
        }
        return [252, 245, 160];
      }
      const yOf = (hz: number) =>
        PLOT_HEIGHT * (1 - Math.log(hz / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ));

      // Render every panel first; one reference level keeps the platforms comparable.
      const panels: { column: number; row: number; power: Float64Array[] }[] = [];
      let peak = 0;
      for (const [column, sound] of renders.entries())
        for (const [row, stream] of sound.streams.entries()) {
          const pcm = await render(stream, sound.seconds);
          const power: Float64Array[] = [];
          for (let x = 0; x < widths[column]!; x++) {
            const p = spectrum(pcm, Math.round(((x + 0.5) / PX_PER_SECOND) * sampleRate));
            for (const value of p) peak = Math.max(peak, value);
            power.push(p);
          }
          panels.push({ column, row, power });
        }

      for (const { column, row, power } of panels) {
        const x0 = LEFT + widths.slice(0, column).reduce((s, w) => s + w, 0) + GAP * column;
        const y0 = TOP + ROW * row + 46;
        const image = g.createImageData(widths[column]!, PLOT_HEIGHT);
        for (let x = 0; x < power.length; x++)
          for (let y = 0; y < PLOT_HEIGHT; y++) {
            // Each pixel row spans a band of bins on the log axis; keep its strongest.
            const hzTop = MIN_HZ * (MAX_HZ / MIN_HZ) ** (1 - y / PLOT_HEIGHT);
            const hzBottom = MIN_HZ * (MAX_HZ / MIN_HZ) ** (1 - (y + 1) / PLOT_HEIGHT);
            const lo = Math.floor((hzBottom * FFT) / sampleRate);
            const hi = Math.max(lo, Math.ceil((hzTop * FFT) / sampleRate));
            let value = 0;
            for (let k = lo; k <= hi; k++) value = Math.max(value, power[x]![k] ?? 0);
            const db = 10 * Math.log10(value / peak + 1e-12);
            const [r, gr, b] = colour(1 - db / FLOOR_DB);
            const at = (y * widths[column]! + x) * 4;
            image.data.set([r, gr, b, 255], at);
          }
        g.putImageData(image, x0, y0);
        g.strokeStyle = "#3a5753";
        g.lineWidth = 1;
        g.strokeRect(x0 - 0.5, y0 - 0.5, widths[column]! + 1, PLOT_HEIGHT + 1);

        // Panel heading: the platform on the first column, the SOUND on the first row.
        g.textBaseline = "alphabetic";
        if (row === 0) {
          g.fillStyle = ink;
          g.font = font(20, 600);
          g.fillText(renders[column]!.label, x0, TOP - 4);
        }
        if (column === 0) {
          g.fillStyle = ink;
          g.font = font(20, 600);
          g.fillText(platforms[row]!.label, x0, y0 - 14);
          const labelWidth = g.measureText(platforms[row]!.label).width;
          g.fillStyle = muted;
          g.font = font(18);
          g.fillText(`  ${platforms[row]!.detail}`, x0 + labelWidth, y0 - 14);
        }

        // Frequency axis: log scale, labelled on the first column.
        g.font = font(15);
        g.textBaseline = "middle";
        for (const hz of [100, 200, 500, 1000, 2000, 5000, 10000]) {
          const y = y0 + yOf(hz);
          g.strokeStyle = "rgba(228,239,237,0.16)";
          g.beginPath();
          g.moveTo(x0, Math.round(y) + 0.5);
          g.lineTo(x0 + widths[column]!, Math.round(y) + 0.5);
          g.stroke();
          if (column === 0) {
            g.fillStyle = muted;
            g.textAlign = "right";
            g.fillText(hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`, x0 - 8, y);
          }
        }
        // Time axis in seconds under each panel.
        g.textAlign = "center";
        g.textBaseline = "top";
        const seconds = renders[column]!.seconds;
        const step = seconds > 2 ? 0.5 : 0.25;
        for (let t = 0; t <= seconds + 1e-9; t += step) {
          const x = x0 + t * PX_PER_SECOND;
          g.strokeStyle = "#3a5753";
          g.beginPath();
          g.moveTo(Math.round(x) + 0.5, y0 + PLOT_HEIGHT);
          g.lineTo(Math.round(x) + 0.5, y0 + PLOT_HEIGHT + 5);
          g.stroke();
          g.fillStyle = muted;
          g.fillText(`${Number(t.toFixed(2))} s`, x, y0 + PLOT_HEIGHT + 8);
        }
        g.textAlign = "left";
      }

      // Colour scale: decibels below the loudest moment in the figure.
      const barX = width - COLOUR_BAR + 36;
      const barY = TOP + 46;
      const barHeight = PLOT_HEIGHT * 2;
      for (let y = 0; y < barHeight; y++) {
        const [r, gr, b] = colour(1 - y / barHeight);
        g.fillStyle = `rgb(${r},${gr},${b})`;
        g.fillRect(barX, barY + y, 18, 1);
      }
      g.strokeStyle = "#3a5753";
      g.strokeRect(barX - 0.5, barY - 0.5, 19, barHeight + 1);
      g.fillStyle = muted;
      g.font = font(15);
      g.textBaseline = "middle";
      for (const db of [0, -20, -40, -60, -80])
        g.fillText(`${db} dB`, barX + 26, barY + (barHeight * db) / FLOOR_DB);

      // An indexed PNG keeps the figure small: every pixel takes the nearest
      // of the colour map's levels or a blend of the text colours.
      const palette: number[][] = [];
      for (let i = 0; i < 160; i++) palette.push(colour(i / 159));
      for (const fg of [ink, muted, "#3a5753"].map((hex) =>
        [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)),
      ))
        for (let i = 1; i <= 24; i++)
          palette.push([0, 1, 2].map((c) => Math.round(14 + ((fg[c]! - 14) * i) / 24)));
      const pixels = g.getImageData(0, 0, width, height);
      const cache = new Map<number, number[]>();
      for (let at = 0; at < pixels.data.length; at += 4) {
        const key = (pixels.data[at]! << 16) | (pixels.data[at + 1]! << 8) | pixels.data[at + 2]!;
        let best = cache.get(key);
        if (!best) {
          let distance = Infinity;
          for (const candidate of palette) {
            const d =
              (candidate[0]! - pixels.data[at]!) ** 2 +
              (candidate[1]! - pixels.data[at + 1]!) ** 2 +
              (candidate[2]! - pixels.data[at + 2]!) ** 2;
            if (d < distance) [distance, best] = [d, candidate];
          }
          cache.set(key, best!);
        }
        pixels.data.set(best!, at);
      }
      g.putImageData(pixels, 0, 0);
      return canvas.toDataURL("image/png").split(",")[1]!;
    },
    {
      renders,
      platforms: PLATFORMS.map(({ label, detail }) => ({ label, detail })),
      sampleRate: SAMPLE_RATE,
      lookahead: LOOKAHEAD,
    },
  );
  const bytes = Buffer.from(png, "base64");
  expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  writeFileSync(test.info().outputPath("sound-platforms.png"), bytes);
});

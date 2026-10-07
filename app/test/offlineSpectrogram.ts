import type { Page } from "@playwright/test";
import {
  AMIGA_TONE_SAMPLE,
  AMIGA_2082_TONE_SAMPLE,
  AMIGA_2082_NOISE_BYTES,
  amigaNoisePcm,
} from "../../src/sound/sound.ts";
import type { SoundTick } from "../src/audio/soundTiming.ts";

/** Independent zero-order DAC reference; no production phase clock or resampler. */
export function paulaReference(
  packets: readonly SoundTick[],
  sampleRate = 48000,
  seconds = 30,
  region: "ntsc" | "pal" = "ntsc",
): Float32Array[] {
  const colourClock = region === "pal" ? 3546895 : 3579545;
  const early = packets.some((packet) =>
    packet.outputs.some((event) => event.kind === "paula" && event.driver === "2.082"),
  );
  const tone = early ? AMIGA_2082_TONE_SAMPLE : AMIGA_TONE_SAMPLE;
  const noise = amigaNoisePcm(early ? AMIGA_2082_NOISE_BYTES : undefined);
  const lanes = Array.from({ length: 4 }, (_, channel) => ({
    samples: channel === 3 ? noise : tone,
    pcm: new Float32Array(Math.round(seconds * sampleRate)),
    enabled: false,
    byte: 0,
    period: 65536 / colourClock,
    next: Infinity,
    stop: Infinity,
    volume: 0,
  }));
  const advance = (time: number) => {
    for (const lane of lanes)
      while (lane.enabled && lane.next <= time + 1e-12) {
        if (lane.next >= lane.stop - 1e-12) {
          lane.enabled = false;
          lane.next = Infinity;
        } else {
          lane.byte++;
          lane.next += lane.period;
        }
      }
  };
  let cursor = 0;
  for (let frame = 0; frame < lanes[0]!.pcm.length; frame++) {
    const time = frame / sampleRate;
    while (cursor < packets.length && packets[cursor]!.tick / 60 + 2 / 60 <= time + 1e-12) {
      const packet = packets[cursor++]!;
      const at = packet.tick / 60 + 2 / 60;
      advance(at);
      for (const event of packet.outputs)
        if (event.kind === "paula") {
          const lane = lanes[event.channel & 3]!;
          if (event.period === null) {
            if (lane.enabled && lane.stop === Infinity)
              lane.stop = lane.next + ((lane.byte + 1) & 1 ? lane.period : 0);
          } else {
            lane.period = (event.period === 0 ? 65536 : Math.max(124, event.period)) / colourClock;
            lane.volume = (Math.min(64, event.volume) / 64) * 0.4;
            lane.stop = Infinity;
            if (!lane.enabled) {
              lane.byte = 0;
              lane.next = at + lane.period;
              lane.enabled = true;
            }
          }
        }
    }
    advance(time);
    for (const lane of lanes)
      lane.pcm[frame] = (lane.samples[lane.byte % lane.samples.length]! / 128) * lane.volume;
  }
  return lanes.map((lane) => lane.pcm);
}

/** Amplitudes are full-scale PCM; 10 ms spectra have about 100 Hz resolution. */
export function boundaryMetrics(
  samples: readonly number[],
  at: number,
  sampleRate = 48000,
  steadyAt = at - 0.025,
) {
  const center = Math.round(at * sampleRate);
  const window = Math.round(0.002 * sampleRate);
  const mean = (start: number, size: number): number => {
    let sum = 0;
    for (let i = start; i < start + size; i++) sum += samples[i] ?? 0;
    return sum / size;
  };
  const beforeMean = mean(center - window, window);
  const afterMean = mean(center, window);
  const size = Math.round(0.01 * sampleRate);
  const lowBand = (start: number): number => {
    // Remove DC, then integrate the finite-window periodogram on a 20 Hz
    // grid. Zero padding improves integration, not frequency resolution.
    const dc = mean(start, size);
    let power = 0;
    for (let hz = 20; hz <= 800; hz += 20) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < size; n++) {
        const x = (samples[start + n] ?? 0) - dc;
        const angle = (2 * Math.PI * hz * n) / sampleRate;
        re += x * Math.cos(angle);
        im -= x * Math.sin(angle);
      }
      power += re * re + im * im;
    }
    return (2 * 20 * power) / (sampleRate * size);
  };
  let maxJump = 0;
  for (let i = center; i < center + Math.round(0.004 * sampleRate); i++)
    maxJump = Math.max(maxJump, Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0)));
  const lowEnergy = lowBand(center - Math.floor(size / 2));
  const steadyStart = Math.round(steadyAt * sampleRate);
  const steadyLowEnergy = lowBand(steadyStart);
  let steadyEnergy = 0;
  for (let i = steadyStart; i < steadyStart + size; i++)
    steadyEnergy += (samples[i] ?? 0) ** 2 / size;
  return {
    beforeMean,
    afterMean,
    step: Math.abs(afterMean - beforeMean),
    maxJump,
    lowEnergy,
    steadyLowEnergy,
    excessLowEnergy: Math.max(0, lowEnergy - steadyLowEnergy),
    steadyRms: Math.sqrt(steadyEnergy),
    // A 20 ms voice mean is reported separately from the 2 ms level proxy.
    voiceDc: mean(steadyStart, Math.round(0.02 * sampleRate)),
  };
}

/** Fixed-scale PNG for A/B inspection, computed from the rendered PCM itself. */
export async function offlineSpectrogram(page: Page, samples: number[]): Promise<Buffer> {
  const png = await page.evaluate((samples) => {
    const size = 512;
    const hop = 480;
    const width = Math.floor(samples.length / hop);
    const height = 256;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    const pixels = ctx.createImageData(width, height);
    for (let frame = 0; frame < width; frame++) {
      const re = new Float64Array(size);
      const im = new Float64Array(size);
      for (let n = 0; n < size; n++)
        re[n] =
          (samples[frame * hop + n] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (size - 1)));
      for (let i = 1, j = 0; i < size; i++) {
        let bit = size >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) [re[i], re[j]] = [re[j]!, re[i]!];
      }
      for (let length = 2; length <= size; length *= 2) {
        for (let start = 0; start < size; start += length) {
          for (let j = 0; j < length / 2; j++) {
            const angle = (-2 * Math.PI * j) / length;
            const a = start + j;
            const b = a + length / 2;
            const tr = re[b]! * Math.cos(angle) - im[b]! * Math.sin(angle);
            const ti = re[b]! * Math.sin(angle) + im[b]! * Math.cos(angle);
            re[b] = re[a]! - tr;
            im[b] = im[a]! - ti;
            re[a] = re[a]! + tr;
            im[a] = im[a]! + ti;
          }
        }
      }
      for (let bin = 0; bin < height; bin++) {
        const db = 10 * Math.log10((re[bin]! ** 2 + im[bin]! ** 2) / size ** 2 + 1e-20);
        const intensity = Math.max(0, Math.min(1, (db + 100) / 80));
        const pixel = ((height - 1 - bin) * width + frame) * 4;
        pixels.data[pixel] = 255 * intensity;
        pixels.data[pixel + 1] = 180 * intensity ** 2;
        pixels.data[pixel + 2] = 140 * Math.sqrt(intensity);
        pixels.data[pixel + 3] = 255;
      }
    }
    ctx.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1]!;
  }, samples);
  return Buffer.from(png, "base64");
}

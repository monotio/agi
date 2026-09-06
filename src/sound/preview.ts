/**
 * Bounded, deterministic offline preview of the profile-aware AGI sound stream.
 *
 * SoundPlayback remains the authority for event timing, device selection and
 * profile envelopes. The square waves and LFSR noise below are an intentionally
 * small approximation of analog output for previews, not exact AGI hardware audio.
 */

import type { AgiProfile } from "../runtime/profile.ts";
import { PIT_BASE_FREQ, SoundPlayback, type SoundOutput } from "./sound.ts";

const SAMPLE_RATE = 24000;
const SOUND_TICK_RATE = 60;
const SAMPLES_PER_TICK = SAMPLE_RATE / SOUND_TICK_RATE;
const DEFAULT_DURATION_SECONDS = 20;
const MAX_DURATION_SECONDS = 30;
const MAX_START_SECONDS = 300;

export interface SoundPreviewOptions {
  device?: "tandy" | "pc-speaker";
  startSeconds?: number;
  durationSeconds?: number;
}

export interface SoundPreview {
  wav: Uint8Array;
  sampleRate: number;
  durationSeconds: number;
  startSeconds: number;
  totalDurationSeconds: number;
  truncated: boolean;
  warnings: string[];
}

interface SynthState {
  speakerDivisor: number | null;
  speakerPhase: number;
  latchedRegister: number;
  toneDivisors: number[];
  toneAttenuations: number[];
  tonePhases: number[];
  noiseControl: number;
  noiseAttenuation: number;
  noisePhase: number;
  noiseLfsr: number;
  priorMixed: number;
  highPass: number;
}

function optionSeconds(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
  warnings: string[],
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) {
    warnings.push(`${name} must be finite; using ${fallback} seconds.`);
    return fallback;
  }
  if (value < 0) {
    warnings.push(`${name} cannot be negative; using 0 seconds.`);
    return 0;
  }
  if (value > maximum) {
    warnings.push(`${name} is capped at ${maximum} seconds.`);
    return maximum;
  }
  return value;
}

/** Determine recovered playback length without expanding duration-zero events into ticks. */
function playbackDurationTicks(payload: Uint8Array, channelCount: number): number {
  let maximum = 0;
  for (let channel = 0; channel < channelCount; channel++) {
    if (payload.length < 8) continue;
    let cursor = payload[channel * 2]! | (payload[channel * 2 + 1]! << 8);
    if (cursor < 8 || cursor + 2 > payload.length) continue;
    let ticks = 0;
    while (cursor + 2 <= payload.length) {
      const rawDuration = payload[cursor]! | (payload[cursor + 1]! << 8);
      cursor += 2;
      if (rawDuration === 0xffff) break;
      if (cursor + 3 > payload.length) break;
      cursor += 3;
      ticks += rawDuration === 0 ? 65536 : rawDuration;
    }
    maximum = Math.max(maximum, ticks);
  }
  return maximum;
}

function applyOutput(state: SynthState, output: SoundOutput): void {
  if (output.kind === "speaker") {
    state.speakerDivisor = output.divisor;
    return;
  }
  for (const raw of output.bytes) {
    const byte = raw & 255;
    const latch = (byte & 0x80) !== 0;
    if (latch) state.latchedRegister = (byte >> 4) & 7;
    const register = state.latchedRegister;
    const channel = register >> 1;
    if ((register & 1) !== 0) {
      if (channel < 3) state.toneAttenuations[channel] = byte & 15;
      else state.noiseAttenuation = byte & 15;
    } else if (channel < 3) {
      const prior = state.toneDivisors[channel]!;
      state.toneDivisors[channel] = latch
        ? (prior & 0x3f0) | (byte & 15)
        : (prior & 15) | ((byte & 63) << 4);
    } else {
      state.noiseControl = byte & 7;
    }
  }
}

function advancePhase(phase: number, frequency: number): number {
  phase += frequency / SAMPLE_RATE;
  return phase - Math.floor(phase);
}

function removeDc(state: SynthState, mixed: number): number {
  const filtered = mixed - state.priorMixed + state.highPass * 0.995;
  state.priorMixed = mixed;
  state.highPass = filtered;
  return Math.max(-0.95, Math.min(0.95, filtered));
}

function synthSample(state: SynthState, speaker: boolean): number {
  if (speaker) {
    const divisor = state.speakerDivisor;
    if (divisor === null || divisor <= 0) return removeDc(state, 0);
    const sample = state.speakerPhase < 0.5 ? 0.35 : -0.35;
    state.speakerPhase = advancePhase(state.speakerPhase, (PIT_BASE_FREQ * 12) / divisor);
    return removeDc(state, sample);
  }

  let mixed = 0;
  for (let channel = 0; channel < 3; channel++) {
    const divisor = state.toneDivisors[channel]!;
    const attenuation = state.toneAttenuations[channel]!;
    if (divisor <= 0 || attenuation === 15) continue;
    const gain = Math.pow(10, -attenuation / 10) * 0.16;
    mixed += state.tonePhases[channel]! < 0.5 ? gain : -gain;
    state.tonePhases[channel] = advancePhase(state.tonePhases[channel]!, PIT_BASE_FREQ / divisor);
  }

  if (state.noiseAttenuation !== 15) {
    const rate = state.noiseControl & 3;
    const divisor = state.toneDivisors[2]!;
    const frequency = rate === 3 ? PIT_BASE_FREQ / Math.max(1, divisor) : 4000 / (1 << rate);
    const gain = Math.pow(10, -state.noiseAttenuation / 10) * 0.14;
    mixed += (state.noiseLfsr & 1) !== 0 ? gain : -gain;
    state.noisePhase += frequency / SAMPLE_RATE;
    while (state.noisePhase >= 1) {
      const feedback =
        (state.noiseControl & 4) !== 0
          ? (state.noiseLfsr ^ (state.noiseLfsr >> 1)) & 1
          : state.noiseLfsr & 1;
      state.noiseLfsr = (state.noiseLfsr >> 1) | (feedback << 14);
      if (state.noiseLfsr === 0) state.noiseLfsr = 0x4000;
      state.noisePhase--;
    }
  }
  return removeDc(state, mixed);
}

function writeAscii(wav: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) wav[offset + index] = value.charCodeAt(index);
}

function encodeWav(samples: Int16Array): Uint8Array {
  const dataBytes = samples.length * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(wav, 8, "WAVE");
  writeAscii(wav, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(wav, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index++) {
    view.setInt16(44 + index * 2, samples[index]!, true);
  }
  return wav;
}

export function renderSoundPreview(
  payload: Uint8Array,
  profile: AgiProfile,
  options?: SoundPreviewOptions,
): SoundPreview {
  const warnings: string[] = [];
  const device = options?.device ?? "tandy";
  const speaker = device === "pc-speaker";
  const start = optionSeconds(
    options?.startSeconds,
    0,
    MAX_START_SECONDS,
    "startSeconds",
    warnings,
  );
  const requestedDuration = optionSeconds(
    options?.durationSeconds,
    DEFAULT_DURATION_SECONDS,
    MAX_DURATION_SECONDS,
    "durationSeconds",
    warnings,
  );
  const startSample = Math.floor(start * SAMPLE_RATE);
  const totalTicks = playbackDurationTicks(payload, speaker ? 1 : 4);
  const totalSamples = totalTicks * SAMPLES_PER_TICK;
  const sampleCount = Math.min(
    Math.floor(requestedDuration * SAMPLE_RATE),
    Math.max(0, totalSamples - startSample),
  );
  const playback = new SoundPlayback(profile, payload, speaker ? 0 : 1, (warning) => {
    warnings.push(warning);
  });
  const state: SynthState = {
    speakerDivisor: null,
    speakerPhase: 0,
    latchedRegister: 0,
    toneDivisors: [0, 0, 0],
    toneAttenuations: [15, 15, 15],
    tonePhases: [0, 0, 0],
    noiseControl: 0,
    noiseAttenuation: 15,
    noisePhase: 0,
    noiseLfsr: 0x4000,
    priorMixed: 0,
    highPass: 0,
  };
  const samples = new Int16Array(sampleCount);
  const endSample = sampleCount === 0 ? 0 : startSample + sampleCount;
  for (let absoluteSample = 0; absoluteSample < endSample; absoluteSample++) {
    if (absoluteSample % SAMPLES_PER_TICK === 0) {
      for (const output of playback.tick(true, 0).outputs) applyOutput(state, output);
    }
    const sample = synthSample(state, speaker);
    if (absoluteSample >= startSample) {
      samples[absoluteSample - startSample] = Math.round(sample * 32767);
    }
  }
  return {
    wav: encodeWav(samples),
    sampleRate: SAMPLE_RATE,
    durationSeconds: sampleCount / SAMPLE_RATE,
    startSeconds: startSample / SAMPLE_RATE,
    totalDurationSeconds: totalTicks / SOUND_TICK_RATE,
    truncated: startSample > 0 || startSample + sampleCount < totalSamples,
    warnings,
  };
}

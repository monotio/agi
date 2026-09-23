/**
 * Web Audio presentation of the engine's sound command stream.
 * Resource timing, channel selection, envelopes and completion belong to the
 * profile-aware core scheduler. Analog tone/noise synthesis is approximate.
 */
import {
  AMIGA_2082_NOISE_BYTES,
  AMIGA_2082_TONE_SAMPLE,
  AMIGA_TONE_SAMPLE,
  PIT_BASE_FREQ,
  amigaNoisePcm,
  type IigsOutput,
  type SoundOutput,
} from "../../../src/sound/sound.ts";
import { IigsSynth, iigsSources, type IigsSources } from "./iigsSynth.ts";

/**
 * The player's PC sound-chip preference, which is also the `soundDevice`
 * operand. Amiga and IIgs editions render by event kind whatever the
 * preference; see `soundFamily` in useAudioController.ts.
 */
export type AudioMode = "tandy" | "pc-speaker";

/** The PAL Paula clock; the driver's AUDxPER converts it to a sample rate. */
const PAULA_CLOCK = 3546895;

/**
 * Paula's audio DMA fetches one word per voice per scanline, so a voice
 * cannot take new samples faster than a period of about 124 colour clocks
 * (Amiga Hardware Reference Manual) — hardware behaviour, not driver
 * evidence. The 2.082 driver writes noise periods 6, 3 and 1
 * (docs/fidelity.md, "The older 2.082 driver"); they render at the limit.
 */
const PAULA_MIN_PERIOD = 124;
export class AgiAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private mode: AudioMode = "tandy";
  private volume: number = 0.5;
  private muted: boolean = false;
  private paused = false;
  private playing = false;
  private family: SoundOutput["kind"] | "paula-2.082" | null = null;
  private channelGains: GainNode[] = [];
  private oscillators: OscillatorNode[] = [];
  private noiseFilter: BiquadFilterNode | null = null;
  private readonly divisors = [0, 0, 0];
  private latchedRegister = 0;
  private paulaSources: AudioBufferSourceNode[] = [];
  /** The game's DOC RAM and instrument bank, when its files carry them. */
  private iigsSources: IigsSources | null = null;
  private iigsSynth: IigsSynth | null = null;
  /** Fallback voices without the bank: one triangle per sounding note. */
  private iigsFallback = new Map<number, { osc: OscillatorNode; gain: GainNode }>();
  private readonly contextFactory: (() => AudioContext) | undefined;
  private activeNodes: { stop?: () => void; disconnect: () => void }[] = [];

  constructor(options?: {
    mode?: AudioMode;
    volume?: number;
    muted?: boolean;
    contextFactory?: () => AudioContext;
  }) {
    this.contextFactory = options?.contextFactory;
    if (options?.mode) this.mode = options.mode;
    if (options?.volume !== undefined) this.volume = Math.max(0, Math.min(1, options.volume));
    if (options?.muted !== undefined) this.muted = options.muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get currentVolume(): number {
    return this.volume;
  }

  get currentMode(): AudioMode {
    return this.mode;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  setMode(mode: AudioMode): void {
    this.mode = mode;
    if (this.isPlaying) {
      this.stop();
    }
  }

  setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(
        this.muted || this.paused ? 0 : this.volume,
        this.ctx.currentTime,
      );
    }
  }

  setMuted(mute: boolean): void {
    this.muted = mute;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(
        this.muted || this.paused ? 0 : this.volume,
        this.ctx.currentTime,
      );
    }
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * Resumes AudioContext on user gesture to comply with browser autoplay policies.
   */
  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  private initContext(): AudioContext {
    if (!this.ctx) {
      if (this.contextFactory) this.ctx = this.contextFactory();
      else {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.ctx = new AudioCtx();
      }
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(
        this.muted || this.paused ? 0 : this.volume,
        this.ctx.currentTime,
      );
      this.masterGain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (this.masterGain && this.ctx)
      this.masterGain.gain.setValueAtTime(
        this.muted || paused ? 0 : this.volume,
        this.ctx.currentTime,
      );
  }

  /** Apply one authoritative sound-tick output. No separate playback clock or completion timer. */
  output(event: SoundOutput): void {
    // The two Amiga drivers loop different buffers; a source's buffer
    // cannot be reassigned, so a driver change rebuilds the voices.
    const family = event.kind === "paula" && event.driver === "2.082" ? "paula-2.082" : event.kind;
    if (this.family !== family) {
      this.stop();
      this.family = family;
    }
    const ctx = this.initContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    this.playing = true;
    const maxFreq = (ctx.sampleRate || 48000) / 2;
    if (event.kind === "iigs") {
      if (this.iigsSources) {
        this.iigsSynth ??= new IigsSynth(ctx, this.masterGain!, this.iigsSources);
        this.iigsSynth.output(event);
      } else this.iigsFallbackOutput(ctx, event, maxFreq);
      return;
    }
    if (event.kind === "paula") {
      if (!this.paulaSources.length) this.createPaulaChannels(ctx, event.driver === "2.082");
      const channel = event.channel & 3;
      const source = this.paulaSources[channel]!;
      // Paula steps the sample at clock / period bytes per second; a looping
      // source replays its buffer at context rate times playbackRate.
      if (event.period !== null && event.period > 0)
        source.playbackRate.setValueAtTime(
          PAULA_CLOCK / Math.max(PAULA_MIN_PERIOD, event.period) / ctx.sampleRate,
          ctx.currentTime,
        );
      // Both drivers write AUDxPER 0 for a rest (tone word 0) with the
      // volume its attenuation gives — KQ2's signed attack and 2.082's v23
      // make that nonzero. Inference: a zero period gives the voice no
      // audible pitch, so it renders silent (docs/fidelity.md, "Original
      // Amiga sound player"). AUDxVOL bit 6 is Paula's maximum; the
      // drivers only write 0..64, clamped here for safety.
      this.channelGains[channel]!.gain.setValueAtTime(
        event.period === null || event.period === 0 ? 0 : (Math.min(64, event.volume) / 64) * 0.4,
        ctx.currentTime,
      );
      return;
    }
    if (!this.channelGains.length) this.createChannels(ctx, event.kind === "speaker" ? 1 : 4);
    if (event.kind === "speaker") {
      const divisor = event.divisor;
      const rawFreq = divisor ? 1193180 / divisor : 0;
      this.oscillators[0]!.frequency.setValueAtTime(Math.min(maxFreq, rawFreq), ctx.currentTime);
      this.channelGains[0]!.gain.setValueAtTime(divisor === null ? 0 : 0.4, ctx.currentTime);
      return;
    }
    for (const raw of event.bytes) {
      const byte = raw & 255;
      const latch = (byte & 0x80) !== 0;
      if (latch) this.latchedRegister = (byte >> 4) & 7;
      const register = this.latchedRegister;
      const channel = register >> 1;
      if (register & 1) {
        // Attenuation registers are latch-only; data bytes are ignored (docs/fidelity.md: SN76489 attenuation latching and rest notes).
        if (!latch) continue;
        const attenuation = byte & 15;
        this.channelGains[channel]!.gain.setValueAtTime(
          attenuation === 15 ? 0 : Math.pow(10, -attenuation / 10) * 0.25,
          ctx.currentTime,
        );
      } else if (channel < 3) {
        this.divisors[channel] = latch
          ? (this.divisors[channel]! & 0x3f0) | (byte & 15)
          : (this.divisors[channel]! & 15) | ((byte & 63) << 4);
        const divisor = this.divisors[channel]!;
        const rawFreq = divisor ? PIT_BASE_FREQ / divisor : 0;
        this.oscillators[channel]!.frequency.setValueAtTime(
          Math.min(maxFreq, rawFreq),
          ctx.currentTime,
        );
      } else {
        // Noise control register is latch-only (docs/fidelity.md: SN76489 attenuation latching and rest notes).
        if (!latch) continue;
        // Noise timbre is a presentation approximation; command timing and gain are exact.
        const rate = byte & 3;
        const rawFreq =
          rate === 3 ? PIT_BASE_FREQ / Math.max(1, this.divisors[2]!) : 4000 / (1 << rate);
        this.noiseFilter!.frequency.setValueAtTime(Math.min(maxFreq, rawFreq), ctx.currentTime);
      }
    }
  }

  stop(): void {
    for (const node of this.activeNodes) {
      try {
        node.stop?.();
      } catch {
        /* A source can already have ended. */
      }
      node.disconnect();
    }
    this.activeNodes = [];
    this.channelGains = [];
    this.oscillators = [];
    this.noiseFilter = null;
    this.paulaSources = [];
    this.iigsSynth?.stop();
    for (const voice of this.iigsFallback.values()) voice.osc.stop();
    this.iigsFallback.clear();
    this.divisors.fill(0);
    this.latchedRegister = 0;
    this.playing = false;
    this.family = null;
  }

  /** Short attack/release on a parameter; falls back to a step in test doubles. */
  private ramp(param: AudioParam, target: number, seconds: number): void {
    const now = this.ctx!.currentTime;
    param.setValueAtTime(param.value, now);
    if (typeof param.linearRampToValueAtTime === "function")
      param.linearRampToValueAtTime(target, now + seconds);
    else param.setValueAtTime(target, now);
  }

  /**
   * The IIgs rendition for a game whose files lack SIERRASTANDARD or the
   * SYS16 bank (a data-only copy): a triangle per note, no samples.
   */
  private iigsFallbackOutput(ctx: AudioContext, event: IigsOutput, maxFreq: number): void {
    if (event.event === "all-off") {
      for (const voice of this.iigsFallback.values()) voice.osc.stop();
      this.iigsFallback.clear();
    } else if (event.event === "note-off") {
      const voice = this.iigsFallback.get(event.voice);
      voice?.osc.stop();
      this.iigsFallback.delete(event.voice);
    } else if (event.event === "note-on") {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime((event.volume / 127) * 0.3, ctx.currentTime);
      gain.connect(this.masterGain!);
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(
        Math.min(maxFreq, 440 * 2 ** ((event.note - 69) / 12)),
        ctx.currentTime,
      );
      osc.connect(gain);
      osc.start();
      this.iigsFallback.set(event.voice, { osc, gain });
    }
  }

  /** Read the IIgs wave RAM and instrument bank from a game's files at boot. */
  useGameFiles(files: Readonly<Record<string, Uint8Array>>): void {
    this.iigsSynth?.stop();
    this.iigsSynth = null;
    this.iigsSources = iigsSources(files);
  }

  /** Whether IIgs sound renders the game's own instruments. */
  get iigsInstruments(): boolean {
    return this.iigsSources !== null;
  }

  private createChannels(ctx: AudioContext, count: number): void {
    for (let channel = 0; channel < count; channel++) {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.connect(this.masterGain!);
      this.channelGains.push(gain);
      this.activeNodes.push(gain);
      if (channel < 3) {
        const oscillator = ctx.createOscillator();
        oscillator.type = "square";
        oscillator.connect(gain);
        oscillator.start();
        this.oscillators.push(oscillator);
        this.activeNodes.push(oscillator);
      } else {
        const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        noise.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.Q.value = 1.5;
        filter.frequency.setValueAtTime(1000, ctx.currentTime);
        noise.connect(filter);
        filter.connect(gain);
        noise.start();
        this.noiseFilter = filter;
        this.activeNodes.push(noise, filter);
      }
    }
  }

  /**
   * One looping buffer source per Paula voice through a per-voice gain, the
   * buffer fixed by the voice as in the drivers: voices 0..2 play the tone
   * sample, voice 3 the LFSR PCM — 8 and 4,096 bytes on 2.176+, 4 and 1,024
   * on 2.082 (docs/fidelity.md, "Original Amiga sound player").
   */
  private createPaulaChannels(ctx: AudioContext, early: boolean): void {
    const sample = early ? AMIGA_2082_TONE_SAMPLE : AMIGA_TONE_SAMPLE;
    const tone = ctx.createBuffer(1, sample.length, ctx.sampleRate);
    const toneData = tone.getChannelData(0);
    for (let i = 0; i < toneData.length; i++) toneData[i] = sample[i]! / 128;
    const noisePcm = early ? amigaNoisePcm(AMIGA_2082_NOISE_BYTES) : amigaNoisePcm();
    const noise = ctx.createBuffer(1, noisePcm.length, ctx.sampleRate);
    const noiseData = noise.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++) noiseData[i] = noisePcm[i]! / 128;
    for (let channel = 0; channel < 4; channel++) {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.connect(this.masterGain!);
      this.channelGains.push(gain);
      this.activeNodes.push(gain);
      const source = ctx.createBufferSource();
      source.buffer = channel === 3 ? noise : tone;
      source.loop = true;
      source.connect(gain);
      source.start();
      this.paulaSources.push(source);
      this.activeNodes.push(source);
    }
  }
}

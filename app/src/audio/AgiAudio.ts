/**
 * Web Audio presentation of the engine's sound command stream.
 * Resource timing, channel selection, envelopes and completion belong to the
 * profile-aware core scheduler. Analog tone/noise synthesis is approximate.
 */
import { PIT_BASE_FREQ, type SoundOutput } from "../../../src/sound/sound.ts";

export type AudioMode = "tandy" | "pc-speaker";

export class AgiAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private mode: AudioMode = "tandy";
  private volume: number = 0.5;
  private muted: boolean = false;
  private paused = false;
  private playing = false;
  private family: SoundOutput["kind"] | null = null;
  private channelGains: GainNode[] = [];
  private oscillators: OscillatorNode[] = [];
  private noiseFilter: BiquadFilterNode | null = null;
  private readonly divisors = [0, 0, 0];
  private latchedRegister = 0;
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
    if (this.family !== event.kind) {
      this.stop();
      this.family = event.kind;
    }
    const ctx = this.initContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    this.playing = true;
    const maxFreq = (ctx.sampleRate || 48000) / 2;
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
    this.divisors.fill(0);
    this.latchedRegister = 0;
    this.playing = false;
    this.family = null;
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
}

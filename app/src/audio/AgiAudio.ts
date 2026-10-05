import { SOUND_LOOKAHEAD_SECONDS, type SoundTick, type SoundTiming } from "./soundTiming.ts";
/**
 * Web Audio presentation of the engine's sound command stream.
 * Resource timing, channel selection, envelopes and completion belong to the
 * profile-aware core scheduler. Analogue speaker response is approximate.
 */
import {
  AMIGA_2082_NOISE_BYTES,
  AMIGA_2082_TONE_SAMPLE,
  AMIGA_TONE_SAMPLE,
  PSG_BASE_FREQ,
  amigaNoisePcm,
  type IigsOutput,
  type SoundOutput,
} from "../../../src/sound/sound.ts";
import {
  PaulaClock,
  PAULA_CLOCKS,
  type AmigaRegion,
  PAULA_MIN_PERIOD,
  PAULA_HOLD_FRAMES,
  PAULA_LED_FILTER,
  paulaRcCoefficients,
  paulaCouplingCoefficients,
} from "./paula.ts";
import { IigsSynth, iigsSources, type IigsSources } from "./iigsSynth.ts";
import {
  PsgNoise,
  PsgNoiseClock,
  type NoiseChange,
  type PsgChip,
} from "../../../src/sound/psgNoise.ts";

/**
 * The player's PC sound-chip preference, which is also the `soundDevice`
 * operand. Amiga and IIgs editions render by event kind whatever the
 * preference; see `soundFamily` in useAudioController.ts.
 */
export type AudioMode = "tandy" | "pc-speaker";

/** Keep the DAC level flat through each shift interval during resampling. */
const PSG_HOLD_FRAMES = 32;

export class AgiAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private mode: AudioMode = "tandy";
  private volume: number = 0.5;
  private muted: boolean = false;
  /** The ambient pause channel: setPaused, shared by the local hold owners. */
  private pausedAmbient = false;
  /** Identified owners beside the ambient channel (the worker's suspension). */
  private readonly pauseOwners = new Set<string>();
  /** A suspend/resume is settling; requests made during it fold into a recheck. */
  private pauseTransition = false;
  private pauseRequeue = false;
  private playing = false;
  private family: SoundOutput["kind"] | "paula-2.082" | null = null;
  private channelGains: GainNode[] = [];
  private oscillators: OscillatorNode[] = [];
  private noiseClock: PsgNoiseClock | null = null;
  private noiseSource: AudioBufferSourceNode | null = null;
  private noiseChip: PsgChip = "ncr8496";
  private readonly noiseBuffers: Partial<
    Record<PsgChip, Partial<Record<"white" | "periodic", { buffer: AudioBuffer; loop: number }>>>
  > = {};
  private readonly divisors = [0, 0, 0];
  private latchedRegister = 0;
  private paulaSources: AudioBufferSourceNode[] = [];
  private paulaBuffers: AudioBuffer[] = [];
  private paulaPendingStops: (AudioBufferSourceNode | undefined)[] = [];
  private paulaClocks: PaulaClock[] = [];
  private amigaRegion: AmigaRegion = "ntsc";
  private readonly dormantPaula = new WeakSet<object>();
  private paulaPeriods: (number | null)[] = [];
  /** The game's DOC RAM and instrument bank, when its files carry them. */
  private iigsSources: IigsSources | null = null;
  private iigsSynth: IigsSynth | null = null;
  /** Fallback voices without the bank: one triangle per sounding note. */
  private iigsFallback = new Map<
    number,
    { osc: OscillatorNode; gain: GainNode; channel: number }
  >();
  private readonly contextFactory: (() => AudioContext) | undefined;
  private activeNodes: { stop?: (when?: number) => void; disconnect: () => void }[] = [];
  /**
   * The most recent gain an event programmed per rendered lane; kept even
   * while a lane gate silences it so ungating restores that exact value.
   */
  private laneProgrammed: number[] = [];
  /**
   * Per-lane presentation gates; absent or true means audible. They survive
   * stop() like mute and volume: they are presentation preference, never
   * event state.
   */
  private laneAudible: (boolean | undefined)[] = [];
  /** A disposed instance never recreates a context or resurrects output. */
  private closedAudio = false;
  private stateListener: (() => void) | null = null;
  private timing: {
    stream: string;
    tick: number;
    at: number;
    anchorTick: number;
    anchorTime: number;
  } | null = null;
  private readonly retiredStreams = new Set<string>();
  private readonly retiredGraphs = new Set<typeof this.activeNodes>();
  private readonly sourceStops = new WeakMap<object, number>();

  constructor(options?: {
    mode?: AudioMode;
    amigaRegion?: AmigaRegion;
    volume?: number;
    muted?: boolean;
    contextFactory?: () => AudioContext;
  }) {
    this.contextFactory = options?.contextFactory;
    this.amigaRegion = options?.amigaRegion ?? "ntsc";
    if (options?.mode) this.mode = options.mode;
    if (options?.volume !== undefined) this.volume = Math.max(0, Math.min(1, options.volume));
    if (options?.muted !== undefined) this.muted = options.muted;
  }

  /** Change the colour clock on active voices, keeping DMA and game state. */
  setAmigaRegion(region: AmigaRegion): void {
    if (region === this.amigaRegion) return;
    this.amigaRegion = region;
    const ctx = this.ctx;
    if (!ctx) return;
    for (const [channel, clock] of this.paulaClocks.entries()) {
      clock.setRegion(region, ctx.currentTime);
      const period = this.paulaPeriods[channel];
      if (period === null || period === undefined) continue;
      const effectivePeriod = period === 0 ? 65536 : Math.max(PAULA_MIN_PERIOD, period);
      this.paulaSources[channel]!.playbackRate.setValueAtTime(
        ((PAULA_CLOCKS[region] / effectivePeriod) * PAULA_HOLD_FRAMES) / ctx.sampleRate,
        ctx.currentTime,
      );
    }
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

  /** Any pause channel held: the ambient flag or a named owner. */
  get isPaused(): boolean {
    return this.pausedAmbient || this.pauseOwners.size > 0;
  }

  /** True after close(): no output, context or pause request is served again. */
  get closed(): boolean {
    return this.closedAudio;
  }

  /**
   * A presentation gate on one rendered lane (0..3). The event stream still
   * programs every register while gated — tone-2 divisors keep driving the
   * noise rate, attenuation commands keep landing in laneProgrammed — so an
   * ungated lane resumes at the profile's current volume instead of a stale
   * or fabricated one. Only the rendered gain is touched.
   */
  setLaneAudible(lane: number, audible: boolean): void {
    if (!Number.isInteger(lane) || lane < 0 || lane > 3) return;
    this.laneAudible[lane] = audible;
    const gain = this.channelGains[lane];
    if (gain && this.ctx)
      gain.gain.setValueAtTime(
        audible ? (this.laneProgrammed[lane] ?? 0) : 0,
        this.ctx.currentTime,
      );
  }

  /** One lane's rendered gain: the event's value, or 0 while the lane is gated. */
  private setLaneGain(lane: number, value: number, at: number): void {
    this.laneProgrammed[lane] = value;
    const gain = this.channelGains[lane];
    if (gain) gain.gain.setValueAtTime(this.laneAudible[lane] === false ? 0 : value, at);
  }

  setMode(mode: AudioMode): void {
    this.mode = mode;
    if (this.isPlaying) {
      this.stop();
    }
  }

  setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
    this.applyMasterGain();
  }

  setMuted(mute: boolean): void {
    this.muted = mute;
    this.applyMasterGain();
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * Resumes AudioContext on user gesture to comply with browser autoplay policies.
   * A pause owner outranks the unlock: the context stays frozen until released.
   */
  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === "suspended" && !this.isPaused && !this.closedAudio) {
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
      this.applyMasterGain();
      this.masterGain.connect(this.ctx.destination);
      // The context can reach "running" on its own — WebKit auto-resumes a
      // context created suspended, an OS interruption ends — so a held pause
      // is re-asserted from the state change, not only from our requests.
      if (typeof this.ctx.addEventListener === "function") {
        this.stateListener = () => this.syncContextPause();
        this.ctx.addEventListener("statechange", this.stateListener);
      }
      this.syncContextPause();
    }
    return this.ctx;
  }

  /**
   * The ambient pause channel (the local overlay/walkthrough holds). A named
   * owner set through setPauseOwner keeps the freeze after this releases.
   */
  setPaused(paused: boolean): void {
    this.pausedAmbient = paused;
    this.applyPause();
  }

  /**
   * An identified pause owner: the worker's authoring suspension holds
   * "worker"; the debugger's run-identified control is the next one. The
   * context stays frozen until every owner and the ambient channel release.
   */
  setPauseOwner(owner: string, paused: boolean): void {
    if (paused) this.pauseOwners.add(owner);
    else this.pauseOwners.delete(owner);
    this.applyPause();
  }

  /** Silence is immediate; the clock freeze settles through syncContextPause. */
  private applyPause(): void {
    this.applyMasterGain();
    this.syncContextPause();
  }

  private applyMasterGain(): void {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(
        this.muted || this.isPaused ? 0 : this.volume,
        this.ctx.currentTime,
      );
    }
  }

  /**
   * Drive the context toward the owners' answer: suspend() freezes
   * currentTime — scheduled samples, envelope ramps and oscillator phases —
   * where the muted master gain cannot. One transition runs at a time; a
   * request made mid-flight marks a recheck so a rapid pause-release-pause
   * ends frozen regardless of settle order. Rejections (a closed or
   * replaced context) are swallowed: the gain is already zero, and the next
   * request retries. A suspended context is only resumed when nothing holds
   * the pause — output() and the autoplay unlock never lift an owner's hold.
   */
  private syncContextPause(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.pauseTransition) {
      this.pauseRequeue = true;
      return;
    }
    let transition: (() => Promise<void>) | null = null;
    if (this.isPaused && ctx.state === "running" && typeof ctx.suspend === "function")
      transition = () => ctx.suspend();
    else if (!this.isPaused && ctx.state === "suspended" && typeof ctx.resume === "function")
      transition = () => ctx.resume();
    if (!transition) return;
    this.pauseTransition = true;
    let outcome: Promise<void>;
    try {
      outcome = Promise.resolve(transition());
    } catch (error) {
      outcome = Promise.reject(error);
    }
    void outcome
      .catch(() => {})
      .then(() => {
        this.pauseTransition = false;
        if (this.pauseRequeue) {
          this.pauseRequeue = false;
          this.syncContextPause();
        }
      });
  }

  /** Apply a whole heartbeat at one context time, including natural completion. */
  outputTick(packet: SoundTick): void {
    if (this.closedAudio || this.retiredStreams.has(packet.stream)) return;
    if (packet.amigaRegion !== undefined) this.setAmigaRegion(packet.amigaRegion);
    const at = this.tickTime(packet);
    if (at === null) return;
    for (const event of packet.outputs) this.render(event, at);
    if (packet.complete) {
      this.retiredStreams.add(packet.stream);
      this.timing = null;
      // The chip's DAC and analogue capacitors survive a SOUND terminator.
      if (this.family !== "paula" && this.family !== "paula-2.082" && this.family !== "psg")
        this.releaseGraph(at);
      else this.playing = false;
    }
  }

  /** Immediate register writes, or explicitly identified logical ticks. */
  output(event: SoundOutput, timing?: SoundTiming): void {
    if (this.closedAudio) return;
    const at = timing ? this.tickTime(timing) : this.initContext().currentTime;
    if (at !== null) this.render(event, at);
  }

  private tickTime(position: SoundTiming): number | null {
    if (
      !Number.isSafeInteger(position.tick) ||
      position.tick < 0 ||
      this.retiredStreams.has(position.stream)
    )
      return null;
    const ctx = this.initContext();
    if (this.timing?.stream !== position.stream) {
      if (this.timing) {
        this.retiredStreams.add(this.timing.stream);
        this.releaseGraph(ctx.currentTime);
      }
      this.timing = {
        stream: position.stream,
        tick: position.tick,
        at: ctx.currentTime + SOUND_LOOKAHEAD_SECONDS,
        anchorTick: position.tick,
        anchorTime: ctx.currentTime + SOUND_LOOKAHEAD_SECONDS,
      };
    }
    const clock = this.timing;
    if (position.tick < clock.tick) return null;
    if (position.tick === clock.tick) return clock.at;
    let at = clock.anchorTime + (position.tick - clock.anchorTick) / (position.hz ?? 60);
    // A late batch gets one new anchor, then keeps its real tick distances.
    // Same-tick writes reuse clock.at even if delivery crosses a render quantum.
    if (at < ctx.currentTime) {
      clock.anchorTick = position.tick;
      clock.anchorTime = ctx.currentTime + SOUND_LOOKAHEAD_SECONDS;
      at = clock.anchorTime;
    }
    clock.tick = position.tick;
    clock.at = at;
    return at;
  }

  private render(event: SoundOutput, at: number): void {
    if (this.closedAudio) return;
    // The two Amiga drivers loop different buffers; a source's buffer
    // cannot be reassigned, so a driver change rebuilds the voices.
    const family = event.kind === "paula" && event.driver === "2.082" ? "paula-2.082" : event.kind;
    if (this.family !== family) {
      if (this.family !== null) this.releaseGraph(at);
      this.family = family;
    }
    const ctx = this.initContext();
    // A held pause keeps a fresh or suspended context frozen; without one
    // this is still the autoplay-unlock retry the suspended state needs.
    this.syncContextPause();
    this.playing = true;
    const maxFreq = (ctx.sampleRate || 48000) / 2;
    if (event.kind === "iigs") {
      if (this.iigsSources) {
        this.iigsSynth ??= new IigsSynth(ctx, this.masterGain!, this.iigsSources);
        this.iigsSynth.output(event, at);
      } else this.iigsFallbackOutput(ctx, event, maxFreq, at);
      return;
    }
    if (event.kind === "paula") {
      if (!this.paulaSources.length) this.createPaulaChannels(ctx, event.driver === "2.082");
      const channel = event.channel & 3;
      const clock = this.paulaClocks[channel]!;
      let source = this.paulaSources[channel]!;
      if (event.period === null) {
        const held = clock.disable(at);
        if (held) {
          this.stopSource(source, held.at);
          this.paulaPendingStops[channel] = source;
          const retired = source;
          retired.onended = () => {
            retired.disconnect();
            this.activeNodes = this.activeNodes.filter((node) => node !== retired);
          };
          const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
          const waveform = this.paulaBuffers[channel]!;
          const byte =
            held.byte === null
              ? null
              : ((held.byte % (waveform.length / PAULA_HOLD_FRAMES)) +
                  waveform.length / PAULA_HOLD_FRAMES) %
                (waveform.length / PAULA_HOLD_FRAMES);
          buffer.getChannelData(0)[0] =
            byte === null ? 0 : waveform.getChannelData(0)[byte * PAULA_HOLD_FRAMES]!;
          const hold = ctx.createBufferSource();
          hold.buffer = buffer;
          hold.loop = true;
          hold.connect(this.channelGains[channel]!);
          hold.start(held.at);
          this.paulaSources[channel] = hold;
          this.activeNodes.push(hold);
        }
        this.paulaPeriods[channel] = null;
        // Null period describes a DMACON clear, not an AUDxVOL write.
        // docs/fidelity.md, "Paula onset and A500 output".
        return;
      }
      const position = clock.write(event.period, at);
      const previous = this.paulaPeriods[channel];
      if (position.restart || previous !== event.period) {
        const pending = this.paulaPendingStops[channel];
        if (pending) {
          this.stopSource(pending, position.at);
          this.paulaPendingStops[channel] = undefined;
        }
        if (previous !== undefined) {
          this.stopSource(source, position.at);
          const replaced = source;
          replaced.onended = () => {
            replaced.disconnect();
            this.activeNodes = this.activeNodes.filter((node) => node !== replaced);
          };
          source = ctx.createBufferSource();
          source.buffer = this.paulaBuffers[channel]!;
          source.loop = true;
          source.connect(this.channelGains[channel]!);
          this.paulaSources[channel] = source;
          this.activeNodes.push(source);
        }
        // A constant rate set before start avoids playbackRate's k-rate
        // transition at a render quantum. Reload at a byte boundary and keep
        // DMA phase, as documented in "Paula onset and A500 output".
        const period = event.period === 0 ? 65536 : Math.max(PAULA_MIN_PERIOD, event.period);
        source.playbackRate.setValueAtTime(
          ((PAULA_CLOCKS[this.amigaRegion] / period) * PAULA_HOLD_FRAMES) / ctx.sampleRate,
          ctx.currentTime,
        );
        this.dormantPaula.delete(source);
        source.start(
          position.at,
          ((position.byte * PAULA_HOLD_FRAMES) % source.buffer!.length) / ctx.sampleRate,
        );
        this.paulaPeriods[channel] = event.period;
      }
      // PER zero counts 65536 clocks; VOL still scales the held DAC byte.
      this.setLaneGain(channel, (Math.min(64, event.volume) / 64) * 0.4, at);
      return;
    }
    if (!this.channelGains.length) this.createChannels(ctx, event.kind === "speaker" ? 1 : 4);
    if (event.kind === "speaker") {
      const divisor = event.divisor;
      const rawFreq = divisor ? 1193180 / divisor : 0;
      this.oscillators[0]!.frequency.setValueAtTime(Math.min(maxFreq, rawFreq), at);
      this.setLaneGain(0, divisor === null ? 0 : 0.4, at);
      return;
    }
    if (event.chip !== undefined && event.chip !== this.noiseChip) {
      this.noiseChip = event.chip;
      if (this.noiseSource) this.stopSource(this.noiseSource, at);
      this.noiseClock = new PsgNoiseClock(this.noiseChip, at);
      this.noiseClock.tone2(this.divisors[2]!, at);
      this.noiseSource = null;
      this.scheduleNoise({ at, index: 0 });
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
        this.setLaneGain(
          channel,
          attenuation === 15 ? 0 : Math.pow(10, -attenuation / 10) * 0.25,
          at,
        );
      } else if (channel < 3) {
        this.divisors[channel] = latch
          ? (this.divisors[channel]! & 0x3f0) | (byte & 15)
          : (this.divisors[channel]! & 15) | ((byte & 63) << 4);
        const divisor = this.divisors[channel]!;
        const rawFreq = divisor ? PSG_BASE_FREQ / divisor : 0;
        this.oscillators[channel]!.frequency.setValueAtTime(Math.min(maxFreq, rawFreq), at);
        if (channel === 2) {
          const change = this.noiseClock!.tone2(divisor, at);
          if (change) this.scheduleNoise(change);
        }
      } else {
        // Noise control register is latch-only (docs/fidelity.md: SN76489 attenuation latching and rest notes).
        if (!latch) continue;
        const change = this.noiseClock!.write(byte & 7, at);
        if (change) this.scheduleNoise(change);
      }
    }
  }

  /** Finish after register clears, retaining Paula's DAC and the PSG's running counters. */
  finishSound(): void {
    if (this.family !== "paula" && this.family !== "paula-2.082" && this.family !== "psg") {
      this.stop();
      return;
    }
    // A restart can send stopSound without final register writes. Keep the
    // PSG counter running, but cancel pending gains so the old cue stays quiet.
    if (this.family === "psg" && this.ctx) {
      for (const [lane, gain] of this.channelGains.entries()) {
        gain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.setLaneGain(lane, 0, this.ctx.currentTime);
      }
    }
    if (this.timing) this.retiredStreams.add(this.timing.stream);
    this.timing = null;
    this.playing = false;
  }

  stop(): void {
    if (this.timing) this.retiredStreams.add(this.timing.stream);
    this.timing = null;
    this.releaseGraph();
    for (const graph of this.retiredGraphs) {
      for (const node of graph) {
        try {
          node.stop?.();
        } catch {
          /* Already ended. */
        }
        node.disconnect();
      }
    }
    this.retiredGraphs.clear();
  }

  /** Detach the register state now; let scheduled voices finish at their tick. */
  private releaseGraph(at?: number): void {
    const graph = this.activeNodes;
    const scheduled = at !== undefined && this.ctx !== null && at > this.ctx.currentTime;
    for (const node of graph) {
      this.stopSource(node, at);
      if (!scheduled) node.disconnect();
    }
    if (scheduled && graph.length > 0) {
      this.retiredGraphs.add(graph);
      // The last sounding source owns cleanup; an earlier note-off cannot
      // disconnect the other voices while they still have scheduled audio.
      const sources = graph.filter((node) => node.stop && !this.dormantPaula.has(node));
      sources.sort((a, b) => (this.sourceStops.get(b) ?? 0) - (this.sourceStops.get(a) ?? 0));
      const source = sources[0] as AudioScheduledSourceNode | undefined;
      if (source)
        source.onended = () => {
          for (const node of graph) node.disconnect();
          this.retiredGraphs.delete(graph);
        };
    }
    this.activeNodes = [];
    this.channelGains = [];
    this.oscillators = [];
    this.noiseClock = null;
    this.noiseSource = null;
    this.paulaSources = [];
    this.paulaBuffers = [];
    this.paulaPendingStops = [];
    this.paulaClocks = [];
    this.paulaPeriods = [];
    this.iigsSynth?.stop(at);
    this.iigsFallback.clear();
    this.divisors.fill(0);
    this.latchedRegister = 0;
    // Fresh channels have no programmed volume; the lane gates themselves
    // are presentation preference and stay.
    this.laneProgrammed = [];
    this.playing = false;
    this.family = null;
  }

  private stopSource(node: (typeof this.activeNodes)[number], at?: number): void {
    if (!node.stop) return;
    const previous = this.sourceStops.get(node);
    if (at !== undefined && previous !== undefined && previous <= at) return;
    this.sourceStops.set(node, at ?? this.ctx?.currentTime ?? 0);
    try {
      node.stop(at);
    } catch {
      /* A source can already have ended. */
    }
  }

  /**
   * Dispose this instance only: stop its nodes, disconnect its gains, drop
   * the state-change listener and close the context it created. A suspend or
   * resume still in flight is swallowed by the settle handler — with ctx
   * released it can neither resurrect output nor reject unhandled. The
   * gameplay instance is another AgiAudio and is untouched.
   */
  async close(): Promise<void> {
    if (this.closedAudio) return;
    this.closedAudio = true;
    this.pauseOwners.clear();
    this.pausedAmbient = false;
    this.stop();
    const ctx = this.ctx;
    try {
      this.masterGain?.disconnect();
    } catch {
      /* The channel graph is already down. */
    }
    this.ctx = null;
    this.masterGain = null;
    if (ctx && this.stateListener && typeof ctx.removeEventListener === "function")
      ctx.removeEventListener("statechange", this.stateListener);
    this.stateListener = null;
    if (ctx && ctx.state !== "closed" && typeof ctx.close === "function") {
      try {
        await ctx.close();
      } catch {
        /* A closed or replaced context settles on its own. */
      }
    }
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
  private iigsFallbackOutput(
    ctx: AudioContext,
    event: IigsOutput,
    maxFreq: number,
    at: number,
  ): void {
    if (event.event === "all-off") {
      for (const voice of this.iigsFallback.values()) this.stopSource(voice.osc, at);
      this.iigsFallback.clear();
    } else if (event.event === "note-off") {
      const voice = this.iigsFallback.get(event.voice);
      if (voice) this.stopSource(voice.osc, at);
      this.iigsFallback.delete(event.voice);
    } else if (event.event === "volume") {
      for (const voice of this.iigsFallback.values())
        if (voice.channel === event.channel)
          voice.gain.gain.setValueAtTime((event.volume / 127) * 0.3, at);
    } else if (event.event === "note-on") {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime((event.volume / 127) * 0.3, at);
      gain.connect(this.masterGain!);
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(Math.min(maxFreq, 440 * 2 ** ((event.note - 69) / 12)), at);
      osc.connect(gain);
      osc.start(at);
      this.activeNodes.push(osc, gain);
      const previous = this.iigsFallback.get(event.voice);
      if (previous) this.stopSource(previous.osc, at);
      this.iigsFallback.set(event.voice, { osc, gain, channel: event.channel });
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
        this.noiseClock = new PsgNoiseClock(this.noiseChip, ctx.currentTime);
        this.scheduleNoise({ at: ctx.currentTime, index: 0 });
      }
    }
  }

  /** Web Audio resamples the held DAC bits, including the reset's transient prefix. */
  private scheduleNoise(change: NoiseChange): void {
    const ctx = this.ctx!;
    const clock = this.noiseClock!;
    const mode = clock.white ? "white" : "periodic";
    const buffers = (this.noiseBuffers[this.noiseChip] ??= {});
    let waveform = buffers[mode];
    if (!waveform) {
      const noise = new PsgNoise(this.noiseChip);
      noise.write(clock.white ? 4 : 0);
      const { samples, loop } = noise.waveform();
      const buffer = ctx.createBuffer(1, samples.length * PSG_HOLD_FRAMES, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = samples[Math.floor(i / PSG_HOLD_FRAMES)]!;
      waveform = buffers[mode] = { buffer, loop: loop * PSG_HOLD_FRAMES };
    }
    const previous = this.noiseSource;
    if (previous) {
      this.stopSource(previous, change.at);
      previous.onended = () => {
        previous.disconnect();
        this.activeNodes = this.activeNodes.filter((node) => node !== previous);
      };
    }
    const source = ctx.createBufferSource();
    source.buffer = waveform.buffer;
    source.loop = true;
    source.loopStart = waveform.loop / ctx.sampleRate;
    source.loopEnd = waveform.buffer.length / ctx.sampleRate;
    source.playbackRate.setValueAtTime(
      (clock.shiftHz * PSG_HOLD_FRAMES) / ctx.sampleRate,
      ctx.currentTime,
    );
    source.connect(this.channelGains[3]!);
    const frame = change.index * PSG_HOLD_FRAMES;
    const index =
      frame < waveform.buffer.length
        ? frame
        : waveform.loop + ((frame - waveform.loop) % (waveform.buffer.length - waveform.loop));
    source.start(change.at, index / ctx.sampleRate);
    this.noiseSource = source;
    this.activeNodes.push(source);
  }

  /**
   * One looping buffer source per Paula voice through a per-voice gain, the
   * buffer fixed by the voice as in the drivers: voices 0..2 play the tone
   * sample, voice 3 the LFSR PCM — 8 and 4,096 bytes on 2.176+, 4 and 1,024
   * on 2.082 (docs/fidelity.md, "Original Amiga sound player").
   */
  private createPaulaChannels(ctx: AudioContext, early: boolean): void {
    const sample = early ? AMIGA_2082_TONE_SAMPLE : AMIGA_TONE_SAMPLE;
    const tone = ctx.createBuffer(1, sample.length * PAULA_HOLD_FRAMES, ctx.sampleRate);
    const toneData = tone.getChannelData(0);
    for (let i = 0; i < toneData.length; i++)
      toneData[i] = sample[Math.floor(i / PAULA_HOLD_FRAMES)]! / 128;
    const noisePcm = early ? amigaNoisePcm(AMIGA_2082_NOISE_BYTES) : amigaNoisePcm();
    const noise = ctx.createBuffer(1, noisePcm.length * PAULA_HOLD_FRAMES, ctx.sampleRate);
    const noiseData = noise.getChannelData(0);
    for (let i = 0; i < noiseData.length; i++)
      noiseData[i] = noisePcm[Math.floor(i / PAULA_HOLD_FRAMES)]! / 128;
    const coefficients = paulaRcCoefficients(ctx.sampleRate);
    const stereo = ctx.createChannelMerger(2);
    const rc = ctx.createIIRFilter(coefficients.feedforward, coefficients.feedback);
    const coupling = paulaCouplingCoefficients(ctx.sampleRate);
    const ac = ctx.createIIRFilter(coupling.feedforward, coupling.feedback);
    const led = ctx.createBiquadFilter();
    led.type = "lowpass";
    led.frequency.setValueAtTime(PAULA_LED_FILTER.frequency, ctx.currentTime);
    // Web Audio lowpass Q is in dB; the circuit's Q is dimensionless.
    led.Q.setValueAtTime(20 * Math.log10(PAULA_LED_FILTER.q), ctx.currentTime);
    stereo.connect(rc);
    rc.connect(led);
    led.connect(ac);
    ac.connect(this.masterGain!);
    this.activeNodes.push(stereo, rc, led, ac);
    for (let channel = 0; channel < 4; channel++) {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.connect(stereo, 0, channel === 0 || channel === 3 ? 0 : 1);
      this.channelGains.push(gain);
      this.activeNodes.push(gain);
      const source = ctx.createBufferSource();
      source.buffer = channel === 3 ? noise : tone;
      this.paulaBuffers.push(source.buffer);
      source.loop = true;
      source.connect(gain);
      this.dormantPaula.add(source);
      this.paulaClocks.push(new PaulaClock(this.amigaRegion));
      this.paulaSources.push(source);
      this.activeNodes.push(source);
    }
  }
}

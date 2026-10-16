import {
  parseIigsInstrument,
  iigsByteRate,
  readIigsBank,
  type IigsBank,
  type IigsInstrument,
  type IigsWave,
} from "../../../src/sound/iigsBank.ts";
import type { IigsOutput } from "../../../src/sound/sound.ts";

/**
 * Apple IIgs Note Synthesizer rendition (docs/fidelity.md "IIgs sound"): the
 * interpreter uploads SIERRASTANDARD to the Ensoniq DOC's 64 KiB wave RAM and
 * plays the stream's notes through the Note Synthesizer on the instrument
 * bank inside its own SQ2.SYS16. Both come from the player's files at boot.
 */
export interface IigsSources {
  /** The DOC wave RAM as the interpreter leaves it after its upload. */
  readonly doc: Uint8Array;
  readonly bank: IigsBank;
}

/** The DOC RAM image and instrument bank, or null without both inputs. */
export function iigsSources(files: Readonly<Record<string, Uint8Array>>): IigsSources | null {
  const named = (test: (upper: string) => boolean): Uint8Array | undefined =>
    Object.entries(files).find(([name]) => test(name.toUpperCase()))?.[1];
  const standard = named((name) => name === "SIERRASTANDARD");
  const sys16 = named((name) => name.endsWith(".SYS16"));
  if (!standard || !sys16) return null;
  const bank = readIigsBank(sys16);
  if (!bank) return null;
  // The loader writes eight 8 KiB chunks with a $1FFF count, so the last
  // byte of each page keeps whatever DOC RAM held; that value is unknown,
  // and the file's own byte stands in for it.
  const doc = new Uint8Array(0x10000);
  doc.set(standard.subarray(0, 0x10000));
  return { doc, bank };
}

/** Note Synthesizer envelope and LFO update rate: NSStartUp(150) is 60 Hz. */
const UPDATE_HZ = 60;

/** Breakpoint level 0..127 to amplitude: 16 steps per 6 dB, 127 full scale. */
export function levelAmplitude(level: number): number {
  return level <= 0 ? 0 : 2 ** ((level - 127) / 16);
}

/** Envelope and note volume as the DOC's 8-bit volume register. */
export function docVolume(level: number, volume: number): number {
  const index = Math.max(0, Math.min(127, Math.floor(level) + Math.floor(volume) - 127));
  // Independently calculated exponential, with the five observed upward
  // rounding entries. See "IIgs DOC pitch, volume and headroom".
  const rounding = index >= 44 && index <= 108 && index % 16 === 12 ? 1 : 0;
  return Math.max(1, Math.floor(255 * levelAmplitude(index)) + rounding);
}

/** TOOL025 +09cc..0a4b: 128-entry symmetric log-triangle LFO table. */
function iigsVibratoTable(index: number): number {
  const i = index & 0x7f;
  if (i === 0) return 0;
  if (i <= 64) return Math.min(126, Math.floor(32.076573 + 15.854 * Math.log2(i + 0.192)));
  return Math.min(126, Math.floor(31.57865 + 15.936 * Math.log2(128 - i - 0.216)));
}

/**
 * TOOL025 +0686..0749: one Note Synthesizer vibrato update. Advances the
 * 8-bit LFO phase by vibratoSpeed, folds negative phases by one's complement,
 * scales through the DOC volume curve, and returns the signed 1/256-semitone
 * pitch offset applied to both oscillators.
 */
export function vibratoStep(
  phase: number,
  speed: number,
  depth: number,
): { phase: number; offset: number } {
  const sum0 = (phase & 0xff) + (speed & 0xff);
  const carry0 = sum0 > 0xff ? 1 : 0;
  const nextPhase = sum0 & 0xff;
  const negative = (nextPhase & 0x80) !== 0;
  const lookup = negative ? nextPhase ^ 0xff : nextPhase;
  const sum1 = iigsVibratoTable(lookup) + (depth & 0xff) + carry0;
  const carry1 = sum1 > 0xff ? 1 : 0;
  const level = ((sum1 & 0xff) + carry1 - 0x80) & 0xff;
  if ((level & 0x80) !== 0) return { phase: nextPhase, offset: 0 };
  const magnitude = docVolume(level, 127);
  return { phase: nextPhase, offset: negative ? -(magnitude * 2 + 2) : magnitude * 2 };
}

/**
 * TOOL025's signed 8.8 envelope updates. NoteOn performs the first update;
 * crossing a breakpoint clamps the level and arms the next segment.
 * A zero increment keeps the previous DOC write latched.
 */
export function envelopePoints(
  instrument: IigsInstrument,
  from: number,
  start: number,
  release = from !== 0,
): {
  points: [number, number][];
  levels: [number, number][];
  sustained: boolean;
  duration: number;
} {
  const points: [number, number][] = [];
  const levels: [number, number][] = [];
  let level = Math.floor(start * 256);
  let segment = from;
  let target = (instrument.envelope[segment]?.breakpoint ?? 0) * 256;
  const signed = (value: number): number => (value << 16) >> 16;
  let increment = signed(instrument.envelope[segment]?.increment ?? 0);
  if (release) {
    // NSNoteOff arms a +1 transition to the current level; its first
    // heartbeat clamps there and loads the release segment.
    segment = from - 1;
    target = level;
    increment = 1;
  }
  // Eight 7-bit breakpoints with minimum 1/256 steps bound valid contours.
  for (let tick = 0; tick <= 8 * 32768; tick++) {
    if (increment === 0) {
      levels.push([tick / UPDATE_HZ, level / 256]);
      return { points, levels, sustained: level !== 0, duration: tick / UPDATE_HZ };
    }
    const next = level + increment;
    const crossing = increment < 0 ? next < 0 || next < target : next >= 32768 || next >= target;
    if (crossing) {
      level = target;
      segment++;
      const step = instrument.envelope[segment];
      target = (step?.breakpoint ?? 0) * 256;
      increment = Math.abs(signed(step?.increment ?? 0)) * (target < level ? -1 : 1);
    } else level = next;
    points.push([tick / UPDATE_HZ, level / 256]);
    levels.push([tick / UPDATE_HZ, level / 256]);
    if (level === 0) return { points, levels, sustained: false, duration: tick / UPDATE_HZ };
  }
  return { points, levels, sustained: true, duration: (8 * 32768) / UPDATE_HZ };
}

/** The wave entry whose exclusive upper key covers the semitone. */
function waveFor(waves: readonly IigsWave[], semitone: number): IigsWave | undefined {
  return waves.find((wave) => semitone < wave.topKey) ?? waves.at(-1);
}

interface Voice {
  readonly id: number;
  readonly slot: number;
  readonly note: number;
  readonly channel: number;
  priority: number;
  endsAt: number;
  levels: [number, number][];
  readonly instrument: IigsInstrument;
  readonly volume: GainNode;
  readonly envelope: GainNode;
  readonly sources: AudioBufferSourceNode[];
  readonly oscillators: readonly { source: AudioBufferSourceNode; wave: IigsWave; carry: number }[];
  readonly noteStarted: number;
  vibratoPhase: number;
  vibratoTick: number;
  started: number;
  volumeLevel: number;
  readonly ended: Set<AudioBufferSourceNode>;
}

/** The rate the wave buffers are built at; playbackRate supplies the pitch. */
const BUFFER_RATE = 44100;
/** Bound pre-scheduled vibrato steps on sustained or slow-decay contours. */
const MAX_VIBRATO_SECONDS = 10;

export class IigsSynth {
  private readonly voices = new Map<number, Voice>();
  private readonly retiring = new Set<Voice>();
  private readonly slots: (Voice | null)[] = new Array<Voice | null>(14).fill(null);
  private readonly channelNotes = Array.from({ length: 16 }, () => new Array<number>(14).fill(-1));
  private onDisposed: (() => void) | null = null;
  private readonly sourceStops = new WeakMap<AudioBufferSourceNode, number>();
  private readonly buffers = new Map<number, { buffer: AudioBuffer; halts: boolean }>();
  private readonly ctx: BaseAudioContext;
  private readonly destination: AudioNode;
  private readonly sources: IigsSources;

  constructor(ctx: BaseAudioContext, destination: AudioNode, sources: IigsSources) {
    this.ctx = ctx;
    // DOC multiplies each 8-bit wave by an 8-bit volume and multiplexes 32
    // oscillators. Normalized samples/volumes leave a 32:1 sum bound.
    // docs/fidelity.md, "IIgs DOC pitch, volume and headroom".
    const mix = ctx.createGain();
    mix.gain.setValueAtTime(1 / 32, ctx.currentTime);
    mix.connect(destination);
    this.destination = mix;
    this.sources = sources;
  }

  output(event: IigsOutput, at = this.ctx.currentTime): void {
    switch (event.event) {
      case "note-on": {
        const instrument =
          event.program >= 0
            ? (this.sources.bank.programs[event.program] ?? this.sources.bank.defaultInstrument)
            : this.sources.bank.defaultInstrument;
        this.noteOn(event.voice, event.channel, event.note, event.volume, instrument, at);
        return;
      }
      case "note-off": {
        if (event.channel === undefined || event.note === undefined) this.release(event.voice, at);
        else {
          const notes = this.channelNotes[event.channel]!;
          const slot = notes.lastIndexOf(event.note);
          if (slot >= 0) {
            notes[slot] = -1;
            const voice = this.slots[slot];
            if (voice && voice.note === event.note) this.release(voice.id, at, false);
          }
        }
        return;
      }
      case "volume":
        // SQ2 seg3+20fc walks its channel's generator table and calls the
        // Sound Manager directly; NS's note-volume operand stays unchanged.
        for (const [slot, note] of this.channelNotes[event.channel]!.entries()) {
          const voice = this.slots[slot];
          if (note >= 0 && voice && voice.endsAt > at)
            voice.envelope.gain.setValueAtTime(event.volume / 255, at);
        }
        return;
      case "sample": {
        // seg3+0x1460: the PCM goes to DOC RAM $C000 and the resource's own
        // instrument plays it; bytes past its count keep the RAM's content.
        const data = event.data;
        const u16 = (at: number): number => (data[at] ?? 0) | ((data[at + 1] ?? 0) << 8);
        const pcm = data.subarray(8 + u16(4), 8 + u16(4) + u16(6));
        this.sources.doc.set(pcm.subarray(0, 0x4000), 0xc000);
        for (const key of this.buffers.keys())
          if ((key >> 16) + (key & 0xffff) / 256 > 0xc0) this.buffers.delete(key);
        // A resource too short for its instrument record plays nothing.
        let instrument: IigsInstrument;
        try {
          instrument = parseIigsInstrument(data, 8).instrument;
        } catch {
          return;
        }
        this.noteOn(event.voice, -1, u16(0), u16(2) & 0x7f, instrument, at);
        return;
      }
      case "all-off":
        this.stop(at);
        return;
    }
  }

  stop(at = this.ctx.currentTime): void {
    for (const voice of new Set([...this.voices.values(), ...this.retiring]))
      this.silence(voice, at);
    if (at <= this.ctx.currentTime) this.retiring.clear();
    this.voices.clear();
    this.slots.fill(null);
    for (const notes of this.channelNotes) notes.fill(-1);
    this.finishDisposal();
  }

  /** Retire the bank graph after every scheduled oscillator has stopped. */
  dispose(at: number, done: () => void): void {
    this.onDisposed = () => {
      this.destination.disconnect();
      done();
    };
    this.stop(at);
  }

  private finishDisposal(): void {
    if (this.voices.size !== 0 || this.retiring.size !== 0) return;
    const done = this.onDisposed;
    this.onDisposed = null;
    done?.();
  }

  private noteOn(
    id: number,
    channel: number,
    semitone: number,
    volume: number,
    instrument: IigsInstrument,
    now: number,
  ): void {
    const replaced = this.voices.get(id);
    if (replaced) {
      this.silence(replaced, now);
      this.voices.delete(id);
      this.slots[replaced.slot] = null;
      if (replaced.channel >= 0) this.channelNotes[replaced.channel]![replaced.slot] = -1;
    }
    // AllocGen(64): first free slot, otherwise age positive priorities
    // (floor 1) and take the first strict minimum below the requested 64.
    // Logical end times matter when several future ticks arrive together.
    let slot = -1;
    let lowest = 255;
    for (let index = 0; index < this.slots.length; index++) {
      const voice = this.slots[index];
      if (!voice || voice.endsAt <= now) {
        slot = index;
        break;
      }
      voice.priority = Math.max(1, voice.priority - 1);
      if (voice.priority < lowest) {
        lowest = voice.priority;
        slot = index;
      }
    }
    if (slot < 0) return;
    const previous = this.slots[slot];
    if (previous) {
      this.silence(previous, now);
      this.voices.delete(previous.id);
    }
    const volumeGain = this.ctx.createGain();
    volumeGain.gain.setValueAtTime(1, now);
    const envelope = this.ctx.createGain();
    envelope.connect(volumeGain);
    volumeGain.connect(this.destination);
    const sources: AudioBufferSourceNode[] = [];
    const oscillators: { source: AudioBufferSourceNode; wave: IigsWave; carry: number }[] = [];
    const waves = [waveFor(instrument.a, semitone), waveFor(instrument.b, semitone)];
    const a = waves[0];
    const pitchCarry = a && semitone * 256 + (a.relPitch & 0xffff) > 0xffff ? 1 : 0;
    const hasVibrato = instrument.vibratoDepth > 0 && instrument.vibratoSpeed > 0;
    for (const [half, wave] of waves.entries()) {
      // docMode bit 0 halts the oscillator: that half of the pair is silent.
      if (!wave || (wave.docMode & 1) !== 0) continue;
      const table = this.table(wave);
      const source = this.ctx.createBufferSource();
      source.buffer = table.buffer;
      // Mode 1 is one-shot; free-run, sync and swap loop the table here
      // (swap's A/B hand-off is not modelled). A zero byte halts either.
      source.loop = !table.halts && ((wave.docMode >> 1) & 3) !== 1;
      const carry = half === 0 ? 0 : pitchCarry;
      if (!hasVibrato) {
        const byteRate = iigsByteRate(semitone, wave, carry);
        source.playbackRate.setValueAtTime(byteRate / BUFFER_RATE, now);
      }
      source.connect(envelope);
      source.start(now);
      sources.push(source);
      oscillators.push({ source, wave, carry });
    }
    const { points, levels, sustained, duration } = envelopePoints(instrument, 0, 0);
    const voice: Voice = {
      id,
      slot,
      note: semitone,
      priority: 64,
      endsAt: sustained ? Infinity : now + duration,
      levels,
      channel,
      instrument,
      volume: volumeGain,
      envelope,
      sources,
      oscillators,
      noteStarted: now,
      vibratoPhase: 0,
      vibratoTick: 0,
      started: now,
      volumeLevel: volume,
      ended: new Set(),
    };
    for (const source of sources)
      source.onended = () => {
        voice.ended.add(source);
        if (voice.ended.size === voice.sources.length) {
          voice.volume.disconnect();
          this.retiring.delete(voice);
          this.finishDisposal();
        }
      };
    envelope.gain.setValueAtTime(0, now);
    this.schedule(voice, now, points);
    this.scheduleVibrato(voice);
    // Keep loop sources available behind the DOC-volume gate: NoteOff can
    // replace a finite contour with a longer or sustaining release. The
    // next allocation or transport stop retires these bounded generators.
    this.voices.set(id, voice);
    this.slots[slot] = voice;
    if (channel >= 0) this.channelNotes[channel]![slot] = semitone;
  }

  /** NoteOff: the envelope jumps to the release segment from its current level. */
  private release(id: number, now: number, clearMapping = true): void {
    const voice = this.voices.get(id);
    if (!voice) return;
    if (voice.endsAt <= now) return;
    const level = levelAt(voice.levels, now - voice.started);
    const { points, levels, sustained, duration } = envelopePoints(
      voice.instrument,
      voice.instrument.releaseSegment,
      level,
      true,
    );
    voice.started = now;
    voice.levels = levels;
    voice.priority >>= 1;
    if (clearMapping && voice.channel >= 0) this.channelNotes[voice.channel]![voice.slot] = -1;
    voice.envelope.gain.cancelScheduledValues(now);
    voice.endsAt = sustained ? Infinity : now + duration;
    this.schedule(voice, now, points);
    this.scheduleVibrato(voice);
  }

  /**
   * TOOL025 +03ef and +0581..0591: NoteOn runs an initial vibrato step at
   * tick 0; the 60 Hz heartbeat toggles bit 7 of the voice status byte so
   * subsequent vibrato updates run on odd ticks (1, 3, 5, ...) across NoteOff.
   */
  private scheduleVibrato(voice: Voice): void {
    const { vibratoDepth, vibratoSpeed } = voice.instrument;
    if (vibratoDepth <= 0 || vibratoSpeed <= 0 || !voice.oscillators.length) return;
    const limit = Math.min(voice.endsAt, voice.started + MAX_VIBRATO_SECONDS);
    while (voice.noteStarted + voice.vibratoTick / UPDATE_HZ < limit - 1e-9) {
      const at = voice.noteStarted + voice.vibratoTick / UPDATE_HZ;
      const step = vibratoStep(voice.vibratoPhase, vibratoSpeed, vibratoDepth);
      voice.vibratoPhase = step.phase;
      for (const { source, wave, carry } of voice.oscillators) {
        const byteRate = iigsByteRate(voice.note, wave, carry + step.offset);
        source.playbackRate.setValueAtTime(byteRate / BUFFER_RATE, at);
      }
      voice.vibratoTick = voice.vibratoTick === 0 ? 1 : voice.vibratoTick + 2;
    }
  }

  private retainUntilEnded(voice: Voice): void {
    if (voice.sources.length === voice.ended.size) voice.volume.disconnect();
    else this.retiring.add(voice);
  }

  private stopSource(source: AudioBufferSourceNode, at: number): void {
    const previous = this.sourceStops.get(source);
    if (previous !== undefined && previous <= at) return;
    this.sourceStops.set(source, at);
    source.stop(at);
  }

  private schedule(voice: Voice, at: number, points: readonly [number, number][]): void {
    const gain = voice.envelope.gain;
    for (const [time, level] of points) {
      const volume = docVolume(level, voice.volumeLevel) / 255;
      gain.setValueAtTime(volume, at + time);
    }
    if (voice.endsAt < Infinity) gain.setValueAtTime(0, voice.endsAt);
  }

  private silence(voice: Voice, now: number): void {
    voice.envelope.gain.cancelScheduledValues(now);
    voice.envelope.gain.setValueAtTime(0, now);
    for (const source of voice.sources) this.stopSource(source, now);
    if (now <= this.ctx.currentTime) voice.volume.disconnect();
    else this.retainUntilEnded(voice);
  }

  /**
   * A wave's DOC table as an AudioBuffer: 256 << T bytes from page waveAddr,
   * unsigned 8-bit samples centred on $80, ending at the first zero byte,
   * which halts the oscillator.
   */
  private table(wave: IigsWave): { buffer: AudioBuffer; halts: boolean } {
    const size = 256 << ((wave.waveSize >> 3) & 7);
    const address = (wave.waveAddr << 8) & ~(size - 1) & 0xffff;
    const key = (address << 8) | size;
    const cached = this.buffers.get(key);
    if (cached) return cached;
    const bytes = this.sources.doc.subarray(address, Math.min(0x10000, address + size));
    const zero = bytes.indexOf(0);
    const length = Math.max(1, zero < 0 ? bytes.length : zero);
    const buffer = this.ctx.createBuffer(1, length, BUFFER_RATE);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = ((bytes[i] ?? 0x80) - 0x80) / 128;
    const table = { buffer, halts: zero >= 0 };
    this.buffers.set(key, table);
    return table;
  }
}

/** The most recent discrete envelope state at the supplied event time. */
function levelAt(points: readonly [number, number][], elapsed: number): number {
  let level = points[0]?.[1] ?? 0;
  for (const [time, value] of points) {
    if (time > elapsed + 1e-9) break;
    level = value;
  }
  return level;
}

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

/**
 * The envelope as (seconds, level) points from `from` at level `start`:
 * each segment ramps to its breakpoint at `increment / 256` levels per
 * update; an increment of 0 holds the level (sustain) and ends the list.
 */
export function envelopePoints(
  instrument: IigsInstrument,
  from: number,
  start: number,
): { points: [number, number][]; sustained: boolean } {
  const points: [number, number][] = [[0, start]];
  let time = 0;
  let level = start;
  for (let segment = from; segment < instrument.envelope.length; segment++) {
    const { breakpoint, increment } = instrument.envelope[segment]!;
    if (increment === 0) return { points, sustained: true };
    time += (Math.abs(level - breakpoint) * 256) / (increment * UPDATE_HZ);
    level = breakpoint;
    points.push([time, level]);
    if (level === 0) break;
  }
  return { points, sustained: false };
}

/** The wave entry whose exclusive upper key covers the semitone. */
function waveFor(waves: readonly IigsWave[], semitone: number): IigsWave | undefined {
  return waves.find((wave) => semitone < wave.topKey) ?? waves.at(-1);
}

interface Voice {
  readonly channel: number;
  readonly instrument: IigsInstrument;
  readonly volume: GainNode;
  readonly envelope: GainNode;
  readonly sources: AudioBufferSourceNode[];
  started: number;
  points: [number, number][];
  volumeLevel: number;
  readonly ended: Set<AudioBufferSourceNode>;
}

/** The rate the wave buffers are built at; playbackRate supplies the pitch. */
const BUFFER_RATE = 44100;

export class IigsSynth {
  private readonly voices = new Map<number, Voice>();
  private readonly retiring = new Set<Voice>();
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
      case "note-off":
        this.release(event.voice, at);
        return;
      case "volume":
        for (const voice of [...this.voices.values(), ...this.retiring])
          if (voice.channel === event.channel) {
            voice.volumeLevel = event.volume;
            const points = remainingPoints(voice.points, at - voice.started);
            voice.envelope.gain.cancelScheduledValues(at);
            this.schedule(voice, at, points);
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
  }

  private noteOn(
    id: number,
    channel: number,
    semitone: number,
    volume: number,
    instrument: IigsInstrument,
    now: number,
  ): void {
    const previous = this.voices.get(id);
    if (previous) this.silence(previous, now);
    const volumeGain = this.ctx.createGain();
    volumeGain.gain.setValueAtTime(1, now);
    const envelope = this.ctx.createGain();
    envelope.connect(volumeGain);
    volumeGain.connect(this.destination);
    const sources: AudioBufferSourceNode[] = [];
    const waves = [waveFor(instrument.a, semitone), waveFor(instrument.b, semitone)];
    const a = waves[0];
    const pitchCarry = a && semitone * 256 + (a.relPitch & 0xffff) > 0xffff ? 1 : 0;
    for (const [half, wave] of waves.entries()) {
      // docMode bit 0 halts the oscillator: that half of the pair is silent.
      if (!wave || (wave.docMode & 1) !== 0) continue;
      const table = this.table(wave);
      const source = this.ctx.createBufferSource();
      source.buffer = table.buffer;
      // Mode 1 is one-shot; free-run, sync and swap loop the table here
      // (swap's A/B hand-off is not modelled). A zero byte halts either.
      source.loop = !table.halts && ((wave.docMode >> 1) & 3) !== 1;
      source.playbackRate.setValueAtTime(
        iigsByteRate(semitone, wave, half === 0 ? 0 : pitchCarry) / BUFFER_RATE,
        now,
      );
      source.connect(envelope);
      source.start(now);
      sources.push(source);
    }
    const { points, sustained } = envelopePoints(instrument, 0, 0);
    const voice: Voice = {
      channel,
      instrument,
      volume: volumeGain,
      envelope,
      sources,
      started: now,
      points,
      volumeLevel: volume,
      ended: new Set(),
    };
    for (const source of sources)
      source.onended = () => {
        voice.ended.add(source);
        if (voice.ended.size === voice.sources.length) {
          voice.volume.disconnect();
          this.retiring.delete(voice);
          if (this.voices.get(id) === voice) this.voices.delete(id);
        }
      };
    this.schedule(voice, now, points);
    // An envelope without a sustain segment ends the note on its own.
    if (!sustained)
      for (const source of sources) this.stopSource(source, now + (points.at(-1)?.[0] ?? 0) + 0.01);
    this.voices.set(id, voice);
  }

  /** NoteOff: the envelope jumps to the release segment from its current level. */
  private release(id: number, now: number): void {
    const voice = this.voices.get(id);
    if (!voice) return;
    const level = levelAt(voice.points, now - voice.started);
    const { points } = envelopePoints(voice.instrument, voice.instrument.releaseSegment, level);
    voice.started = now;
    voice.points = points;
    voice.envelope.gain.cancelScheduledValues(now);
    this.schedule(voice, now, points);
    const end = now + (points.at(-1)?.[0] ?? 0);
    for (const source of voice.sources) this.stopSource(source, end + 0.01);
    this.retainUntilEnded(voice);
    this.voices.delete(id);
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
    const end = points.at(-1)?.[0] ?? 0;
    let previous = -1;
    for (let tick = 0; tick <= Math.ceil(end * UPDATE_HZ); tick++) {
      const time = Math.min(tick / UPDATE_HZ, end);
      const volume = docVolume(levelAt(points, time), voice.volumeLevel) / 255;
      if (volume !== previous) gain.setValueAtTime(volume, at + time);
      previous = volume;
    }
    if (points.at(-1)?.[1] === 0) gain.setValueAtTime(0, at + (points.at(-1)?.[0] ?? 0));
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

/** Preserve the envelope's remaining contour when its note volume changes. */
function remainingPoints(points: readonly [number, number][], elapsed: number): [number, number][] {
  return [
    [0, levelAt(points, elapsed)],
    ...points
      .filter(([time]) => time > elapsed)
      .map(([time, level]): [number, number] => [time - elapsed, level]),
  ];
}

/** The envelope level `elapsed` seconds into its points, linear in level. */
function levelAt(points: readonly [number, number][], elapsed: number): number {
  let previous = points[0] ?? [0, 0];
  for (const point of points) {
    if (elapsed <= point[0]) {
      const span = point[0] - previous[0];
      return span <= 0
        ? point[1]
        : previous[1] + ((point[1] - previous[1]) * (elapsed - previous[0])) / span;
    }
    previous = point;
  }
  return previous[1];
}

/**
 * The Apple IIgs Note Synthesizer instrument bank carried inside the
 * interpreter itself (docs/fidelity.md "IIgs sound"). The bank is read from
 * the player's own SQ2.SYS16: a GS/OS OMF load file whose `~globals`
 * segment holds variable-length instrument records followed by a program
 * map of far pointers. The map slots are zeros in the file image — the OMF
 * loader fills them from the segment's relocation records — so decoding
 * the bank replays that relocation step against the record starts.
 */

export interface IigsWave {
  /** Highest semitone this wave covers; entries are scanned in order. */
  readonly topKey: number;
  /** DOC wave-RAM page (address high byte) of the wave table. */
  readonly waveAddr: number;
  /** Size/resolution byte: table size is `256 << ((waveSize >> 3) & 7)`. */
  readonly waveSize: number;
  /** DOC control value; bit 0 halts the oscillator, bits 2:1 the run mode. */
  readonly docMode: number;
  /** Signed pitch offset in 1/256 semitones. */
  readonly relPitch: number;
}

export interface IigsEnvelopeSegment {
  readonly breakpoint: number;
  readonly increment: number;
}

export interface IigsInstrument {
  /** The eight envelope segments. */
  readonly envelope: readonly IigsEnvelopeSegment[];
  /** Envelope segment a note-off jumps to. */
  readonly releaseSegment: number;
  readonly priorityIncrement: number;
  readonly pitchBendRange: number;
  readonly vibratoDepth: number;
  readonly vibratoSpeed: number;
  readonly a: readonly IigsWave[];
  readonly b: readonly IigsWave[];
}

export interface IigsBank {
  /** Instruments indexed by program number 0..49 (the loader-resolved map). */
  readonly programs: readonly IigsInstrument[];
  /** The channel default before any program change (record at ~globals+0x05c4). */
  readonly defaultInstrument: IigsInstrument;
}

const ENVELOPE_SEGMENTS = 8;
const RECORD_HEAD = ENVELOPE_SEGMENTS * 3 + 8;
const WAVE_BYTES = 6;

/**
 * Parse an instrument record at `at`; returns it and the byte length. Also
 * used for the record embedded in type-1 sound resources at payload+10.
 */
export function parseIigsInstrument(
  bytes: Uint8Array,
  at: number,
): { instrument: IigsInstrument; length: number } {
  if (at < 0 || at + RECORD_HEAD > bytes.length) {
    throw new Error(`iigs instrument at +${at.toString(16)} needs ${RECORD_HEAD} bytes`);
  }
  const u8 = (i: number): number => bytes[at + i]!;
  const u16 = (i: number): number => u8(i) | (u8(i + 1) << 8);
  const envelope: IigsEnvelopeSegment[] = [];
  for (let s = 0; s < ENVELOPE_SEGMENTS; s++) {
    envelope.push({ breakpoint: u8(s * 3), increment: u16(s * 3 + 1) });
  }
  const aCount = u8(30);
  const bCount = u8(31);
  const length = RECORD_HEAD + (aCount + bCount) * WAVE_BYTES;
  if (at + length > bytes.length) {
    throw new Error(`iigs instrument at +${at.toString(16)} lists waves past the data`);
  }
  const waves: IigsWave[] = [];
  for (let w = 0; w < aCount + bCount; w++) {
    const o = RECORD_HEAD + w * WAVE_BYTES;
    const relPitch = u16(o + 4);
    waves.push({
      topKey: u8(o),
      waveAddr: u8(o + 1),
      waveSize: u8(o + 2),
      docMode: u8(o + 3),
      relPitch: (relPitch << 16) >> 16,
    });
  }
  return {
    instrument: {
      envelope,
      releaseSegment: u8(24),
      priorityIncrement: u8(25),
      pitchBendRange: u8(26),
      vibratoDepth: u8(27),
      vibratoSpeed: u8(28), // u8(29) is a spare byte
      a: waves.slice(0, aCount),
      b: waves.slice(aCount),
    },
    length,
  };
}

// ---- OMF load-file reading (GS/OS Object Module Format v2) ----
// Just what the bank needs: the ~globals segment's loaded image (LCONST
// data over DS zero fill) and its intra-segment relocation patches — patch
// offset to target's within-segment offset. Other record bodies stop the
// parse with an error rather than guessing a size.

const u16le = (d: Uint8Array, i: number): number => (d[i] ?? 0) | ((d[i + 1] ?? 0) << 8);
const u32le = (d: Uint8Array, i: number): number =>
  ((d[i] ?? 0) | ((d[i + 1] ?? 0) << 8) | ((d[i + 2] ?? 0) << 16) | ((d[i + 3] ?? 0) << 24)) >>> 0;

interface OmfSegment {
  readonly name: string;
  /** The loaded image: LCONST data laid over DS zero fill. */
  readonly image: Uint8Array;
  /** Within-segment offset of a relocated field -> its intra-segment target. */
  readonly patches: ReadonlyMap<number, number>;
}

interface OmfSegmentHeader {
  readonly name: string;
  readonly segnum: number;
  readonly bodyAt: number;
  readonly bodyEnd: number;
  readonly length: number;
}

/** The segment table: a bytecnt-terminated run of v2 headers. */
function omfSegmentHeaders(sys16: Uint8Array): OmfSegmentHeader[] {
  const headers: OmfSegmentHeader[] = [];
  let pos = 0;
  while (pos + 0x2c <= sys16.length) {
    const bytecnt = u32le(sys16, pos);
    if (bytecnt === 0) break; // end of the segment list
    if (bytecnt < 0x2c || pos + bytecnt > sys16.length) break; // malformed or truncated
    const dispname = u16le(sys16, pos + 0x28);
    const dispdata = u16le(sys16, pos + 0x2a);
    let name = "";
    if (dispname + 10 <= bytecnt) {
      const chars: number[] = [];
      for (let i = 0; i < 10; i++) {
        const c = sys16[pos + dispname + i]!;
        if (c === 0) break;
        chars.push(c);
      }
      name = String.fromCharCode(...chars).trimEnd();
    }
    headers.push({
      name,
      segnum: u16le(sys16, pos + 0x22),
      bodyAt: pos + dispdata,
      bodyEnd: pos + bytecnt,
      length: u32le(sys16, pos + 8),
    });
    pos += bytecnt;
  }
  return headers;
}

/** Decode a SUPER record's patch-site list: run-encoded page offsets. */
function* superSites(sys16: Uint8Array, at: number, size: number): Generator<number> {
  let page = 0;
  let i = at;
  const end = at + size;
  while (i < end) {
    const b = sys16[i++]!;
    if (b & 0x80) {
      page += b & 0x7f;
      continue;
    }
    for (let k = 0; k <= b && i < end; k++) {
      yield page * 256 + sys16[i++]!;
    }
    page++;
  }
}

/** Build a segment's loaded image and collect its intra-segment patches. */
function readSegment(sys16: Uint8Array, header: OmfSegmentHeader): OmfSegment {
  const image = new Uint8Array(header.length);
  const patches = new Map<number, number>();
  let q = header.bodyAt;
  let at = 0;
  while (q < header.bodyEnd) {
    const op = sys16[q]!;
    if (op === 0x00) break; // END
    if (op < 0xe0) {
      // Counted auxiliary record: opcode, byte count, that many bytes.
      if (q + 2 > header.bodyEnd) break;
      q += 2 + sys16[q + 1]!;
      continue;
    }
    if (op === 0xf1 || op === 0xf2) {
      // DS count (zero fill) / LCONST count + data.
      if (q + 5 > header.bodyEnd) throw new Error(`truncated OMF record at +${q.toString(16)}`);
      const count = u32le(sys16, q + 1);
      if (op === 0xf2) {
        if (q + 5 + count > header.bodyEnd || at + count > image.length) {
          throw new Error(`LCONST at +${q.toString(16)} overruns the segment`);
        }
        image.set(sys16.subarray(q + 5, q + 5 + count), at);
        q += count;
      }
      q += 5;
      at += count;
      continue;
    }
    if (op === 0xe2 || op === 0xf5) {
      // RELOC / cRELOC: numBytes, bitShift, patch offset, target offset.
      const size = op === 0xe2 ? 11 : 7;
      if (q + size > header.bodyEnd) {
        throw new Error(`truncated OMF relocation at +${q.toString(16)}`);
      }
      if (sys16[q + 2] !== 0) {
        throw new Error(`unsupported bit-shifted relocation at +${q.toString(16)}`);
      }
      const [patchAt, target] =
        op === 0xe2
          ? [u32le(sys16, q + 3), u32le(sys16, q + 7)]
          : [u16le(sys16, q + 3), u16le(sys16, q + 5)];
      patches.set(patchAt!, target!);
      q += size;
      continue;
    }
    if (op === 0xf6) {
      // cINTERSEG: a far pointer into another segment; no intra-segment target.
      q += 8;
      continue;
    }
    if (op === 0xf7) {
      // SUPER compressed relocations. Subtypes 0/1 patch 2/3-byte fields
      // whose file image already holds the link-time value; a 3-byte site
      // carries segnum<<16|offset and only resolves when it names this
      // segment. The remaining subtypes are intersegment patches.
      if (q + 5 > header.bodyEnd) throw new Error(`truncated OMF SUPER at +${q.toString(16)}`);
      const size = u32le(sys16, q + 1);
      if (q + 5 + size > header.bodyEnd) {
        throw new Error(`truncated OMF SUPER at +${q.toString(16)}`);
      }
      const subtype = sys16[q + 5]!;
      if (subtype === 0 || subtype === 1) {
        for (const site of superSites(sys16, q + 6, size - 1)) {
          if (subtype === 1 && image[site + 2] !== header.segnum) continue;
          patches.set(site, u16le(image, site));
        }
      }
      q += 5 + size;
      continue;
    }
    throw new Error(`unsupported OMF record op 0x${op.toString(16)} at +${q.toString(16)}`);
  }
  return { name: header.name, image, patches };
}

// ~globals layout in SQ2.SYS16 1.014 (docs/fidelity.md "Sound format").
const RECORDS_AT = 0x04bc;
const RECORDS_END = 0x09c8;
const DEFAULT_RECORD = 0x05c4;
const MAP_AT = 0x0a08;
const PROGRAMS = 50;
const FAR_POINTER = 4;

/**
 * Read the bank from an SQ2.SYS16 image, or null when the file is not the
 * 1.014 layout (no `~globals` segment, records do not tile 0x04bc..0x09c8,
 * or a map entry does not point at a record start). Never throws on
 * malformed input.
 */
export function readIigsBank(sys16: Uint8Array): IigsBank | null {
  try {
    const header = omfSegmentHeaders(sys16).find((segment) => segment.name === "~globals");
    if (!header) return null;
    const { image, patches } = readSegment(sys16, header);
    if (image.length < MAP_AT + PROGRAMS * FAR_POINTER) return null;
    const records = new Map<number, IigsInstrument>();
    let at = RECORDS_AT;
    while (at < RECORDS_END) {
      const { instrument, length } = parseIigsInstrument(image, at);
      records.set(at, instrument);
      at += length;
    }
    if (at !== RECORDS_END) return null;
    const defaultInstrument = records.get(DEFAULT_RECORD);
    if (!defaultInstrument) return null;
    const programs: IigsInstrument[] = [];
    for (let program = 0; program < PROGRAMS; program++) {
      const target = patches.get(MAP_AT + program * FAR_POINTER);
      const instrument = target === undefined ? undefined : records.get(target);
      if (!instrument) return null;
      programs.push(instrument);
    }
    return { programs, defaultInstrument };
  } catch {
    return null;
  }
}

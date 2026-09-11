/**
 * AGI split and combined resource containers, per
 * Peter Kelly's agi-re behavioral specification, "Resource Containers" chapter.
 *
 * The container is a mutable in-memory byte-map model: `files` always
 * reflects the current on-disk image and is what adapters persist.
 * Replacements pack the currently indexed records into a fresh image before
 * committing it. Resource IDs and encoded payloads remain stable, while
 * obsolete records are removed during authoring.
 */

import { RESOURCE_KINDS, type GameContainer, type ResourceKind } from "../types.ts";
import { detectProfile } from "../runtime/profile.ts";
import { toggleMessageEncryption } from "../logic/resource.ts";

/** Directory file per family (v2 split profile). */
export const DIRECTORY_FILES: Readonly<Record<ResourceKind, string>> = {
  logic: "LOGDIR",
  picture: "PICDIR",
  view: "VIEWDIR",
  sound: "SNDDIR",
};

/** A fresh directory holds this many absent entries. */
export const INITIAL_DIRECTORY_ENTRIES = 256;
/** Bytes per directory entry. */
export const ENTRY_BYTES = 3;
/** Directory offsets are 20-bit: a volume must never grow past this size. */
export const VOLUME_MAX_BYTES = 0x000f_ffff;
/** Record payload length is u16le. */
export const PAYLOAD_MAX_BYTES = 0x0000_ffff;
/** Record header: magic(2) + volume(1) + payload length u16le(2). */
export const RECORD_HEADER_BYTES = 5;
/** Volume numbers live in the high nibble of directory byte 0; 0xf is the absent marker. */
const VOLUME_MAX_NUMBER = 0x0e;

const RECORD_MAGIC_0 = 0x12;
const RECORD_MAGIC_1 = 0x34;

export interface ContainerOptions {
  /** Auto-detected from directory/volume filenames when omitted. */
  readonly kind?: "v2-split" | "v3-combined";
  /** Game prefix for v3 DIR and VOL.N files; empty is valid. */
  readonly prefix?: string;
}

export function detectContainerFormat(files: ReadonlyMap<string, Uint8Array>): {
  kind: "v2-split" | "v3-combined";
  prefix: string;
} {
  const splitNames = new Set(Object.values(DIRECTORY_FILES));
  const combined = [...files.keys()].filter(
    (name) => name.endsWith("DIR") && !splitNames.has(name),
  );
  if (combined.length > 1)
    throw new Error("Multiple AGI combined directories; select a game prefix.");
  if (combined.length === 1) return { kind: "v3-combined", prefix: combined[0]!.slice(0, -3) };
  const prefixes = new Set(
    [...files.keys()].flatMap((name) => {
      const match = /^(.+)VOL\.\d+$/.exec(name);
      return match ? [match[1]!] : [];
    }),
  );
  if (prefixes.size > 1) throw new Error("Multiple AGI volume prefixes; select a game prefix.");
  if (prefixes.size === 1) return { kind: "v3-combined", prefix: [...prefixes][0]! };
  return { kind: detectProfile(files).container, prefix: "" };
}

function volumeFileName(n: number, prefix = ""): string {
  return `${prefix}VOL.${n}`;
}

function expandDictionary(stored: Uint8Array, length: number): Uint8Array {
  const output = new Uint8Array(length);
  const dictionary: Uint8Array[] = [];
  let bit = 0;
  let width = 9;
  let next = 0x102;
  let written = 0;
  let previous: Uint8Array | undefined;
  let initialized = false;
  for (;;) {
    if (bit + width > stored.length * 8) throw new Error("Truncated dictionary stream.");
    let code = 0;
    for (let i = 0; i < width; i++, bit++) code |= ((stored[bit >> 3]! >> (bit & 7)) & 1) << i;
    if (!initialized && code !== 0x100) throw new Error("Dictionary stream must start with reset.");
    if (code === 0x100) {
      initialized = true;
      dictionary.length = 0;
      next = 0x102;
      width = 9;
      previous = undefined;
      continue;
    }
    if (code === 0x101) break;
    let current: Uint8Array | undefined;
    if (code < 0x100) current = Uint8Array.of(code);
    else if (code < next) current = dictionary[code];
    else if (code === next && previous) {
      current = new Uint8Array(previous.length + 1);
      current.set(previous);
      current[previous.length] = previous[0]!;
    }
    if (!current) throw new Error(`Invalid dictionary code ${code}.`);
    if (written + current.length > length)
      throw new Error("Dictionary expansion exceeds declared length.");
    output.set(current, written);
    written += current.length;
    if (previous) {
      const entry = new Uint8Array(previous.length + 1);
      entry.set(previous);
      entry[previous.length] = current[0]!;
      dictionary[next++] = entry;
      if (next === 0x200 || next === 0x400) width++;
    }
    previous = current;
  }
  if (written !== length) throw new Error("Dictionary expanded length mismatch.");
  return output;
}

function expandPicture(stored: Uint8Array, length: number): Uint8Array {
  const output = new Uint8Array(length);
  let nibble = 0;
  let written = 0;
  let color = false;
  const read = (): number => {
    if (nibble >= stored.length * 2) throw new Error("Truncated picture nibble stream.");
    const value = (stored[nibble >> 1]! >> (nibble & 1 ? 0 : 4)) & 15;
    nibble++;
    return value;
  };
  for (;;) {
    const value: number = color ? read() : (read() << 4) | read();
    if (written >= length) throw new Error("Picture expansion exceeds declared length.");
    output[written++] = value;
    color = value === 0xf0 || value === 0xf2;
    if (value === 0xff) break;
  }
  if (written !== length) throw new Error("Picture expanded length mismatch.");
  const remaining = stored.length * 2 - nibble;
  if (remaining > 1 || (remaining === 1 && read() !== 0))
    throw new Error("Invalid picture nibble padding.");
  return output;
}

function checkResourceNum(num: number): void {
  if (!Number.isInteger(num) || num < 0) {
    throw new RangeError(`resource number must be a non-negative integer, got ${num}`);
  }
}

class ResourceContainer implements GameContainer {
  readonly #files: Map<string, Uint8Array>;
  readonly #v3: boolean;
  readonly #prefix: string;
  readonly #combinedName: string | null;
  readonly #headerBytes: number;
  readonly #maxVolume: number;

  /** Takes ownership of `files` (already private copies). */
  constructor(files: Map<string, Uint8Array>, options: ContainerOptions = {}) {
    this.#files = files;
    const inferred =
      options.kind && options.prefix !== undefined ? options : detectContainerFormat(files);
    this.#v3 = (options.kind ?? inferred.kind) === "v3-combined";
    this.#prefix = this.#v3 ? (options.prefix ?? inferred.prefix ?? "") : "";
    this.#combinedName = this.#v3 && files.has(`${this.#prefix}DIR`) ? `${this.#prefix}DIR` : null;
    this.#headerBytes = this.#v3 ? 7 : RECORD_HEADER_BYTES;
    this.#maxVolume = this.#v3 ? 15 : VOLUME_MAX_NUMBER;
    if (this.#combinedName) this.#sections();
    // Normalize: every family has a directory; at least VOL.0 exists.
    for (const kind of RESOURCE_KINDS) {
      const name = DIRECTORY_FILES[kind];
      if (!this.#combinedName && !files.has(name)) {
        files.set(name, new Uint8Array(INITIAL_DIRECTORY_ENTRIES * ENTRY_BYTES).fill(0xff));
      }
    }
    let current = -1;
    for (const name of files.keys()) {
      const m = name.startsWith(this.#prefix)
        ? /^VOL\.(\d+)$/.exec(name.slice(this.#prefix.length))
        : null;
      if (m) current = Math.max(current, Number(m[1]));
    }
    if (current < 0) {
      files.set(volumeFileName(0, this.#prefix), new Uint8Array(0));
    }
  }

  get files(): ReadonlyMap<string, Uint8Array> {
    return this.#files;
  }

  putFile(name: "WORDS.TOK" | "OBJECT" | "TESTS.JSON", payload: Uint8Array): void {
    if (name !== "WORDS.TOK" && name !== "OBJECT" && name !== "TESTS.JSON")
      throw new Error("Only auxiliary game metadata can be replaced directly.");
    this.#files.set(name, payload.slice());
  }

  #sections(): Uint8Array[] {
    const directory = this.#files.get(this.#combinedName!)!;
    if (directory.length < 8) throw new Error("Truncated combined directory.");
    const offsets = RESOURCE_KINDS.map((_, i) => directory[i * 2]! | (directory[i * 2 + 1]! << 8));
    offsets.push(directory.length);
    return RESOURCE_KINDS.map((_, i) => {
      if (offsets[i]! < 8 || offsets[i + 1]! < offsets[i]! || offsets[i + 1]! > directory.length)
        throw new Error("Invalid combined directory offsets.");
      return directory.subarray(offsets[i], offsets[i + 1]);
    });
  }

  #directory(kind: ResourceKind): Uint8Array {
    return this.#combinedName
      ? this.#sections()[RESOURCE_KINDS.indexOf(kind)]!
      : this.#files.get(DIRECTORY_FILES[kind])!;
  }

  #readEntry(kind: ResourceKind, num: number): { volume: number; offset: number } | null {
    const dir = this.#directory(kind);
    const p = num * ENTRY_BYTES;
    if (p + ENTRY_BYTES > dir.length) return null;
    const b0 = dir[p]!;
    const volume = b0 >> 4;
    if (this.#v3 ? b0 === 255 && dir[p + 1] === 255 && dir[p + 2] === 255 : volume === 15)
      return null;
    const offset = ((b0 & 0x0f) << 16) | (dir[p + 1]! << 8) | dir[p + 2]!;
    return { volume, offset };
  }

  getResource(kind: ResourceKind, num: number): Uint8Array | null {
    checkResourceNum(num);
    if (num >= INITIAL_DIRECTORY_ENTRIES) return null;
    const entry = this.#readEntry(kind, num);
    if (entry === null) return null;
    const { volume, offset } = entry;
    const vol = this.#files.get(volumeFileName(volume, this.#prefix));
    if (vol === undefined) {
      throw new Error(
        `corrupt container: ${DIRECTORY_FILES[kind]}[${num}] points to missing VOL.${volume}`,
      );
    }
    if (offset + this.#headerBytes > vol.length) {
      throw new Error(
        `corrupt container: record header at VOL.${volume}:${offset} is out of bounds`,
      );
    }
    if (vol[offset] !== RECORD_MAGIC_0 || vol[offset + 1] !== RECORD_MAGIC_1) {
      throw new Error(`corrupt container: bad record magic at VOL.${volume}:${offset}`);
    }
    const metadata = vol[offset + 2]!;
    if ((this.#v3 && metadata & 0x80 ? metadata & 15 : metadata) !== volume) {
      throw new Error(
        `corrupt container: record volume byte ${vol[offset + 2]} does not match directory volume ${volume}`,
      );
    }
    const length = vol[offset + 3]! | (vol[offset + 4]! << 8);
    const storedLength = this.#v3 ? vol[offset + 5]! | (vol[offset + 6]! << 8) : length;
    if (offset + this.#headerBytes + storedLength > vol.length) {
      throw new Error(`corrupt container: truncated record at VOL.${volume}:${offset}`);
    }
    const stored = vol.slice(offset + this.#headerBytes, offset + this.#headerBytes + storedLength);
    if (this.#v3 && metadata & 0x80) return expandPicture(stored, length);
    if (storedLength === length) return stored;
    const expanded = expandDictionary(stored, length);
    // A dictionary-compressed logic record stores its message text plain
    // (observed v3 game data; see toggleMessageEncryption). Normalizing it to
    // the encrypted layout of the "Logic payload" section means the logic
    // decoder, the disassembler and the authoring tools see one encoding, and
    // a replacement written by putResource (stored directly, encrypted by the
    // assembler) needs no transform of its own.
    return kind === "logic" ? toggleMessageEncryption(expanded) : expanded;
  }

  putResource(kind: ResourceKind, num: number, payload: Uint8Array): void {
    checkResourceNum(num);
    if (num >= INITIAL_DIRECTORY_ENTRIES) throw new RangeError("resource number must be 0..255");
    if (payload.length > PAYLOAD_MAX_BYTES) {
      throw new RangeError(
        `payload of ${payload.length} bytes exceeds the u16le record length limit of ${PAYLOAD_MAX_BYTES}`,
      );
    }
    this.pack({ kind, num, payload });
  }

  /** Build all replacement bytes first; validation failure leaves the live map untouched. */
  pack(replacement?: { kind: ResourceKind; num: number; payload: Uint8Array }): void {
    const directories = RESOURCE_KINDS.map((kind) => {
      const original = this.#directory(kind);
      const required = replacement?.kind === kind ? (replacement.num + 1) * ENTRY_BYTES : 0;
      const bytes = new Uint8Array(Math.max(original.length, required)).fill(0xff);
      bytes.set(original);
      return bytes;
    });
    const volumes: Uint8Array[][] = [[]];
    const lengths = [0];
    const aliases = new Map<string, { volume: number; offset: number }>();
    let volume = 0;
    for (let k = 0; k < RESOURCE_KINDS.length; k++) {
      const kind = RESOURCE_KINDS[k]!;
      const directory = directories[k]!;
      for (let num = 0; num < Math.min(256, Math.floor(directory.length / ENTRY_BYTES)); num++) {
        const replacing = replacement?.kind === kind && replacement.num === num;
        const entry = this.#readEntry(kind, num);
        if (!replacing && !entry) continue;
        const key = entry && !replacing ? `${entry.volume}:${entry.offset}` : null;
        let destination = key ? aliases.get(key) : undefined;
        if (!destination) {
          let record: Uint8Array;
          if (replacing) {
            const payload = replacement!.payload;
            record = new Uint8Array(this.#headerBytes + payload.length);
            record.set([
              RECORD_MAGIC_0,
              RECORD_MAGIC_1,
              0,
              payload.length & 255,
              payload.length >>> 8,
            ]);
            if (this.#v3) record.set([payload.length & 255, payload.length >>> 8], 5);
            record.set(payload, this.#headerBytes);
          } else {
            try {
              // Validate headers, lengths and compressed expansion without re-encoding it.
              this.getResource(kind, num);
            } catch {
              // Keep a damaged resource present-but-unloadable. This offset cannot
              // hold a header in any packed volume. Dropping it would turn a corrupt
              // indexed resource into a missing one; copying its bytes would retain
              // arbitrary historical data and could accidentally repair its pointer.
              directory.set([0x0f, 0xff, 0xff], num * ENTRY_BYTES);
              continue;
            }
            const source = this.#files.get(volumeFileName(entry!.volume, this.#prefix))!;
            const at = entry!.offset;
            const sizeOffset = at + (this.#v3 ? 5 : 3);
            const storedLength = source[sizeOffset]! | (source[sizeOffset + 1]! << 8);
            record = source.slice(at, at + this.#headerBytes + storedLength);
          }
          if (lengths[volume]! + record.length > VOLUME_MAX_BYTES) {
            volume++;
            if (volume > this.#maxVolume)
              throw new Error(`container is full: volume number would exceed ${this.#maxVolume}`);
            volumes.push([]);
            lengths.push(0);
          }
          destination = { volume, offset: lengths[volume]! };
          // Preserve picture-compression metadata, changing only the volume nibble.
          record[2] = this.#v3 && record[2]! & 0x80 ? (record[2]! & 0xf0) | volume : volume;
          volumes[volume]!.push(record);
          lengths[volume]! += record.length;
          if (key) aliases.set(key, destination);
        }
        const p = num * ENTRY_BYTES;
        directory[p] = (destination.volume << 4) | (destination.offset >> 16);
        directory[p + 1] = (destination.offset >> 8) & 255;
        directory[p + 2] = destination.offset & 255;
      }
    }

    const updated = new Map<string, Uint8Array>();
    if (this.#combinedName) {
      const size = 8 + directories.reduce((total, bytes) => total + bytes.length, 0);
      if (size > 0xffff) throw new Error("Combined directory exceeds its offset limit.");
      const combined = new Uint8Array(size);
      let cursor = 8;
      for (let i = 0; i < directories.length; i++) {
        combined[i * 2] = cursor & 255;
        combined[i * 2 + 1] = cursor >> 8;
        combined.set(directories[i]!, cursor);
        cursor += directories[i]!.length;
      }
      updated.set(this.#combinedName, combined);
    } else {
      RESOURCE_KINDS.forEach((kind, i) => updated.set(DIRECTORY_FILES[kind], directories[i]!));
    }
    for (let i = 0; i < volumes.length; i++) {
      const bytes = new Uint8Array(lengths[i]!);
      let cursor = 0;
      for (const record of volumes[i]!) {
        bytes.set(record, cursor);
        cursor += record.length;
      }
      updated.set(volumeFileName(i, this.#prefix), bytes);
    }
    for (const name of this.#files.keys()) {
      if (name.startsWith(this.#prefix) && /^VOL\.\d+$/.test(name.slice(this.#prefix.length))) {
        this.#files.delete(name);
      }
    }
    for (const [name, bytes] of updated) this.#files.set(name, bytes);
  }
}

/** A fresh, empty v2 split container: four absent-filled directories and an empty VOL.0. */
export function createContainer(): GameContainer {
  const files = new Map<string, Uint8Array>();
  for (const kind of RESOURCE_KINDS) {
    files.set(
      DIRECTORY_FILES[kind],
      new Uint8Array(INITIAL_DIRECTORY_ENTRIES * ENTRY_BYTES).fill(0xff),
    );
  }
  files.set(volumeFileName(0), new Uint8Array(0));
  return new ResourceContainer(files);
}

/**
 * Wrap existing container files (e.g. a persisted or externally patched game).
 * The map and every byte array are copied, so later writes never alias the
 * caller's image.
 */
export function openContainer(
  files: ReadonlyMap<string, Uint8Array>,
  options: ContainerOptions = {},
): GameContainer {
  const copy = new Map<string, Uint8Array>();
  // new Uint8Array, not .slice(): Buffer.prototype.slice returns a view, so a
  // Node Buffer input would alias the caller's storage despite this contract.
  for (const [name, bytes] of files) copy.set(name, new Uint8Array(bytes));
  return new ResourceContainer(copy, options);
}

/** Convenience: build a container from a partial map of kind -> (num -> payload). */
export function containerFromResources(
  resources: Partial<Readonly<Record<ResourceKind, ReadonlyMap<number, Uint8Array>>>>,
): GameContainer {
  const container = createContainer();
  for (const kind of RESOURCE_KINDS) {
    const byNum = resources[kind];
    if (!byNum) continue;
    for (const [num, payload] of byNum) container.putResource(kind, num, payload);
  }
  return container;
}

/**
 * Return an independent packed image of the currently indexed resources.
 * Valid records retain their encoding; damaged records remain indexed with a
 * deliberately dangling pointer, so loading them still reports corruption.
 * Auxiliary files are copied unchanged. No reachability-based pruning is applied.
 */
export function compactContainer(
  files: ReadonlyMap<string, Uint8Array>,
  options: ContainerOptions = {},
): Map<string, Uint8Array> {
  const copy = new Map([...files].map(([name, bytes]) => [name, new Uint8Array(bytes)]));
  const container = new ResourceContainer(copy, options);
  container.pack();
  return new Map(container.files);
}

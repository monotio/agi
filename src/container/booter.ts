/**
 * Resource-file extraction from the PC booter 2.001 layout.
 * Clean-room disk observations and native loader behavior are recorded in
 * docs/fidelity.md (pc-booter-resource-layout). Resource records and directory
 * entries use the agi-re "Resource Containers" five-byte/three-byte contracts.
 * Inventory and sound payloads remain in their original 2.001 formats.
 */
export interface BooterFileRecord {
  readonly slot: number;
  readonly offset: number;
  readonly bytes: number;
}

export interface BooterEvidence {
  readonly format: "pc-booter-2.001";
  readonly interpreterVersion: "2.001";
  readonly imageBytes: number;
  readonly interpreterData: Uint8Array;
  readonly fileTable: Readonly<Record<string, BooterFileRecord>>;
}

export interface DecodedBooter {
  readonly files: Map<string, Uint8Array>;
  readonly evidence: BooterEvidence;
}

const IMAGE_BYTES = 360 * 1024;
const MASTER_DIRECTORY = 512;
const RECORD_HEADER_BYTES = 5;
const VOLUME_SLOT = 14;
/** Cheap precheck for the supported layout; decodeBooter performs full validation. */
export function isBooterImage(bytes: Uint8Array): boolean {
  if (bytes.length !== IMAGE_BYTES) return false;
  const signature = "BOOT v2.0";
  for (let i = 0; i < signature.length; i++)
    if (bytes[6 + i] !== signature.charCodeAt(i)) return false;
  return true;
}
const FILE_SLOTS: Readonly<Record<string, number>> = {
  "AGIDATA.OVL": 6,
  OBJECT: 8,
  "WORDS.TOK": 9,
  LOGDIR: 10,
  PICDIR: 11,
  VIEWDIR: 12,
  SNDDIR: 13,
};
const RESOURCE_DIRECTORIES = ["LOGDIR", "PICDIR", "VIEWDIR", "SNDDIR"] as const;

function readMasterOffset(image: Uint8Array, slot: number, name: string, marker: number): number {
  const at = MASTER_DIRECTORY + slot * 3;
  if (image[at]! >> 4 !== marker)
    throw new Error(`${name}: unsupported or absent master-directory entry`);
  return ((image[at]! & 15) << 16) | (image[at + 1]! << 8) | image[at + 2]!;
}

function recordEnd(image: Uint8Array, offset: number, name: string): number {
  if (offset < 1024 || offset + RECORD_HEADER_BYTES > image.length)
    throw new Error(`${name}: record header outside the disk image`);
  if (image[offset] !== 0x12 || image[offset + 1] !== 0x34)
    throw new Error(`${name}: invalid record magic`);
  if (image[offset + 2] !== 0) throw new Error(`${name}: invalid record volume`);
  const length = image[offset + 3]! | (image[offset + 4]! << 8);
  const end = offset + RECORD_HEADER_BYTES + length;
  if (end > image.length) throw new Error(`${name}: resource payload outside the disk image`);
  return end;
}

/**
 * Decode the supported single-disk format into owned resource-file bytes.
 * Structural evidence identifies the layout; it is not an authenticity claim.
 * Native interpreter data is returned separately and never assigned a later
 * version label. No resource bytecode, inventory, or sound conversion occurs.
 */
export function decodeBooter(image: Uint8Array): DecodedBooter {
  if (image.length !== IMAGE_BYTES)
    throw new Error(`Unsupported PC booter disk image size: ${image.length}`);
  const signature = "BOOT v2.0";
  for (let i = 0; i < signature.length; i++)
    if (image[6 + i] !== signature.charCodeAt(i))
      throw new Error("Unsupported PC booter boot signature");

  const files = new Map<string, Uint8Array>();
  const fileTable: Record<string, BooterFileRecord> = {};
  for (const [name, slot] of Object.entries(FILE_SLOTS)) {
    const offset = readMasterOffset(image, slot, name, 1);
    const end = recordEnd(image, offset, name);
    for (const [previous, record] of Object.entries(fileTable))
      if (offset < record.offset + RECORD_HEADER_BYTES + record.bytes && record.offset < end)
        throw new Error(`${name}: master record overlaps ${previous}`);
    fileTable[name] = { slot, offset, bytes: end - offset - RECORD_HEADER_BYTES };
    files.set(name, image.slice(offset + RECORD_HEADER_BYTES, end));
  }

  const interpreterData = files.get("AGIDATA.OVL")!;
  const interpreterText = Array.from(interpreterData, (byte) => String.fromCharCode(byte)).join("");
  const version = /Version[ \t]+(\d+\.\d{3}(?:\.\d{3})?)(?!\d)/.exec(interpreterText)?.[1];
  if (version !== "2.001")
    throw new Error(`Unsupported PC booter interpreter version: ${version ?? "unavailable"}`);
  files.delete("AGIDATA.OVL");

  const volumeOffset = readMasterOffset(image, VOLUME_SLOT, "VOL.0", 0);
  for (const [name, record] of Object.entries(fileTable))
    if (volumeOffset < record.offset + RECORD_HEADER_BYTES + record.bytes)
      throw new Error(`VOL.0: volume overlaps master record ${name}`);
  if (volumeOffset + RECORD_HEADER_BYTES > image.length)
    throw new Error("VOL.0: volume starts outside the disk image");
  let volumeEnd = volumeOffset;
  for (const name of RESOURCE_DIRECTORIES) {
    const directory = files.get(name)!;
    for (let id = 0; id < Math.min(256, Math.floor(directory.length / 3)); id++) {
      const at = id * 3;
      const volume = directory[at]! >> 4;
      if (volume === 15) continue;
      if (volume !== 0)
        throw new Error(`${name}[${id}]: unavailable volume ${volume} in single-disk booter`);
      const relative =
        ((directory[at]! & 15) << 16) | (directory[at + 1]! << 8) | directory[at + 2]!;
      const end = recordEnd(image, volumeOffset + relative, `${name}[${id}]`);
      volumeEnd = Math.max(volumeEnd, end);
    }
  }
  files.set("VOL.0", image.slice(volumeOffset, volumeEnd));
  fileTable["VOL.0"] = { slot: VOLUME_SLOT, offset: volumeOffset, bytes: volumeEnd - volumeOffset };
  return {
    files,
    evidence: {
      format: "pc-booter-2.001",
      interpreterVersion: "2.001",
      imageBytes: image.length,
      interpreterData,
      fileTable,
    },
  };
}

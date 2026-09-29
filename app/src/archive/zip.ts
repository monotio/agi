/**
 * Zero-dependency PKZIP 2.0 uncompressed archive builder.
 * Produces clean, standards-compliant .zip files directly in browser or Node.
 */

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[i] = c;
}

export function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipFileInput {
  name: string;
  data: Uint8Array | string;
}

export function buildZip(files: readonly ZipFileInput[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const fileEntries: {
    nameBytes: Uint8Array;
    dataBytes: Uint8Array;
    crc: number;
    offset: number;
  }[] = [];

  const localHeadersAndData: Uint8Array[] = [];
  let currentOffset = 0;

  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const dataBytes = typeof f.data === "string" ? encoder.encode(f.data) : f.data;
    const crc = crc32(dataBytes);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(localHeader.buffer);

    view.setUint32(0, 0x04034b50, true); // Local file header signature
    view.setUint16(4, 20, true); // Version needed (2.0)
    view.setUint16(6, 0, true); // Flags
    view.setUint16(8, 0, true); // Compression = 0 (stored)
    view.setUint16(10, 0, true); // Mod time
    view.setUint16(12, 0, true); // Mod date
    view.setUint32(14, crc, true); // CRC32
    view.setUint32(18, dataBytes.length, true); // Compressed size
    view.setUint32(22, dataBytes.length, true); // Uncompressed size
    view.setUint16(26, nameBytes.length, true); // Filename length
    view.setUint16(28, 0, true); // Extra field length
    localHeader.set(nameBytes, 30);

    localHeadersAndData.push(localHeader, dataBytes);

    fileEntries.push({
      nameBytes,
      dataBytes,
      crc,
      offset: currentOffset,
    });

    currentOffset += localHeader.length + dataBytes.length;
  }

  const centralDirStart = currentOffset;
  const centralDirEntries: Uint8Array[] = [];

  for (const entry of fileEntries) {
    const header = new Uint8Array(46 + entry.nameBytes.length);
    const view = new DataView(header.buffer);

    view.setUint32(0, 0x02014b50, true); // Central directory header signature
    view.setUint16(4, 20, true); // Version made by
    view.setUint16(6, 20, true); // Version needed
    view.setUint16(8, 0, true); // Flags
    view.setUint16(10, 0, true); // Compression = 0
    view.setUint16(12, 0, true); // Mod time
    view.setUint16(14, 0, true); // Mod date
    view.setUint32(16, entry.crc, true); // CRC32
    view.setUint32(20, entry.dataBytes.length, true); // Compressed size
    view.setUint32(24, entry.dataBytes.length, true); // Uncompressed size
    view.setUint16(28, entry.nameBytes.length, true); // Filename length
    view.setUint16(30, 0, true); // Extra length
    view.setUint16(32, 0, true); // Comment length
    view.setUint16(34, 0, true); // Disk start
    view.setUint16(36, 0, true); // Internal attr
    view.setUint32(38, 0, true); // External attr
    view.setUint32(42, entry.offset, true); // Local header offset
    header.set(entry.nameBytes, 46);

    centralDirEntries.push(header);
    currentOffset += header.length;
  }

  const centralDirSize = currentOffset - centralDirStart;

  // End of Central Directory Record (22 bytes)
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // EOCD signature
  eocdView.setUint16(4, 0, true); // Disk number
  eocdView.setUint16(6, 0, true); // Central dir start disk
  eocdView.setUint16(8, fileEntries.length, true); // Records on this disk
  eocdView.setUint16(10, fileEntries.length, true); // Total records
  eocdView.setUint32(12, centralDirSize, true); // Central dir size
  eocdView.setUint32(16, centralDirStart, true); // Central dir offset
  eocdView.setUint16(20, 0, true); // Comment length

  const totalLength = currentOffset + eocd.length;
  const out = new Uint8Array(totalLength);
  let pos = 0;
  for (const part of [...localHeadersAndData, ...centralDirEntries, eocd]) {
    out.set(part, pos);
    pos += part.length;
  }

  return out;
}

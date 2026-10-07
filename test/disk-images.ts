/** Synthetic media. Offsets follow the published structures, independent of readers. */
export function fatDisk(files: ReadonlyMap<string, Uint8Array>, bpb = true): Uint8Array {
  const bytes = new Uint8Array(360 * 1024);
  const view = new DataView(bytes.buffer);
  if (bpb) {
    view.setUint16(11, 512, true);
    bytes[13] = 2;
    view.setUint16(14, 1, true);
    bytes[16] = 2;
    view.setUint16(17, 112, true);
    view.setUint16(19, 720, true);
    bytes[21] = 0xfd;
    view.setUint16(22, 2, true);
    view.setUint16(24, 9, true);
    view.setUint16(26, 2, true);
  }
  bytes.set([0xfd, 0xff, 0xff], 512);
  let cluster = 2;
  let entry = 5 * 512;
  for (const [name, data] of files) {
    const [base, ext = ""] = name.split(".");
    bytes.set(new TextEncoder().encode(base!.padEnd(8) + ext.padEnd(3)), entry);
    view.setUint16(entry + 26, data.length ? cluster : 0, true);
    view.setUint32(entry + 28, data.length, true);
    for (let offset = 0; offset < data.length; offset += 1024) {
      const next = offset + 1024 < data.length ? cluster + 1 : 0xfff;
      const at = 512 + Math.floor((cluster * 3) / 2);
      const packed = view.getUint16(at, true);
      view.setUint16(
        at,
        cluster & 1 ? (packed & 15) | (next << 4) : (packed & 0xf000) | next,
        true,
      );
      bytes.set(data.subarray(offset, offset + 1024), 12 * 512 + (cluster - 2) * 1024);
      cluster++;
    }
    entry += 32;
  }
  bytes.set(bytes.subarray(512, 1536), 1536);
  return bytes;
}

export function adfDisk(ffs: boolean): Uint8Array {
  const bytes = new Uint8Array(880 * 1024);
  const view = new DataView(bytes.buffer);
  bytes.set([68, 79, 83, Number(ffs)]);
  view.setUint32(8, 880);
  const word = (block: number, offset: number, value: number) =>
    view.setUint32(block * 512 + offset, value);
  const name = (block: number, value: string) => {
    bytes[block * 512 + 432] = value.length;
    bytes.set(new TextEncoder().encode(value), block * 512 + 433);
  };
  word(880, 0, 2);
  word(880, 12, 72);
  word(880, 508, 1);
  word(880, 24, 10);
  word(10, 0, 2);
  word(10, 508, 2);
  name(10, "GAME");
  word(10, 24, 11);
  word(11, 0, 2);
  word(11, 508, 0xfffffffd);
  name(11, "WORDS.TOK");
  word(11, 324, 3);
  word(11, 8, 1);
  word(11, 308, 12);
  if (!ffs) {
    word(12, 0, 8);
    word(12, 12, 3);
  }
  bytes.set([17, 34, 51], 12 * 512 + (ffs ? 0 : 24));
  for (const block of [880, 10, 11, ...(!ffs ? [12] : [])]) {
    let sum = 0;
    for (let at = 0; at < 512; at += 4) sum = (sum + view.getUint32(block * 512 + at)) >>> 0;
    word(block, 20, -sum >>> 0);
  }
  return bytes;
}

export function prodosDisk(): Uint8Array {
  const bytes = new Uint8Array(800 * 1024);
  const view = new DataView(bytes.buffer);
  bytes[1028] = 0xf4;
  bytes.set(new TextEncoder().encode("GAME"), 1029);
  bytes[1059] = 39;
  bytes[1060] = 13;
  view.setUint16(1065, 1600, true);
  const at = 1028 + 39;
  bytes[at] = 0x29;
  bytes.set(new TextEncoder().encode("WORDS.TOK"), at + 1);
  view.setUint16(at + 17, 6, true);
  view.setUint16(at + 19, 3, true);
  bytes[at + 21] = 3;
  bytes[at + 22] = 2;
  bytes[6 * 512] = 7;
  bytes[6 * 512 + 1] = 8;
  bytes.fill(17, 7 * 512, 8 * 512);
  bytes.set([34, 51, 68], 8 * 512);
  return bytes;
}

export function twoMg(payload: Uint8Array, order = 1): Uint8Array {
  const bytes = new Uint8Array(64 + payload.length);
  bytes.set(new TextEncoder().encode("2IMG"));
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 64, true);
  view.setUint16(10, 1, true);
  view.setUint32(12, order, true);
  view.setUint32(20, payload.length / 512, true);
  view.setUint32(24, 64, true);
  view.setUint32(28, payload.length, true);
  bytes.set(payload, 64);
  return bytes;
}

export function td0Disk(raw: Uint8Array, mode: 0 | 1 | 2 = 0): Uint8Array {
  const crc = (data: readonly number[]) => {
    let value = 0;
    for (const byte of data) {
      value ^= byte * 256;
      for (let bit = 0; bit < 8; bit++)
        value = ((value * 2) ^ (value >= 32768 ? 0xa097 : 0)) & 65535;
    }
    return value;
  };
  const output: number[] = [84, 68, 0, 0, 21, 0, 1, 0, 0, 2, 0, 0];
  const headerCrc = crc(output.slice(0, 10));
  output[10] = headerCrc & 255;
  output[11] = headerCrc >> 8;
  for (let cylinder = 0; cylinder < 40; cylinder++)
    for (let head = 0; head < 2; head++) {
      output.push(9, cylinder, head, crc([9, cylinder, head]) & 255);
      for (let sector = 1; sector <= 9; sector++) {
        const at = ((cylinder * 2 + head) * 9 + sector - 1) * 512;
        const data = raw.subarray(at, at + 512);
        let packed = [0, ...data];
        if (mode === 1 && data.every((byte, index) => byte === data[index % 2]))
          packed = [1, 0, 1, data[0]!, data[1]!];
        if (mode === 2) {
          if (data.every((byte, index) => byte === data[index % 4]))
            packed = [2, 2, 128, ...data.subarray(0, 4)];
          else
            packed = [
              2,
              0,
              255,
              ...data.subarray(0, 255),
              0,
              255,
              ...data.subarray(255, 510),
              0,
              2,
              ...data.subarray(510),
            ];
        }
        output.push(
          cylinder,
          head,
          sector,
          2,
          0,
          crc([...data]) & 255,
          packed.length & 255,
          packed.length >> 8,
          ...packed,
        );
      }
    }
  output.push(255);
  return new Uint8Array(output);
}

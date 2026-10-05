import { decodeBooter, isBooterImage } from "../booter.ts";
import { readFat12 } from "./fat12.ts";
import { readAdf } from "./adf.ts";
import { readProDos } from "./prodos.ts";
import { readTeleDisk } from "./teledisk.ts";
import type { DiskFiles } from "./files.ts";

export function isDiskImageName(name: string): boolean {
  return /\.(?:img|ima|dsk|td0|adf|po|2mg)$/i.test(name);
}

/** Extract file bytes only. Interpreter profile hints remain in those files. */
export function readDiskImage(name: string, bytes: Uint8Array): DiskFiles {
  if (isBooterImage(bytes)) {
    const decoded = decodeBooter(bytes);
    decoded.files.set("AGIDATA.OVL", decoded.evidence.interpreterData);
    return { files: decoded.files, unreadable: new Map() };
  }
  if (/\.td0$/i.test(name)) return readTeleDisk(bytes);
  if (/\.adf$/i.test(name)) return readAdf(bytes);
  if (/\.(?:po|2mg)$/i.test(name)) return readProDos(bytes, /\.2mg$/i.test(name));
  return readFat12(bytes);
}

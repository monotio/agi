import { decodeBooter, isBooterImage } from "../booter.ts";
import { readFat12 } from "./fat12.ts";
import { readAdf } from "./adf.ts";
import { readProDos } from "./prodos.ts";
import { readTeleDisk } from "./teledisk.ts";
import {
  createDiskExtractionBudget,
  reserveDiskBytes,
  reserveDiskFile,
  type DiskExtractionBudget,
  type DiskFiles,
} from "./files.ts";

export function isDiskImageName(name: string): boolean {
  return /\.(?:img|ima|dsk|td0|adf|po|2mg)$/i.test(name);
}

/** Extract file bytes only. Interpreter profile hints remain in those files. */
export function readDiskImage(
  name: string,
  bytes: Uint8Array,
  budget: DiskExtractionBudget = createDiskExtractionBudget(),
): DiskFiles {
  if (isBooterImage(bytes)) {
    // A refused or failing decode gives back what it reserved.
    const { bytes: reservedBytes, files: reservedFiles } = budget;
    let decoded: ReturnType<typeof decodeBooter>;
    try {
      decoded = decodeBooter(bytes, (size) => {
        reserveDiskFile(budget);
        reserveDiskBytes(budget, size);
      });
    } catch (error) {
      budget.bytes = reservedBytes;
      budget.files = reservedFiles;
      throw error;
    }
    decoded.files.set("AGIDATA.OVL", decoded.evidence.interpreterData);
    return { files: decoded.files, unreadable: new Map() };
  }
  if (/\.td0$/i.test(name)) return readTeleDisk(bytes, budget);
  if (/\.adf$/i.test(name)) return readAdf(bytes, budget);
  if (/\.(?:po|2mg)$/i.test(name)) return readProDos(bytes, /\.2mg$/i.test(name), budget);
  return readFat12(bytes, undefined, budget);
}

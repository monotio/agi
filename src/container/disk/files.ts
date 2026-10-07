export interface DiskFiles {
  readonly files: Map<string, Uint8Array>;
  readonly unreadable: Map<string, string>;
}

/** One import owns one budget, including files it later ignores or deduplicates. */
export interface DiskExtractionBudget {
  bytes: number;
  files: number;
  readonly maxBytes: number;
  readonly maxFiles: number;
}

export function createDiskExtractionBudget(): DiskExtractionBudget {
  return { bytes: 0, files: 0, maxBytes: 256 * 1024 * 1024, maxFiles: 1024 };
}

class DiskBudgetError extends Error {}

export function reserveDiskBytes(budget: DiskExtractionBudget, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > budget.maxBytes - budget.bytes)
    throw new DiskBudgetError(
      "The disks expand beyond the game import limit. Add one game at a time.",
    );
  budget.bytes += size;
}

export function reserveDiskFile(budget: DiskExtractionBudget): void {
  if (budget.files >= budget.maxFiles)
    throw new DiskBudgetError("The disks have too many files. Add one game at a time.");
  budget.files++;
}

export function diskView(bytes: Uint8Array, offset: number, length: number): DataView {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.length)
    throw new Error("The disk has a damaged block pointer. Add a fresh copy of the disk.");
  return new DataView(bytes.buffer, bytes.byteOffset + offset, length);
}

export function diskName(bytes: Uint8Array): string {
  const name = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  if (
    !name ||
    bytes.some((byte) => byte < 32) ||
    /[/:\\]/.test(name) ||
    name === "." ||
    name === ".."
  )
    throw new Error("The disk has a damaged filename. Add a fresh copy of the disk.");
  return name.toUpperCase();
}

export function addDiskFile(
  result: DiskFiles,
  name: string,
  budget: DiskExtractionBudget,
  read: () => Uint8Array,
): void {
  if (result.files.has(name) || result.unreadable.has(name))
    throw new Error(`The disk repeats ${name}. Add a fresh copy of the disk.`);
  reserveDiskFile(budget);
  try {
    result.files.set(name, read());
  } catch (error) {
    if (error instanceof DiskBudgetError) throw error;
    result.unreadable.set(name, String(error).replace(/^Error: /, ""));
  }
}

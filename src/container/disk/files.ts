export interface DiskFiles {
  readonly files: Map<string, Uint8Array>;
  readonly unreadable: Map<string, string>;
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

export function addDiskFile(result: DiskFiles, name: string, read: () => Uint8Array): void {
  if (result.files.has(name) || result.unreadable.has(name))
    throw new Error(`The disk repeats ${name}. Add a fresh copy of the disk.`);
  if (result.files.size + result.unreadable.size >= 1024)
    throw new Error("The disk has too many files. Add a disk with at most 1024 files.");
  try {
    result.files.set(name, read());
  } catch (error) {
    result.unreadable.set(name, String(error).replace(/^Error: /, ""));
  }
}

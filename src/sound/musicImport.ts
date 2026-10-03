import type { SoundDocument } from "./document.ts";

export interface SoundImport {
  readonly document: SoundDocument;
  readonly tempo: number;
  readonly summary: string;
}

/** Bounded binary cursor shared by the two music-file readers. */
export class MusicReader {
  readonly bytes: Uint8Array;
  readonly format: string;
  position = 0;
  readonly end: number;

  constructor(bytes: Uint8Array, format: string, start = 0, end = bytes.length) {
    if (bytes.length > 4 * 1024 * 1024)
      throw new Error(`${format} file is too large. Choose a file under 4 MB.`);
    this.bytes = bytes;
    this.format = format;
    this.position = start;
    this.end = end;
  }
  byte(): number {
    if (this.position >= this.end)
      throw new Error(`${this.format} is truncated. Choose a complete file.`);
    return this.bytes[this.position++]!;
  }
  number(length: number, little = false): number {
    let result = 0;
    for (let i = 0; i < length; i++) {
      const value = this.byte();
      result = little ? result + value * 2 ** (8 * i) : result * 256 + value;
    }
    return result;
  }
  text(length: number): string {
    return String.fromCharCode(...this.take(length));
  }
  take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > this.end)
      throw new Error(`${this.format} is truncated. Choose a complete file.`);
    const result = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return result;
  }
  vlq(): number {
    let result = 0;
    for (let i = 0; i < 4; i++) {
      const value = this.byte();
      result = result * 128 + (value & 127);
      if (!(value & 128)) return result;
    }
    throw new Error("MIDI variable-length delta exceeds four bytes. Choose a valid MIDI file.");
  }
}

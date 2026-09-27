/**
 * Frame ring buffer for the engine worker (the authoring contract, "Perception":
 * "the worker keeps a ring buffer of raw frames ... every cycle for the last
 * seconds plus a 1 Hz history").
 *
 * Storage is three preallocated flat typed arrays plus two small index
 * arrays, so pushing a cycle costs exactly three `set()` copies and no
 * allocation at all. Frames are only materialised as separate objects when
 * the agent asks for them, and those copies are transferred to the main
 * thread rather than structured-cloned.
 */

/** Visual / priority surface, 160x168 nibbles. */
export const SURFACE_BYTES = 160 * 168;
/** Text surface, 40x25 [char, attr] cells. */
export const TEXT_BYTES = 40 * 25 * 2;

export interface RingFrame {
  cycle: number;
  visual: Uint8Array;
  priority: Uint8Array;
  text: Uint8Array;
  picRow: number;
}

export class FrameRing {
  readonly capacity: number;
  private visual: Uint8Array | null = null;
  private priority: Uint8Array | null = null;
  private text: Uint8Array | null = null;
  private picRow: Uint8Array | null = null;
  private cycle: Int32Array | null = null;
  /** Slot the next push writes to. */
  private head: number;
  /** Frames stored so far, capped at capacity. */
  private filled: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.head = 0;
    this.filled = 0;
  }

  get isAllocated(): boolean {
    return this.visual !== null;
  }

  private ensureAllocated(): void {
    if (this.visual !== null) return;
    this.visual = new Uint8Array(this.capacity * SURFACE_BYTES);
    this.priority = new Uint8Array(this.capacity * SURFACE_BYTES);
    this.text = new Uint8Array(this.capacity * TEXT_BYTES);
    this.picRow = new Uint8Array(this.capacity);
    this.cycle = new Int32Array(this.capacity);
  }

  get size(): number {
    return this.filled;
  }

  reset(): void {
    this.head = 0;
    this.filled = 0;
    if (this.cycle) this.cycle.fill(0);
  }

  push(
    cycle: number,
    visual: Uint8Array,
    priority: Uint8Array,
    text: Uint8Array,
    picRow: number,
  ): void {
    this.ensureAllocated();
    const slot = this.head;
    this.visual!.set(visual.subarray(0, SURFACE_BYTES), slot * SURFACE_BYTES);
    this.priority!.set(priority.subarray(0, SURFACE_BYTES), slot * SURFACE_BYTES);
    this.text!.set(text.subarray(0, TEXT_BYTES), slot * TEXT_BYTES);
    this.picRow![slot] = picRow & 0xff;
    this.cycle![slot] = cycle;
    this.head = (slot + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  /**
   * The newest `count` frames taking every `stride`-th stored frame, returned
   * OLDEST FIRST (reading order for a contact sheet). `since` skips frames at
   * or before that cycle number, so a caller can poll for new frames only.
   */
  take(count: number, stride: number, since: number | null): RingFrame[] {
    if (!this.visual || !this.priority || !this.text || !this.picRow || !this.cycle) {
      return [];
    }
    const step = Math.max(1, Math.floor(stride));
    const want = Math.max(1, Math.floor(count));
    const out: RingFrame[] = [];
    // Walk backwards from the newest stored frame.
    for (let back = 0; back < this.filled && out.length < want; back += step) {
      const slot = (this.head - 1 - back + this.capacity * 2) % this.capacity;
      const cycle = this.cycle[slot]!;
      if (since !== null && cycle <= since) break;
      out.push({
        cycle,
        visual: this.visual.slice(slot * SURFACE_BYTES, (slot + 1) * SURFACE_BYTES),
        priority: this.priority.slice(slot * SURFACE_BYTES, (slot + 1) * SURFACE_BYTES),
        text: this.text.slice(slot * TEXT_BYTES, (slot + 1) * TEXT_BYTES),
        picRow: this.picRow[slot]!,
      });
    }
    out.reverse();
    return out;
  }
}

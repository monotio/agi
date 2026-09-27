/** AGI event queue, clean-room from agi-re "Event queue" and "Raw-key condition". */
import { NAV_KEYS, normalizeModalKey } from "./keys.ts";

export type InputEvent = {
  type: 1 | 2 | 3;
  value: number;
  /**
   * Carried by modal keys in replay states written by earlier releases. Every
   * raw event now maps when the input phase consumes it, so the mark changes
   * nothing; the engine no longer sets it.
   */
  mapOnConsume?: true;
};

/** Twenty circular slots leave one empty, permitting nineteen pending events. */
export class InputQueue {
  private slots: (InputEvent | undefined)[] = Array<InputEvent | undefined>(20);
  private read = 0;
  private write = 0;

  enqueue(event: InputEvent): boolean {
    const next = (this.write + 1) % 20;
    if (next === this.read) return false;
    this.slots[this.write] = event;
    this.write = next;
    return true;
  }

  /**
   * A key as the original's timer-driven keyboard poll queues it: navigation
   * words become type-2 events and everything else stays a raw type-1 key.
   * Script mappings (set.key) apply only when the cycle's input phase consumes
   * the event; have.key and modal windows read it raw (docs/fidelity.md,
   * "Script key mappings and have.key").
   */
  enqueueKey(word: number): boolean {
    const key = word & 0xff ? word & 0xff : word & 0xffff;
    const navigation = NAV_KEYS[key];
    return this.enqueue(
      navigation === undefined ? { type: 1, value: key } : { type: 2, value: navigation },
    );
  }

  /** A raw host key delivered while a modal owns the interpreter: keypad Enter/Escape normalize to their twins. */
  enqueueModalKey(word: number): boolean {
    return this.enqueueKey(normalizeModalKey(word));
  }

  dequeue(): InputEvent | undefined {
    if (this.read === this.write) return undefined;
    const event = this.slots[this.read];
    this.slots[this.read] = undefined;
    this.read = (this.read + 1) % 20;
    return event;
  }

  snapshot(): InputEvent[] {
    const events: InputEvent[] = [];
    for (let at = this.read; at !== this.write; at = (at + 1) % 20)
      events.push({ ...this.slots[at]! });
    return events;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.read = 0;
    this.write = 0;
  }
}

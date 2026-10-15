/** AGI event queue, clean-room from agi-re "Event queue" and "Raw-key condition". */
import { NAV_KEYS, normalizeKeyWord } from "./keys.ts";

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
  private readonly keypadWords: boolean;

  /**
   * @param keypadWords the queue keeps the full 16-bit keypad Enter/Escape
   * words and leaves normalization to the consuming GetKey path (demopac4
   * 3.002.102 PostEvent 0x48DD / ButtonToChar 0x4A78 — probed on kq3 2.936,
   * demopac4, mh1 3.002.107 and gr1 3.002.149); unprobed builds mask queued
   * keys to their low byte and normalize only modal drains.
   */
  constructor(keypadWords: boolean) {
    this.keypadWords = keypadWords;
  }
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
   * A key as the original's keyboard poll queues it: navigation words become
   * type-2 events, ASCII keys keep only their ASCII byte, and everything else
   * stays a raw type-1 key. With `keypadWords` the queue stores the keypad
   * Enter/Escape duplicates 0x0101/0x0201/0x0301/0x0401 whole; without it
   * they mask to their low byte like every other word.
   * Script mappings (set.key) apply only when the cycle's input phase consumes
   * the event; have.key and modal windows read it raw (docs/fidelity.md,
   * "Script key mappings and have.key").
   */
  enqueueKey(word: number): boolean {
    const full = word & 0xffff;
    const keypad =
      this.keypadWords &&
      (full === 0x0101 || full === 0x0201 || full === 0x0301 || full === 0x0401);
    const key = keypad ? full : word & 0xff ? word & 0xff : full;
    const navigation = NAV_KEYS[key];
    return this.enqueue(
      navigation === undefined ? { type: 1, value: key } : { type: 2, value: navigation },
    );
  }

  /**
   * A raw host key delivered while a modal owns the interpreter. Modal drains
   * normalize the keypad words on every build; with `keypadWords` the queue
   * keeps the full word and the consumer normalizes instead.
   */
  enqueueModalKey(word: number): boolean {
    return this.keypadWords ? this.enqueueKey(word) : this.enqueueKey(normalizeKeyWord(word));
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

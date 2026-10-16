/** AGI event queue, clean-room from agi-re "Event queue" and "Raw-key condition". */
import { KEYPAD_DIRECTION_WORDS, NAV_KEYS } from "./keys.ts";

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
   * @param keypadWords true on PC profiles (whose PollKey strips the high BIOS
   * scan byte on non-zero ASCII words); false on Amiga and IIgs profiles. All
   * twenty builds store 16-bit event words and keep the button/keypad words
   * 0x0101..0x0401 whole (docs/fidelity.md "Original input, menu and modal
   * handling", F-IN-04).
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
   * A key as the original's keyboard poll queues it: navigation words and
   * keypad direction words become type-2 events, PC BIOS ASCII keys keep only
   * their ASCII byte (`or al, al; jz +2; xor bh, bh`), the button/keypad words
   * 0x0101..0x0401 and Amiga Meta-qualified words stay whole, and everything
   * else stays a raw type-1 key.
   * Script mappings (set.key) apply only when the cycle's input phase consumes
   * the event; have.key and modal windows read it raw (docs/fidelity.md,
   * "Script key mappings and have.key").
   */
  enqueueKey(word: number): boolean {
    const full = word & 0xffff;
    const preserveFull =
      full === 0x0101 ||
      full === 0x0201 ||
      full === 0x0301 ||
      full === 0x0401 ||
      (!this.keypadWords && (full & 0xff00) === 0x0100);
    const key = preserveFull ? full : word & 0xff ? word & 0xff : full;
    const navigation = NAV_KEYS[key] ?? KEYPAD_DIRECTION_WORDS[key];
    return this.enqueue(
      navigation === undefined ? { type: 1, value: key } : { type: 2, value: navigation },
    );
  }

  /**
   * A raw host key delivered while a modal owns the interpreter. The queue
   * keeps the full 16-bit word and modalKey normalizes it via ButtonToChar.
   */
  enqueueModalKey(word: number): boolean {
    return this.enqueueKey(word);
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

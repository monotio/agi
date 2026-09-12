/** AGI event queue, clean-room from agi-re "Event queue" and "Raw-key condition". */
import { NAV_KEYS, normalizeModalKey } from "./keys.ts";

export type InputEvent = {
  type: 1 | 2 | 3;
  value: number;
  /** Modal raw keys acquire script mappings only if a script consumer reads them. */
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

  enqueueKey(word: number, keymap: ReadonlyMap<number, number>): boolean {
    const key = word & 0xff ? word & 0xff : word & 0xffff;
    const navigation = NAV_KEYS[key];
    if (navigation !== undefined) return this.enqueue({ type: 2, value: navigation });
    const status = keymap.get(key);
    return this.enqueue(
      status === undefined ? { type: 1, value: key } : { type: 3, value: status },
    );
  }

  /**
   * A raw host key delivered while a modal owns the interpreter: keypad
   * Enter/Escape normalize to their twins, navigation words become type-2
   * events, and raw keys mark `mapOnConsume` so a script mapping applies only
   * when a script consumer actually reads the event.
   */
  enqueueModalKey(word: number): boolean {
    const key = normalizeModalKey(word);
    const raw = key & 0xff ? key & 0xff : key & 0xffff;
    const navigation = NAV_KEYS[raw];
    return this.enqueue({
      type: navigation === undefined ? 1 : 2,
      value: navigation ?? raw,
      mapOnConsume: true,
    });
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

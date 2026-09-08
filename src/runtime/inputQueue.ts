/** AGI event queue, clean-room from agi-re "Event queue" and "Raw-key condition". */
export type InputEvent = {
  type: 1 | 2 | 3;
  value: number;
  /** Modal raw keys acquire script mappings only if a script consumer reads them. */
  mapOnConsume?: true;
};

export const NAV_KEYS: Record<number, number> = {
  0x4800: 1,
  0x4900: 2,
  0x4d00: 3,
  0x5100: 4,
  0x5000: 5,
  0x4f00: 6,
  0x4b00: 7,
  0x4700: 8,
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

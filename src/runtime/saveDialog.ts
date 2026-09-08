/** Engine-owned selector from agi-re, "Save selector" and "Save action outcomes". */
import { AGI_KEY } from "./keys.ts";
import { SAVE_DESCRIPTION_BYTES, saveSignatureMatches } from "./persistence.ts";
import { type TextSurface, TEXT_COLS, TEXT_ROWS, attr } from "./textSurface.ts";

// The existing save writer reserves one byte in the header for its NUL terminator.
const DESCRIPTION_LIMIT = SAVE_DESCRIPTION_BYTES - 1;

export interface SaveSlot {
  slot: number;
  bytes: Uint8Array;
}

export interface SaveDialogHost {
  list(): SaveSlot[];
  waitKey(): number;
  describe?(initial: string, maxLen: number, row: number, col: number): string | null;
  write(slot: number, description: string): boolean | void;
  read(slot: number): Uint8Array | null;
}

/**
 * A host-provided storage namespace is the available save directory. Paths and
 * disk operations stay outside the portable interpreter. Selected images retain
 * the authentic description/signature envelope; no app metadata enters them.
 */
export function runSaveDialog(
  mode: "save" | "restore",
  text: TextSurface,
  signature: string,
  host: SaveDialogHost,
): Uint8Array | null {
  const saved = text.save(0, 0, TEXT_ROWS - 1, TEXT_COLS - 1);
  const normal = attr(0, 15);
  const selected = attr(15, 0);
  const signatureBytes = new Uint8Array(7);
  for (let i = 0; i < Math.min(7, signature.length); i++)
    signatureBytes[i] = signature.charCodeAt(i) & 0xff;
  function screen(title: string): void {
    text.fill(0, 0, 24, 39, 32, normal);
    text.write(1, 2, title, normal);
  }
  function accept(): boolean {
    for (;;) {
      const key = host.waitKey();
      if ((key & 0xff) === AGI_KEY.ENTER || key === 0x0101 || key === 0x0301) return true;
      if ((key & 0xff) === AGI_KEY.ESCAPE || key === 0 || key === 0x0201 || key === 0x0401)
        return false;
    }
  }
  function failure(message: string): void {
    screen(message);
    text.write(4, 2, "ENTER or ESC to continue", normal);
    accept();
  }
  try {
    let files: SaveSlot[];
    try {
      files = host.list();
    } catch {
      failure("Unable to read saved games.");
      return null;
    }
    const slots: { slot: number; description: string | null }[] = [];
    for (let slot = 1; slot <= 12; slot++) {
      const file = files.find(
        (candidate) =>
          candidate.slot === slot && saveSignatureMatches(candidate.bytes, signatureBytes),
      );
      if (mode === "restore" && !file) continue;
      let description: string | null = null;
      if (file) {
        description = "";
        for (const byte of file.bytes.subarray(0, SAVE_DESCRIPTION_BYTES)) {
          if (byte === 0) break;
          description += String.fromCharCode(byte);
        }
      }
      slots.push({ slot, description });
    }
    if (slots.length === 0) {
      failure("No saved games for this game.");
      return null;
    }
    let current = 0;
    for (;;) {
      screen(mode === "save" ? "Save game" : "Restore game");
      for (const [index, slot] of slots.entries()) {
        const color = index === current ? selected : normal;
        text.fill(3 + index, 1, 3 + index, 38, 32, color);
        text.write(
          3 + index,
          2,
          `${String(slot.slot).padStart(2)}. ${slot.description ?? "<empty>"}`,
          color,
        );
      }
      text.write(18, 2, "UP/DOWN: select   ENTER: accept", normal);
      text.write(20, 2, "ESC: cancel", normal);
      const key = host.waitKey();
      if (key === 0 || (key & 0xff) === AGI_KEY.ESCAPE || key === 0x0201 || key === 0x0401)
        return null;
      if (key === AGI_KEY.UP) current = (current + slots.length - 1) % slots.length;
      else if (key === AGI_KEY.DOWN) current = (current + 1) % slots.length;
      else if ((key & 0xff) === AGI_KEY.ENTER || key === 0x0101 || key === 0x0301) break;
    }
    const choice = slots[current]!;
    if (mode === "restore") {
      let image: Uint8Array | null;
      try {
        image = host.read(choice.slot);
      } catch {
        image = null;
      }
      if (image === null) failure("Unable to open saved game.");
      return image;
    }
    let description = choice.description;
    if (description === null) {
      screen("Describe this saved game:");
      text.write(6, 2, "ENTER: accept   ESC: cancel", normal);
      if (host.describe) description = host.describe("", DESCRIPTION_LIMIT, 3, 2);
      else {
        description = "";
        for (;;) {
          text.fill(3, 2, 3, 33, 32, normal);
          text.write(3, 2, description, normal);
          const key = host.waitKey();
          const byte = key & 0xff;
          if (byte === AGI_KEY.ENTER || key === 0x0101 || key === 0x0301) break;
          if (key === 0 || byte === AGI_KEY.ESCAPE || key === 0x0201 || key === 0x0401) return null;
          if (byte === AGI_KEY.BACKSPACE) description = description.slice(0, -1);
          else if (byte >= AGI_KEY.SPACE && description.length < DESCRIPTION_LIMIT)
            description += String.fromCharCode(byte);
        }
      }
      if (description === null) return null;
      description = description.slice(0, DESCRIPTION_LIMIT);
    }
    screen(
      choice.description === null
        ? `Save in slot ${choice.slot}?`
        : `Replace saved game ${choice.slot}?`,
    );
    text.write(3, 2, description, normal);
    text.write(6, 2, "ENTER: save   ESC: cancel", normal);
    if (!accept()) return null;
    let success: boolean | void;
    try {
      success = host.write(choice.slot, description);
    } catch {
      success = false;
    }
    if (success === false) failure("Unable to save. Storage may be full.");
    return null;
  } finally {
    text.restore(saved);
  }
}

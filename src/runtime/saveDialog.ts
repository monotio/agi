/**
 * Engine-owned selector from agi-re, "Save selector" and "Save action
 * outcomes". The dialog is a resumable state machine rather than a blocking
 * loop: `stepSaveDialog` runs synchronous work until the dialog needs the
 * host (slot list, a key, a description, a write, a read), reports that need,
 * and resumes when the answer arrives. A synchronous host drives it to
 * completion inside `runSaveDialog`; the worker path suspends the interpreter
 * on each need instead, so application commands keep running while the
 * selector is open.
 */
import { AGI_KEY } from "./keys.ts";
import { SAVE_DESCRIPTION_BYTES, saveSignatureMatches } from "./persistence.ts";
import { type TextSurface, TEXT_COLS, TEXT_ROWS, attr, type SavedRect } from "./textSurface.ts";

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

/** One host service the selector is waiting for. */
export type SaveDialogNeed =
  | { kind: "list" }
  | { kind: "key" }
  | { kind: "describe"; initial: string; maxLen: number; row: number; col: number }
  | { kind: "write"; slot: number; description: string }
  | { kind: "read"; slot: number };

type SaveDialogPhase =
  "list" | "select" | "describe" | "edit" | "confirm" | "write" | "read" | "failure";

/**
 * Live selector state. Every field is plain data except the text surface and
 * the saved cells under it — the suspension a host need causes can outlive
 * the calling bytecode pass, so nothing here may hold a stack position.
 */
export interface SaveDialog {
  mode: "save" | "restore";
  text: TextSurface;
  /** Cells under the dialog, restored when it closes. */
  saved: SavedRect;
  /** Game signature bytes; only matching files are restorable. */
  signature: Uint8Array;
  /** A host-native description prompt exists; otherwise the engine edits on the surface. */
  nativeDescribe: boolean;
  phase: SaveDialogPhase;
  slots: { slot: number; description: string | null }[];
  current: number;
  choice: { slot: number; description: string | null } | null;
  description: string;
  failure: string;
  /** The outstanding host request, or null while the machine has none. */
  need: SaveDialogNeed | null;
  done: boolean;
  /** The restored image for a successful restore; null for save/cancel/failure. */
  image: Uint8Array | null;
}

export function createSaveDialog(
  mode: "save" | "restore",
  text: TextSurface,
  signature: string,
  nativeDescribe: boolean,
): SaveDialog {
  const signatureBytes = new Uint8Array(7);
  for (let i = 0; i < Math.min(7, signature.length); i++)
    signatureBytes[i] = signature.charCodeAt(i) & 0xff;
  return {
    mode,
    text,
    saved: text.save(0, 0, TEXT_ROWS - 1, TEXT_COLS - 1),
    signature: signatureBytes,
    nativeDescribe,
    phase: "list",
    slots: [],
    current: 0,
    choice: null,
    description: "",
    failure: "",
    need: null,
    done: false,
    image: null,
  };
}

export type SaveDialogStep =
  { done: false; need: SaveDialogNeed } | { done: true; image: Uint8Array | null };

/**
 * Drive the selector one step. `answer` resolves the outstanding need; passing
 * `undefined` while a need is outstanding re-emits it unchanged (a suspended
 * wait may resume without its answer, e.g. the key already arrived through
 * the input queue). On completion the covered cells are restored.
 */
export function stepSaveDialog(d: SaveDialog, answer: unknown): SaveDialogStep {
  if (d.done) return { done: true, image: d.image };
  if (d.need !== null) {
    if (answer === undefined) return { done: false, need: d.need };
    const need = d.need;
    d.need = null;
    answerNeed(d, need, answer);
  }
  while (!d.done && d.need === null) d.need = advance(d);
  return d.done ? { done: true, image: d.image } : { done: false, need: d.need! };
}

/** Draw the full-screen dialog title over cleared cells. */
function screen(d: SaveDialog, title: string): void {
  d.text.fill(0, 0, 24, 39, 32, attr(0, 15));
  d.text.write(1, 2, title, attr(0, 15));
}

/** Close the dialog with a result: restore the covered cells and stop. */
function finish(d: SaveDialog, image: Uint8Array | null): void {
  d.done = true;
  d.image = image;
  d.text.restore(d.saved);
}

function fail(d: SaveDialog, message: string): void {
  d.failure = message;
  d.phase = "failure";
}

/**
 * A host-provided storage namespace is the available save directory. Paths and
 * disk operations stay outside the portable interpreter. Selected images retain
 * the authentic description/signature envelope; no app metadata enters them.
 */
function buildSlots(d: SaveDialog, files: SaveSlot[]): void {
  d.slots = [];
  for (let slot = 1; slot <= 12; slot++) {
    const file = files.find(
      (candidate) => candidate.slot === slot && saveSignatureMatches(candidate.bytes, d.signature),
    );
    if (d.mode === "restore" && !file) continue;
    let description: string | null = null;
    if (file) {
      description = "";
      for (const byte of file.bytes.subarray(0, SAVE_DESCRIPTION_BYTES)) {
        if (byte === 0) break;
        description += String.fromCharCode(byte);
      }
    }
    d.slots.push({ slot, description });
  }
}

/**
 * Run the current phase's synchronous work and return the need it ends on.
 * Every phase produces a need or marks the dialog done.
 */
function advance(d: SaveDialog): SaveDialogNeed | null {
  const text = d.text;
  const normal = attr(0, 15);
  const selected = attr(15, 0);
  switch (d.phase) {
    case "list":
      return { kind: "list" };
    case "select": {
      screen(d, d.mode === "save" ? "Save game" : "Restore game");
      for (const [index, slot] of d.slots.entries()) {
        const color = index === d.current ? selected : normal;
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
      return { kind: "key" };
    }
    case "describe":
      return { kind: "describe", initial: "", maxLen: DESCRIPTION_LIMIT, row: 3, col: 2 };
    case "edit": {
      // The engine-drawn editor: repaint the line, then wait for the next key.
      text.fill(3, 2, 3, 33, 32, normal);
      text.write(3, 2, d.description, normal);
      return { kind: "key" };
    }
    case "confirm": {
      const choice = d.choice!;
      screen(
        d,
        choice.description === null
          ? `Save in slot ${choice.slot}?`
          : `Replace saved game ${choice.slot}?`,
      );
      text.write(3, 2, d.description, normal);
      text.write(6, 2, "ENTER: save   ESC: cancel", normal);
      return { kind: "key" };
    }
    case "write":
      return { kind: "write", slot: d.choice!.slot, description: d.description };
    case "read":
      return { kind: "read", slot: d.choice!.slot };
    case "failure":
      screen(d, d.failure);
      text.write(4, 2, "ENTER or ESC to continue", normal);
      return { kind: "key" };
  }
}

/** Consume the answer to `need` and move the machine to its next phase. */
function answerNeed(d: SaveDialog, need: SaveDialogNeed, answer: unknown): void {
  switch (need.kind) {
    case "list": {
      const files = Array.isArray(answer) ? (answer as SaveSlot[]) : null;
      if (files === null) return fail(d, "Unable to read saved games.");
      buildSlots(d, files);
      if (d.slots.length === 0) return fail(d, "No saved games for this game.");
      d.current = 0;
      d.phase = "select";
      return;
    }
    case "key": {
      const key = Number(answer);
      const byte = key & 0xff;
      if (d.phase === "select") {
        if (key === 0 || byte === AGI_KEY.ESCAPE || key === 0x0201 || key === 0x0401)
          return finish(d, null);
        if (key === AGI_KEY.UP) d.current = (d.current + d.slots.length - 1) % d.slots.length;
        else if (key === AGI_KEY.DOWN) d.current = (d.current + 1) % d.slots.length;
        else if (byte === AGI_KEY.ENTER || key === 0x0101 || key === 0x0301) {
          d.choice = d.slots[d.current]!;
          if (d.mode === "restore") {
            d.phase = "read";
          } else if (d.choice.description === null) {
            screen(d, "Describe this saved game:");
            d.text.write(6, 2, "ENTER: accept   ESC: cancel", attr(0, 15));
            d.description = "";
            d.phase = d.nativeDescribe ? "describe" : "edit";
          } else {
            d.description = d.choice.description;
            d.phase = "confirm";
          }
        }
        return;
      }
      if (d.phase === "edit") {
        if (byte === AGI_KEY.ENTER || key === 0x0101 || key === 0x0301) {
          d.description = d.description.slice(0, DESCRIPTION_LIMIT);
          d.phase = "confirm";
          return;
        }
        if (key === 0 || byte === AGI_KEY.ESCAPE || key === 0x0201 || key === 0x0401)
          return finish(d, null);
        if (byte === AGI_KEY.BACKSPACE) d.description = d.description.slice(0, -1);
        else if (byte >= AGI_KEY.SPACE && d.description.length < DESCRIPTION_LIMIT)
          d.description += String.fromCharCode(byte);
        return;
      }
      // confirm and failure share the accept/cancel key contract.
      if (byte === AGI_KEY.ENTER || key === 0x0101 || key === 0x0301) {
        if (d.phase === "confirm") d.phase = "write";
        else finish(d, null);
        return;
      }
      if (key === 0 || byte === AGI_KEY.ESCAPE || key === 0x0201 || key === 0x0401)
        return finish(d, null);
      return;
    }
    case "describe": {
      const value = typeof answer === "string" ? answer : null;
      if (value === null) return finish(d, null);
      d.description = value.slice(0, DESCRIPTION_LIMIT);
      d.phase = "confirm";
      return;
    }
    case "write": {
      if (answer === false) return fail(d, "Unable to save. Storage may be full.");
      return finish(d, null);
    }
    case "read": {
      const image = answer instanceof Uint8Array ? answer : null;
      if (image === null) return fail(d, "Unable to open saved game.");
      return finish(d, image);
    }
  }
}

/**
 * Drive the selector to completion against a synchronous host — the form
 * headless tests and simulation use. The suspended path instead emits each
 * need through the bridge and resumes the machine as answers arrive.
 */
export function runSaveDialog(
  mode: "save" | "restore",
  text: TextSurface,
  signature: string,
  host: SaveDialogHost,
): Uint8Array | null {
  const dialog = createSaveDialog(mode, text, signature, host.describe !== undefined);
  try {
    let answer: unknown;
    for (;;) {
      const step = stepSaveDialog(dialog, answer);
      if (step.done) return step.image;
      const need = step.need;
      switch (need.kind) {
        case "list":
          try {
            answer = host.list();
          } catch {
            answer = null;
          }
          break;
        case "key":
          answer = host.waitKey();
          break;
        case "describe":
          answer = host.describe
            ? host.describe(need.initial, need.maxLen, need.row, need.col)
            : null;
          break;
        case "write":
          try {
            answer = host.write(need.slot, need.description) !== false;
          } catch {
            answer = false;
          }
          break;
        case "read":
          try {
            answer = host.read(need.slot);
          } catch {
            answer = null;
          }
          break;
      }
    }
  } finally {
    // An unwinding host call still restores the cells the dialog covered.
    if (!dialog.done) text.restore(dialog.saved);
  }
}

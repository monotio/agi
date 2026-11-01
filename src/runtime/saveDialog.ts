/**
 * Engine-owned selector from agi-re, "Save selector" and "Save action
 * outcomes". The dialog is a resumable state machine rather than a blocking
 * loop: `stepSaveDialog` runs synchronous work until the dialog needs the
 * host (slot list, a key, a description, a write, a read), reports that need,
 * and resumes when the answer arrives. The interpreter suspends on each need
 * so application commands keep running while the selector is open.
 */
import { AGI_KEY } from "./keys.ts";
import { SAVE_DESCRIPTION_BYTES, saveSignatureMatches } from "./persistence.ts";
import {
  type GadgetFill,
  type TextSurface,
  TEXT_COLS,
  TEXT_ROWS,
  type WindowOverlay,
  attr,
  type SavedRect,
  stampWindow,
  windowLines,
} from "./textSurface.ts";

// The existing save writer reserves one byte in the header for its NUL terminator.
const DESCRIPTION_LIMIT = SAVE_DESCRIPTION_BYTES - 1;

export interface SaveSlot {
  slot: number;
  bytes: Uint8Array;
}

/** One host service the selector is waiting for. */
export type SaveDialogNeed =
  | { kind: "list" }
  | { kind: "key" }
  | { kind: "describe"; initial: string; maxLen: number; row: number; col: number }
  | { kind: "write"; slot: number; description: string }
  | { kind: "read"; slot: number };

type SaveDialogPhase =
  | "list"
  | "select"
  | "describe"
  | "edit"
  | "confirm"
  | "write"
  | "read"
  | "failure"
  /** Amiga: the "There are no games to restore" notice, closed by any key. */
  | "none";

/** A screen rectangle the Amiga dialog answers with a key when clicked (a gadget). */
interface SaveDialogHit {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  key: number;
}

/** Key words the Amiga slot gadgets post: 0x0a00 + slot index, type 0x0a on the original. */
const SAVE_DIALOG_SLOT_KEY = 0x0a00;

export interface SaveDialogPlatform {
  /** "amiga": the original WindowPrint dialogs; "pc": the spec-derived full-screen selector. */
  platform: "pc" | "amiga";
  /** configure.screen picture top, for the Amiga window placement. */
  displayBase: number;
  /** set.game.id, which names the save files the Amiga confirm window shows. */
  gameId: string;
  /** The Amiga input editor's cursor glyph. */
  cursor: number;
  /** The save block that opens with the game signature (2 on the Apple IIgs). */
  signatureBlock?: 1 | 2;
}

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
  platform: SaveDialogPlatform;
  /** The open Amiga window, drawn with the frame and gadgets of the original. */
  window: WindowOverlay | null;
  /** Gadgets of the open Amiga window, hit-tested by the host's clicks. */
  hits: SaveDialogHit[];
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
  platform: SaveDialogPlatform = { platform: "pc", displayBase: 0, gameId: "", cursor: 0x5f },
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
    platform,
    window: null,
    hits: [],
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
  const amiga = d.platform.platform === "amiga";
  if (d.need !== null) {
    if (answer === undefined) return { done: false, need: d.need };
    const need = d.need;
    d.need = null;
    if (amiga) answerAmiga(d, need, answer);
    else answerNeed(d, need, answer);
  }
  while (!d.done && d.need === null) d.need = amiga ? advanceAmiga(d) : advance(d);
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
  closeSaveDialogSurface(d);
}

/** Restore the cells the dialog covered and drop its Amiga window. */
export function closeSaveDialogSurface(d: SaveDialog): void {
  d.text.restore(d.saved);
  if (d.window !== null) {
    d.text.clearWindowOverlay();
    d.window = null;
    d.hits = [];
  }
}

/** The key a click at screen pixel (x, y) answers on the open Amiga window, or null. */
export function saveDialogPointerKey(d: SaveDialog, x: number, y: number): number | null {
  for (const h of d.hits) if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h.key;
  return null;
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
      (candidate) =>
        candidate.slot === slot &&
        saveSignatureMatches(candidate.bytes, d.signature, d.platform.signatureBlock),
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
    case "none":
      // The PC selector reports an empty restore list as a failure screen.
      fail(d, "No saved games for this game.");
      return null;
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

// ---- Amiga: the original dialogs (docs/fidelity.md "Original Amiga save and restore dialogs") ----

const AMIGA_LIST_WIDTH = 34;
const AMIGA_PROMPT_WIDTH = 31;
const AMIGA_CONFIRM_WIDTH = 35;
const AMIGA_NOTICE_WIDTH = 30;
/** Gadget height: the 8 px font plus 4; width: the label plus 8 (F-persistence-05-gadgets). */
const AMIGA_GADGET_HEIGHT = 12;
/** The volume step is answered with the default directory the executables ship. */
const AMIGA_SAVE_DIRECTORY = "save";

/** The file name the original builds: directory, "/" unless it ends in ":" or "/", id, "sg.", slot. */
function amigaSaveFile(d: SaveDialog, slot: number): string {
  const dir = AMIGA_SAVE_DIRECTORY;
  const sep = dir.endsWith(":") || dir.endsWith("/") ? "" : "/";
  return `${dir}${sep}${d.platform.gameId}sg.${slot}`;
}

/**
 * Open a WindowPrint window as h57+0x224 lays it out: the message formatted
 * at `width`, `cols` forced to the width when the caller asks (the volume,
 * slot and describe windows), `rows` forced when given, three rows added
 * for gadget labels, centred like every message window, then the two
 * gadgets of F-persistence-05-gadgets.
 */
function amigaOpenWindow(
  d: SaveDialog,
  message: string,
  width: number,
  options: { rows?: number; forceCols?: boolean; gadgets?: [string, string] } = {},
): WindowOverlay {
  closeSaveDialogSurface(d);
  const lines = windowLines(message, width);
  const cols = options.forceCols ? width : lines.reduce((m, l) => Math.max(m, l.length), 0);
  const rows = (options.rows ?? lines.length) + (options.gadgets ? 3 : 0);
  const textTop = ((19 - rows) >> 1) + 1 + d.platform.displayBase;
  const textLeft = (TEXT_COLS - cols) >> 1;
  const win: WindowOverlay = {
    geometry: "amiga",
    textTop,
    textLeft,
    textRows: rows,
    textCols: cols,
    x0: 8 * textLeft - 10,
    y0: 8 * textTop - 6,
    x1: 8 * (textLeft + cols) + 10,
    y1: 8 * (textTop + rows) + 4,
    seq: 0,
  };
  d.hits = [];
  if (options.gadgets) {
    const [accept, cancel] = options.gadgets;
    const y0 = win.y1 - 5 - AMIGA_GADGET_HEIGHT;
    const y1 = y0 + AMIGA_GADGET_HEIGHT - 1;
    const row = textTop + rows - 1;
    const labelY = { y0: 8 * row, y1: 8 * row + 7 };
    const acceptX0 = win.x0 + 10;
    const cancelX0 = win.x1 - 10 - (8 * cancel.length + 8);
    const cancelCol = textLeft + cols - cancel.length;
    const fills: GadgetFill[] = [
      {
        x0: acceptX0,
        y0,
        x1: acceptX0 + 8 * accept.length + 8 - 1,
        y1,
        pen: 2,
        label: { x0: 8 * textLeft, x1: 8 * (textLeft + accept.length) - 1, ...labelY },
      },
      {
        x0: cancelX0,
        y0,
        x1: cancelX0 + 8 * cancel.length + 8 - 1,
        y1,
        pen: 4,
        label: { x0: 8 * cancelCol, x1: 8 * (cancelCol + cancel.length) - 1, ...labelY },
      },
    ];
    win.gadgets = fills;
    d.hits.push({ x0: fills[0]!.x0, y0, x1: fills[0]!.x1, y1, key: AGI_KEY.ENTER });
    d.hits.push({ x0: fills[1]!.x0, y0, x1: fills[1]!.x1, y1, key: AGI_KEY.ESCAPE });
    stampWindow(d.text, win, lines, attr(0, 15));
    d.text.write(row, textLeft, accept, attr(15, 2));
    d.text.write(row, cancelCol, cancel, attr(15, 4));
  } else {
    stampWindow(d.text, win, lines, attr(0, 15));
  }
  d.window = win;
  return win;
}

/** The slot window: the prompt, a blank row, " - description" per slot, the pointer on the current one. */
function amigaDrawList(d: SaveDialog): void {
  const prompt =
    d.mode === "save"
      ? "Select the slot in which you wish to save the game."
      : "Select the game which you wish to restore.";
  const win = amigaOpenWindow(d, prompt, AMIGA_LIST_WIDTH, {
    rows: d.slots.length + 3,
    forceCols: true,
    gadgets: [" OK ", "Cancel"],
  });
  const first = win.textTop + 3;
  d.slots.forEach((slot, i) => {
    const row = first + i;
    d.text.write(row, win.textLeft, ` - ${slot.description ?? ""}`, attr(0, 15));
    // The original attaches an invisible 240 x 8 gadget three columns in on each line.
    d.hits.push({
      x0: 8 * (win.textLeft + 3),
      y0: 8 * row,
      x1: 8 * (win.textLeft + 3) + 8 * 30 - 1,
      y1: 8 * row + 7,
      key: SAVE_DIALOG_SLOT_KEY + i,
    });
  });
  amigaDrawPointer(d, true);
}

/** The 0xbb pointer glyph on the current slot's line, or the space it replaces. */
function amigaDrawPointer(d: SaveDialog, show: boolean): void {
  const win = d.window!;
  d.text.write(win.textTop + 3 + d.current, win.textLeft, show ? "\u00bb" : " ", attr(0, 15));
}

/** The describe window's input row: the text and cursor in the front pen on the background pen. */
function amigaDrawEdit(d: SaveDialog): void {
  const win = d.window!;
  const row = win.textTop + 3;
  d.text.fill(row, win.textLeft, row, win.textLeft + win.textCols - 1, 0x20, attr(15, 0));
  d.text.write(
    row,
    win.textLeft,
    d.description + String.fromCharCode(d.platform.cursor),
    attr(15, 0),
  );
}

function amigaOpenConfirm(d: SaveDialog): void {
  const choice = d.choice!;
  const text =
    d.mode === "save"
      ? `About to save the game\ndescribed as:\n\n${d.description}\n\nin file:\n${amigaSaveFile(d, choice.slot)}`
      : `About to restore the game\ndescribed as:\n\n${choice.description ?? ""}\n\nfrom file:\n${amigaSaveFile(d, choice.slot)}`;
  amigaOpenWindow(d, text, AMIGA_CONFIRM_WIDTH, {
    gadgets: d.mode === "save" ? ["Save", "Cancel"] : ["Restore", "Cancel"],
  });
}

function advanceAmiga(d: SaveDialog): SaveDialogNeed | null {
  switch (d.phase) {
    case "list":
      return { kind: "list" };
    case "select":
      if (d.window === null) amigaDrawList(d);
      return { kind: "key" };
    case "describe": {
      const win = d.window!;
      return {
        kind: "describe",
        initial: d.description,
        maxLen: DESCRIPTION_LIMIT,
        row: win.textTop + 3,
        col: win.textLeft,
      };
    }
    case "edit":
      amigaDrawEdit(d);
      return { kind: "key" };
    case "confirm":
      if (d.window === null || d.window.textCols === AMIGA_PROMPT_WIDTH) amigaOpenConfirm(d);
      return { kind: "key" };
    case "write":
      return { kind: "write", slot: d.choice!.slot, description: d.description };
    case "read":
      return { kind: "read", slot: d.choice!.slot };
    case "failure":
      amigaOpenWindow(d, d.failure, AMIGA_NOTICE_WIDTH);
      return { kind: "key" };
    case "none":
      amigaOpenWindow(
        d,
        `There are no games to\nrestore in\n\n${AMIGA_SAVE_DIRECTORY}`,
        AMIGA_NOTICE_WIDTH,
      );
      return { kind: "key" };
  }
}

/** Open the describe window over the current description and start editing it. */
function amigaBeginDescribe(d: SaveDialog): void {
  amigaOpenWindow(d, "How would you like to describe this saved game?\n\n", AMIGA_PROMPT_WIDTH, {
    forceCols: true,
    gadgets: [" OK ", "Cancel"],
  });
  d.description = d.choice!.description ?? "";
  d.phase = d.nativeDescribe ? "describe" : "edit";
  if (!d.nativeDescribe) amigaDrawEdit(d);
}

function answerAmiga(d: SaveDialog, need: SaveDialogNeed, answer: unknown): void {
  const isEnter = (key: number) =>
    (key & 0xff) === AGI_KEY.ENTER || key === 0x0101 || key === 0x0301;
  const isEscape = (key: number) =>
    key === 0 || (key & 0xff) === AGI_KEY.ESCAPE || key === 0x0201 || key === 0x0401;
  switch (need.kind) {
    case "list": {
      const files = Array.isArray(answer) ? (answer as SaveSlot[]) : null;
      if (files === null) return fail(d, "Unable to read saved games.");
      buildSlots(d, files);
      if (d.slots.length === 0) {
        d.phase = "none";
        return;
      }
      d.current = 0;
      d.phase = "select";
      return;
    }
    case "key": {
      const key = Number(answer);
      if (d.phase === "select") {
        const n = d.slots.length;
        if (isEscape(key)) return finish(d, null);
        if (key === AGI_KEY.UP || key === AGI_KEY.DOWN) {
          amigaDrawPointer(d, false);
          d.current = (d.current + (key === AGI_KEY.UP ? n - 1 : 1)) % n;
          amigaDrawPointer(d, true);
          return;
        }
        const slotKey = key - SAVE_DIALOG_SLOT_KEY;
        if (slotKey >= 0 && slotKey < n) {
          amigaDrawPointer(d, false);
          d.current = slotKey;
          amigaDrawPointer(d, true);
        } else if (!isEnter(key)) return;
        d.choice = d.slots[d.current]!;
        if (d.mode === "restore") {
          d.phase = "confirm";
          amigaOpenConfirm(d);
        } else amigaBeginDescribe(d);
        return;
      }
      if (d.phase === "edit") {
        if (isEnter(key)) {
          d.description = d.description.slice(0, DESCRIPTION_LIMIT);
          d.phase = "confirm";
          amigaOpenConfirm(d);
          return;
        }
        if (isEscape(key)) return finish(d, null);
        const byte = key & 0xff;
        if (byte === AGI_KEY.BACKSPACE) d.description = d.description.slice(0, -1);
        else if (byte >= AGI_KEY.SPACE && byte < 0x80 && d.description.length < DESCRIPTION_LIMIT)
          d.description += String.fromCharCode(byte);
        return;
      }
      if (d.phase === "confirm") {
        if (isEnter(key)) d.phase = d.mode === "save" ? "write" : "read";
        else if (isEscape(key)) finish(d, null);
        return;
      }
      // The notices close on Enter or Escape, like WaitAcAb.
      if (isEnter(key) || isEscape(key)) finish(d, null);
      return;
    }
    case "describe": {
      const value = typeof answer === "string" ? answer : null;
      if (value === null) return finish(d, null);
      d.description = value.slice(0, DESCRIPTION_LIMIT);
      d.phase = "confirm";
      amigaOpenConfirm(d);
      return;
    }
    case "write":
      if (answer === false) return fail(d, "Unable to save. Storage may be full.");
      return finish(d, null);
    case "read": {
      const image = answer instanceof Uint8Array ? answer : null;
      if (image === null) return fail(d, "Unable to open saved game.");
      return finish(d, image);
    }
  }
}

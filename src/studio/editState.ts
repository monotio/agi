/**
 * Drawing state for Room Studio edits: what the renderer's visual, priority
 * and pen registers hold at a source line, which of them the following lines
 * read before setting, and the source lines that restore them. Behind the
 * state-restoration rule of `editOperations.ts`.
 */

import type { AgiProfile } from "../runtime/profile.ts";
import type { PictureSourceSpan } from "../picture/source.ts";
import { pictureCommandText } from "./pictureDocument.ts";

/** The registers a picture command reads; null is a disabled channel. */
export interface DrawState {
  /** The raw `vis` operand (the renderer uses its low nibble), or null when off. */
  readonly visual: number | null;
  readonly priority: number | null;
  /** The raw pen mode byte. */
  readonly pen: number;
}

export type DrawRegister = keyof DrawState;

export const DRAW_REGISTERS: readonly DrawRegister[] = ["visual", "priority", "pen"];

export type RegisterSet = Record<DrawRegister, boolean>;

/**
 * The state after the first `end` bytes, mirroring the renderer's command
 * loop: it starts with both channels off and pen mode 0, skips bytes below
 * 0xf0 at command boundaries and commands above the profile's vocabulary, and
 * stops at 0xff.
 */
export function drawStateAt(bytes: Uint8Array, end: number, profile: AgiProfile): DrawState {
  let visual: number | null = null;
  let priority: number | null = null;
  let pen = 0;
  let pos = 0;
  while (pos < end) {
    const command = bytes[pos]!;
    pos += 1;
    if (command === 0xff) break;
    if (command < 0xf0 || command > profile.pictureMaxCommand) continue;
    if (command === 0xf1) visual = null;
    else if (command === 0xf3) priority = null;
    else if (command === 0xf0 || command === 0xf2 || command === 0xf9) {
      if (pos >= end) break;
      const operand = bytes[pos]!;
      pos += 1;
      if (command === 0xf0) visual = operand;
      else if (command === 0xf2) priority = operand;
      else pen = profile.patternProfile === "point-2.411" ? 0 : operand;
    }
  }
  return { visual, priority, pen };
}

/** The state before 1-based source `line`: after every byte of the lines above it. */
export function drawStateBeforeLine(
  compiled: { readonly bytes: Uint8Array; readonly spans: readonly PictureSourceSpan[] },
  line: number,
  profile: AgiProfile,
): DrawState {
  let end = 0;
  for (const span of compiled.spans) {
    if (span.line >= line) break;
    end = span.end;
  }
  return drawStateAt(compiled.bytes, end, profile);
}

/** The lower-cased command word of a source line, or "" for a comment or blank line. */
export function commandHead(line: string): string {
  return (pictureCommandText(line).split(/\s+/)[0] ?? "").toLowerCase();
}

const SETS: Readonly<Record<string, DrawRegister>> = {
  vis: "visual",
  visual: "visual",
  pri: "priority",
  priority: "priority",
  pen: "pen",
};

const CHANNELS: readonly DrawRegister[] = ["visual", "priority"];

/** The registers each drawing command reads; any other command word reads all of them. */
const READS: Readonly<Record<string, readonly DrawRegister[]>> = {
  line: CHANNELS,
  polyline: CHANNELS,
  polygon: CHANNELS,
  rect: CHANNELS,
  rel: CHANNELS,
  xcorner: CHANNELS,
  ycorner: CHANNELS,
  fill: CHANNELS,
  plot: DRAW_REGISTERS,
};

/**
 * The registers `lines` read before setting them, in order until `end`.
 * Drawing commands read both channels, `plot` also the pen; `copy`, `raw` and
 * anything else are treated as reading everything, since their effect is not
 * a single command word.
 */
export function registersRead(lines: readonly string[]): RegisterSet {
  const read: RegisterSet = { visual: false, priority: false, pen: false };
  const settled = new Set<DrawRegister>();
  for (const line of lines) {
    const head = commandHead(line);
    if (head === "") continue;
    if (head === "end") break;
    const set = SETS[head];
    if (set !== undefined) {
      settled.add(set);
      continue;
    }
    for (const register of READS[head] ?? DRAW_REGISTERS) {
      if (!settled.has(register)) read[register] = true;
      settled.add(register);
    }
  }
  return read;
}

/** The source line that sets `register` to its value in `state`. */
export function registerLine(
  register: DrawRegister,
  state: DrawState,
  profile: AgiProfile,
): string {
  if (register === "visual") return state.visual === null ? "vis off" : `vis ${state.visual}`;
  if (register === "priority") return state.priority === null ? "pri off" : `pri ${state.priority}`;
  const mode = state.pen;
  if (profile.patternProfile === "point-2.411" || (mode & ~0x37) !== 0) return `pen raw ${mode}`;
  const flags = `${(mode & 0x20) !== 0 ? " stipple" : ""}${(mode & 0x10) !== 0 ? " bypass" : ""}`;
  return `pen ${mode & 0x07}${flags}`;
}

/** The lines that take `actual` to `expected` for the registers in `needed`, in register order. */
export function restoreLines(
  actual: DrawState,
  expected: DrawState,
  needed: RegisterSet,
  profile: AgiProfile,
): string[] {
  return DRAW_REGISTERS.filter(
    (register) => needed[register] && actual[register] !== expected[register],
  ).map((register) => registerLine(register, expected, profile));
}

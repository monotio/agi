/**
 * Frame perception for the authoring agent.
 *
 * The worker keeps a ring of raw frames — visual nibbles, priority plane,
 * text cells — for the last cycles. This module turns those raw frames into
 * the PNG image blocks the agent actually looks at: one frame per image, or a
 * contact sheet of consecutive cycles laid out in a grid so motion is visible.
 *
 * Framework-free, zero dependencies, deterministic: the same frames always
 * produce the same bytes, so the layout is unit-testable against a fake
 * frame source with hand-computed dimensions.
 *
 * WHAT IS COMPOSITED. The engine core cannot draw text: the 8x8 glyph face
 * lives in the app shell (app/src/font8x8.ts) and `src/` may not import it.
 * So a composited frame here is the PICTURE BAND ONLY, positioned exactly
 * where the screen puts it: the 160x168 surface doubled horizontally to 320
 * pixels wide and drawn at text row `picRow` (eight logical rows per text
 * row) inside the authentic 320x200 frame. Text rows are left black and
 * their CONTENT is returned as plain text alongside the image instead, which
 * a language model reads more reliably than a rendered glyph anyway. Every
 * caption says so, so the agent never mistakes black rows for a blank screen.
 */
import { EGA_RGB, encodePngRgb } from "../picture/png.ts";

/** Logical picture surface. */
export const PIC_WIDTH = 160;
export const PIC_HEIGHT = 168;
/** Composed frame, exactly the screen's geometry. */
export const FRAME_WIDTH = 320;
export const FRAME_HEIGHT = 200;
/** Text surface geometry (mirrors src/runtime/textSurface.ts). */
export const TEXT_COLS = 40;
export const TEXT_ROWS = 25;
/** Black gutter between contact-sheet tiles, in pixels. */
export const SHEET_GAP = 4;
/** Widest contact sheet we will build (keeps one image block under ~2 MB). */
export const SHEET_MAX_COLS = 3;
/** Most frames one read_live call may return. */
export const MAX_FRAMES = 9;

/** Which plane of the frame to draw. */
export type FramePlane = "visual" | "priority";

/** One raw frame out of the worker's ring buffer. */
export interface AgentFrame {
  /** Interpreter cycle number this frame was captured after. */
  readonly cycle: number;
  /** 160x168 visual nibbles. */
  readonly visual: Uint8Array;
  /** 160x168 priority/control nibbles. */
  readonly priority: Uint8Array;
  /** Text row at which picture row 0 is presented (configure.screen). */
  readonly picRow: number;
  /** 40x25 [char, attr] cells, when the source captured them. */
  readonly text?: Uint8Array | undefined;
}

export interface FrameRequest {
  /** How many frames to return, newest last. */
  readonly count: number;
  /** Take every Nth cycle (1 = every cycle). */
  readonly stride: number;
}

/**
 * Where composited frames come from. The app injects one backed by the
 * engine worker's ring buffer; tests inject a fake.
 */
export interface FrameSource {
  read(req: FrameRequest): AgentFrame[] | Promise<AgentFrame[]>;
}

/** Live engine state source, injected by the app the same way. */
export interface EngineStateSource {
  objects(): unknown | Promise<unknown>;
  state(): unknown | Promise<unknown>;
}

export interface SheetGrid {
  readonly cols: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Contact-sheet geometry for `n` frames: a near-square grid capped at
 * SHEET_MAX_COLS columns, tiles separated by a SHEET_GAP gutter.
 *
 *   n=1 -> 1x1, 320x200      n=4 -> 2x2, 644x404
 *   n=6 -> 3x2, 968x404      n=9 -> 3x3, 968x608
 */
export function sheetGrid(n: number): SheetGrid {
  const count = Math.max(1, Math.floor(n));
  const cols = Math.min(SHEET_MAX_COLS, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / cols);
  return {
    cols,
    rows,
    width: cols * FRAME_WIDTH + (cols - 1) * SHEET_GAP,
    height: rows * FRAME_HEIGHT + (rows - 1) * SHEET_GAP,
  };
}

/**
 * Draw one frame's picture band into an RGB buffer at (originX, originY).
 * `stride` is the destination image width in pixels.
 */
export function drawFrameInto(
  frame: AgentFrame,
  plane: FramePlane,
  dest: Uint8Array,
  destWidth: number,
  originX: number,
  originY: number,
): void {
  const nibbles = plane === "priority" ? frame.priority : frame.visual;
  const top = frame.picRow * 8;
  for (let py = 0; py < PIC_HEIGHT; py++) {
    const y = top + py;
    if (y < 0 || y >= FRAME_HEIGHT) continue;
    const src = py * PIC_WIDTH;
    let o = ((originY + y) * destWidth + originX) * 3;
    for (let px = 0; px < PIC_WIDTH; px++) {
      const rgb = EGA_RGB[nibbles[src + px]! & 0x0f]!;
      // One logical pixel is two screen pixels wide (authentic 320x200 EGA).
      dest[o] = rgb[0];
      dest[o + 1] = rgb[1];
      dest[o + 2] = rgb[2];
      dest[o + 3] = rgb[0];
      dest[o + 4] = rgb[1];
      dest[o + 5] = rgb[2];
      o += 6;
    }
  }
}

/** Encode a single frame as a 320x200 PNG. */
export function frameToPng(frame: AgentFrame, plane: FramePlane): Uint8Array {
  const rgb = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 3);
  drawFrameInto(frame, plane, rgb, FRAME_WIDTH, 0, 0);
  return encodePngRgb(FRAME_WIDTH, FRAME_HEIGHT, rgb);
}

/** Encode consecutive frames as one row-major contact sheet PNG. */
export function framesToContactSheet(
  frames: readonly AgentFrame[],
  plane: FramePlane,
): { png: Uint8Array; grid: SheetGrid } {
  const grid = sheetGrid(frames.length);
  const rgb = new Uint8Array(grid.width * grid.height * 3);
  for (let i = 0; i < frames.length; i++) {
    const col = i % grid.cols;
    const row = Math.floor(i / grid.cols);
    drawFrameInto(
      frames[i]!,
      plane,
      rgb,
      grid.width,
      col * (FRAME_WIDTH + SHEET_GAP),
      row * (FRAME_HEIGHT + SHEET_GAP),
    );
  }
  return { png: encodePngRgb(grid.width, grid.height, rgb), grid };
}

/** The frame's 40x25 text surface as 25 plain rows (blank cells become spaces). */
export function textRows(frame: AgentFrame): string[] {
  const cells = frame.text;
  if (!cells) return [];
  const rows: string[] = [];
  for (let r = 0; r < TEXT_ROWS; r++) {
    let line = "";
    for (let c = 0; c < TEXT_COLS; c++) {
      const ch = cells[(r * TEXT_COLS + c) * 2] ?? 0;
      line += ch === 0 || ch >= 0x80 ? " " : String.fromCharCode(ch);
    }
    rows.push(line.replace(/\s+$/, ""));
  }
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

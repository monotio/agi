/**
 * Character-cell text surface (spec "Text geometry and surfaces"): 40
 * columns by 25 rows of cells, each cell a character byte and a colour
 * attribute byte (foreground nibble low, background nibble high).
 *
 * The surface is an overlay the engine owns. A character byte of zero means
 * "no text here": the presentation shows the picture through the cell. Every
 * other byte — including a space — is an opaque cell painted with its
 * background colour, which is how clear.lines / clear.text.rect / the
 * alternate text mode cover the picture.
 *
 * Glyph bitmaps are a font input (spec "Font boundary"); the engine deals
 * only in codes. Codes 0x80.. are the box/cursor glyphs this engine's
 * windows use; a font must supply them.
 */

export const TEXT_COLS = 40;
export const TEXT_ROWS = 25;

/** Box-drawing and cursor glyph codes (engine-private code points). */
export const GLYPH_H = 0x80;
export const GLYPH_V = 0x81;
export const GLYPH_TL = 0x82;
export const GLYPH_TR = 0x83;
export const GLYPH_BL = 0x84;
export const GLYPH_BR = 0x85;
export const GLYPH_CURSOR = 0x86;

/** Pack a foreground/background colour pair into one attribute byte. */
export function attr(fg: number, bg: number): number {
  return (fg & 0x0f) | ((bg & 0x0f) << 4);
}

export interface SavedRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  cells: Uint8Array;
}

export class TextSurface {
  /** Row-major cells: [char, attr] per cell, TEXT_COLS * TEXT_ROWS pairs. */
  readonly cells = new Uint8Array(TEXT_COLS * TEXT_ROWS * 2);
  /** Increments on every mutation; presentation layers poll it. */
  dirty = 0;
  /**
   * The interpreters draw text into the same screen as the graphics, so a cel
   * drawn later repaints the pixels under it, text included. This layer keeps
   * text apart from the graphics; `seq` counts writes and `written` stamps
   * every cell with the write that set it, so `coverPicture` can drop exactly
   * the cells a later drawing would have painted over.
   */
  seq = 0;
  readonly written = new Uint32Array(TEXT_COLS * TEXT_ROWS);

  clear(): void {
    this.cells.fill(0);
    this.written.fill(0);
    this.dirty++;
  }

  charAt(row: number, col: number): number {
    return this.cells[(row * TEXT_COLS + col) * 2]!;
  }

  attrAt(row: number, col: number): number {
    return this.cells[(row * TEXT_COLS + col) * 2 + 1]!;
  }

  put(row: number, col: number, ch: number, a: number): void {
    if (row < 0 || row >= TEXT_ROWS || col < 0 || col >= TEXT_COLS) return;
    const at = (row * TEXT_COLS + col) * 2;
    this.cells[at] = ch & 0xff;
    this.cells[at + 1] = a & 0xff;
    this.written[row * TEXT_COLS + col] = ++this.seq;
    this.dirty++;
  }

  /** Write text left to right from (row, col); clips at the right edge. */
  write(row: number, col: number, text: string, a: number): void {
    for (let i = 0; i < text.length; i++) {
      this.put(row, col + i, text.charCodeAt(i), a);
    }
  }

  /** Fill an inclusive cell rectangle with one character and attribute. */
  fill(top: number, left: number, bottom: number, right: number, ch: number, a: number): void {
    const stamp = ++this.seq;
    for (let r = Math.max(0, top); r <= Math.min(TEXT_ROWS - 1, bottom); r++) {
      for (let c = Math.max(0, left); c <= Math.min(TEXT_COLS - 1, right); c++) {
        const at = (r * TEXT_COLS + c) * 2;
        this.cells[at] = ch & 0xff;
        this.cells[at + 1] = a & 0xff;
        this.written[r * TEXT_COLS + c] = stamp;
      }
    }
    this.dirty++;
  }

  /**
   * Drop the cells written after `since` whose area meets the picture-space
   * rectangle (x0..x1, y0..y1), the graphics having been repainted there.
   * Picture row 0 lies on text row `baseRow`; a cell spans 4 by 8 pixels.
   */
  coverPicture(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    baseRow: number,
    since: number,
  ): void {
    const c0 = Math.max(0, Math.floor(x0 / 4));
    const c1 = Math.min(TEXT_COLS - 1, Math.floor(x1 / 4));
    const r0 = Math.max(0, baseRow + Math.floor(y0 / 8));
    const r1 = Math.min(TEXT_ROWS - 1, baseRow + Math.floor(y1 / 8));
    let changed = false;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * TEXT_COLS + c;
        if (this.written[i]! <= since || this.cells[i * 2] === 0) continue;
        this.cells[i * 2] = 0;
        this.cells[i * 2 + 1] = 0;
        this.written[i] = 0;
        changed = true;
      }
    }
    if (changed) this.dirty++;
  }

  /** Copy out an inclusive rectangle so a modal window can restore it later. */
  save(top: number, left: number, bottom: number, right: number): SavedRect {
    const t = Math.max(0, top);
    const l = Math.max(0, left);
    const b = Math.min(TEXT_ROWS - 1, bottom);
    const r = Math.min(TEXT_COLS - 1, right);
    const w = Math.max(0, r - l + 1);
    const h = Math.max(0, b - t + 1);
    const cells = new Uint8Array(w * h * 2);
    for (let y = 0; y < h; y++) {
      const src = ((t + y) * TEXT_COLS + l) * 2;
      cells.set(this.cells.subarray(src, src + w * 2), y * w * 2);
    }
    return { top: t, left: l, bottom: b, right: r, cells };
  }

  restore(saved: SavedRect): void {
    const w = saved.right - saved.left + 1;
    // Restored text is as new as the restore: graphics drawn later cover it.
    const stamp = ++this.seq;
    for (let y = 0; y <= saved.bottom - saved.top; y++) {
      const dst = ((saved.top + y) * TEXT_COLS + saved.left) * 2;
      this.cells.set(saved.cells.subarray(y * w * 2, (y + 1) * w * 2), dst);
      this.written.fill(
        stamp,
        (saved.top + y) * TEXT_COLS + saved.left,
        (saved.top + y) * TEXT_COLS + saved.right + 1,
      );
    }
    this.dirty++;
  }

  /** The row as text; transparent cells read as spaces, glyph codes as '#'. */
  rowText(row: number): string {
    let s = "";
    for (let c = 0; c < TEXT_COLS; c++) {
      const ch = this.charAt(row, c);
      s += ch === 0 ? " " : ch >= 0x80 ? "#" : String.fromCharCode(ch);
    }
    return s;
  }
}

/**
 * Greedy word wrap for modal windows. Explicit newlines start a new line;
 * words longer than the width are split at the width.
 */
export function wrapLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ");
    let line = "";
    for (const word of words) {
      let w = word;
      while (w.length > width) {
        if (line.length > 0) {
          out.push(line);
          line = "";
        }
        out.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (line.length === 0) {
        line = w;
      } else if (line.length + 1 + w.length <= width) {
        line += " " + w;
      } else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

export interface WindowBox {
  top: number;
  left: number;
  /** Total window size in cells including the one-cell border. */
  rows: number;
  cols: number;
}

/**
 * Place a bordered window around `lines`. Without overrides the window is
 * centred vertically in the 21-row display area starting at `displayBase`
 * and horizontally across the 40 columns (spec "Modal text").
 */
export function placeWindow(
  lines: readonly string[],
  displayBase: number,
  override?: { row?: number | undefined; col?: number | undefined },
): WindowBox {
  const textWidth = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const cols = Math.min(TEXT_COLS, textWidth + 2);
  const rows = Math.min(TEXT_ROWS, lines.length + 2);
  let top = override?.row ?? displayBase + Math.floor((21 - rows) / 2);
  let left = override?.col ?? Math.floor((TEXT_COLS - cols) / 2);
  if (top + rows > TEXT_ROWS) top = TEXT_ROWS - rows;
  if (left + cols > TEXT_COLS) left = TEXT_COLS - cols;
  if (top < 0) top = 0;
  if (left < 0) left = 0;
  return { top, left, rows, cols };
}

/** Draw a bordered window with its text; returns nothing, caller saved the rect. */
export function drawWindow(
  surface: TextSurface,
  box: WindowBox,
  lines: readonly string[],
  textAttr: number,
  borderAttr: number,
): void {
  const bottom = box.top + box.rows - 1;
  const right = box.left + box.cols - 1;
  surface.fill(box.top, box.left, bottom, right, 0x20, textAttr);
  for (let c = box.left + 1; c < right; c++) {
    surface.put(box.top, c, GLYPH_H, borderAttr);
    surface.put(bottom, c, GLYPH_H, borderAttr);
  }
  for (let r = box.top + 1; r < bottom; r++) {
    surface.put(r, box.left, GLYPH_V, borderAttr);
    surface.put(r, right, GLYPH_V, borderAttr);
  }
  surface.put(box.top, box.left, GLYPH_TL, borderAttr);
  surface.put(box.top, right, GLYPH_TR, borderAttr);
  surface.put(bottom, box.left, GLYPH_BL, borderAttr);
  surface.put(bottom, right, GLYPH_BR, borderAttr);
  for (let i = 0; i < lines.length && box.top + 1 + i < bottom; i++) {
    surface.write(box.top + 1 + i, box.left + 1, lines[i]!.slice(0, box.cols - 2), textAttr);
  }
}

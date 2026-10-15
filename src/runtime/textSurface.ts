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
 * only in codes. A game's own text bytes are stored as they are, 0x80..0xff
 * included: a translated game prints code-page letters there (0x82 is é on
 * the PC). The box and cursor glyphs this engine's windows use are private
 * control codes 0x01..0x09, which no catalogued message prints
 * (docs/fidelity.md "Text beyond ASCII"); a font must supply them.
 */

export const TEXT_COLS = 40;
export const TEXT_ROWS = 25;

/** Box-drawing and cursor glyph codes (engine-private code points). */
export const GLYPH_TOP = 0x01;
export const GLYPH_BOTTOM = 0x02;
export const GLYPH_LEFT = 0x03;
export const GLYPH_RIGHT = 0x04;
export const GLYPH_TL = 0x05;
export const GLYPH_TR = 0x06;
export const GLYPH_BL = 0x07;
export const GLYPH_BR = 0x08;
export const GLYPH_CURSOR = 0x09;

/**
 * A cell as readable text: a transparent cell is a space, printable ASCII
 * itself, and anything else — the engine's border and cursor glyphs, a game's
 * code-page characters — '#'.
 */
export function cellChar(ch: number): string {
  return ch === 0 ? " " : ch < 0x20 || ch >= 0x80 ? "#" : String.fromCharCode(ch);
}

/** Pack a foreground/background colour pair into one attribute byte. */
export function attr(fg: number, bg: number): number {
  return (fg & 0x0f) | ((bg & 0x0f) << 4);
}

export interface SavedRect {
  /** The saved cells' write stamps, restored with them so their age under sprites survives a window. */
  written: Uint32Array;
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

  /** Drop the given cells (row * TEXT_COLS + col); graphics painted over them for good. */
  dropCells(indices: Iterable<number>): void {
    let changed = false;
    for (const i of indices) {
      if (i < 0 || i >= TEXT_COLS * TEXT_ROWS || this.cells[i * 2] === 0) continue;
      this.cells[i * 2] = 0;
      this.cells[i * 2 + 1] = 0;
      this.written[i] = 0;
      changed = true;
    }
    if (changed) this.dirty++;
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
    if (b < t || r < l) {
      // A verbatim print.at override can place the window fully off-screen:
      // nothing was covered, so the canonical empty rect — in range for the
      // serialized replay contract — restores as a no-op.
      return {
        top: 0,
        left: 1,
        bottom: 0,
        right: 0,
        cells: new Uint8Array(0),
        written: new Uint32Array(0),
      };
    }
    const w = r - l + 1;
    const h = b - t + 1;
    const cells = new Uint8Array(w * h * 2);
    const written = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) {
      const src = ((t + y) * TEXT_COLS + l) * 2;
      cells.set(this.cells.subarray(src, src + w * 2), y * w * 2);
      written.set(
        this.written.subarray((t + y) * TEXT_COLS + l, (t + y) * TEXT_COLS + r + 1),
        y * w,
      );
    }
    return { top: t, left: l, bottom: b, right: r, cells, written };
  }

  restore(saved: SavedRect): void {
    const w = saved.right - saved.left + 1;
    // The canonical empty rect: an off-screen window covered nothing.
    if (w <= 0 || saved.bottom < saved.top) return;
    // The restored text keeps its age: what a sprite hid before the window
    // stays hidden after it, and what lay on top stays on top.
    for (let y = 0; y <= saved.bottom - saved.top; y++) {
      const dst = ((saved.top + y) * TEXT_COLS + saved.left) * 2;
      this.cells.set(saved.cells.subarray(y * w * 2, (y + 1) * w * 2), dst);
      this.written.set(
        saved.written.subarray(y * w, (y + 1) * w),
        (saved.top + y) * TEXT_COLS + saved.left,
      );
    }
    this.dirty++;
  }

  /** The row as text; transparent cells read as spaces, glyph codes as '#'. */
  rowText(row: number): string {
    let s = "";
    for (let c = 0; c < TEXT_COLS; c++) s += cellChar(this.charAt(row, c));
    return s;
  }
}

/**
 * Greedy word wrap for modal windows, as the original's _Print does it (kq1
 * 2.917 / kq3 2.936, wrap block 0x2191): explicit newlines start a new line;
 * when a line is full the LAST space on it is consumed — overwritten by the
 * break and excluded from the line's width — and every space that would lead
 * the continuation line is dropped; a line with no space is hard-split at
 * exactly the width.
 */
export function wrapLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    let stripContinuationSpaces = false;
    for (let i = 0; i < paragraph.length; i++) {
      if (line.length >= width) {
        const space = line.lastIndexOf(" ");
        if (space >= 0) {
          out.push(line.slice(0, space));
          // The break space is consumed; the tail after it holds no spaces.
          line = line.slice(space + 1);
          stripContinuationSpaces = true;
        } else {
          out.push(line.slice(0, width));
          line = line.slice(width);
          stripContinuationSpaces = false;
        }
      }
      const ch = paragraph[i]!;
      if (stripContinuationSpaces && line.length === 0 && ch === " ") continue;
      line += ch;
    }
    out.push(line);
  }
  return out;
}

/**
 * Window text with the original's overlong-content recovery (kq1 2.917
 * 0x1E0C / kq3 2.936): a message formatting to more than winBot−1 (19) lines
 * is REPLACED by the verbose notice quoting its first 20 characters, then
 * re-formatted — the window never silently clips.
 */
export function windowLines(text: string, width: number): string[] {
  const lines = wrapLines(text, width);
  if (lines.length <= 19) return lines;
  return wrapLines(
    `Message too verbose:\n\n"${text.slice(0, 20)}..."\n\nPress ESC to continue.`,
    width,
  );
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
 * and horizontally across the 40 columns (spec "Modal text"). print.at
 * overrides are used VERBATIM — the row relative to the display base — with
 * no clamping into the screen (kq1 2.917 WindowNoWait 0x1E69: the override
 * loads feed the window math unchecked, and picTop is added on both paths).
 */
export function placeWindow(
  lines: readonly string[],
  displayBase: number,
  override?: { row?: number | undefined; col?: number | undefined },
): WindowBox {
  const textWidth = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const cols = Math.min(TEXT_COLS, textWidth + 2);
  const rows = Math.min(TEXT_ROWS, lines.length + 2);
  const top = displayBase + (override?.row ?? Math.floor((21 - rows) / 2));
  const left = override?.col ?? Math.floor((TEXT_COLS - cols) / 2);
  return { top, left, rows, cols };
}

/**
 * Draw a window with its text; returns nothing, caller saved the rect. The
 * original's OpenWndw paints a full-rect fill in the low nibble of the
 * colour word, then four SOLID edge bars one nibble (one logical pixel)
 * wide in the high nibble, inset one pixel from the fill's edge; no corner
 * or edge glyphs exist (kq1 2.917 OpenWndw 0x54C8: five DrawWndw calls on
 * the 0x040F colour word — `mov dl,dh` selects red for the four 1-wide
 * edge rects). On the character-cell surface each edge is a glyph cell whose
 * font mask carries the measured 1-pixel bar: the compositor renders the
 * bar in the frame colour over the fill colour, inset one pixel inside the
 * window edge — never a full character-cell band.
 */
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
    surface.put(box.top, c, GLYPH_TOP, borderAttr);
    surface.put(bottom, c, GLYPH_BOTTOM, borderAttr);
  }
  for (let r = box.top + 1; r < bottom; r++) {
    surface.put(r, box.left, GLYPH_LEFT, borderAttr);
    surface.put(r, right, GLYPH_RIGHT, borderAttr);
  }
  surface.put(box.top, box.left, GLYPH_TL, borderAttr);
  surface.put(box.top, right, GLYPH_TR, borderAttr);
  surface.put(bottom, box.left, GLYPH_BL, borderAttr);
  surface.put(bottom, right, GLYPH_BR, borderAttr);
  for (let i = 0; i < lines.length && box.top + 1 + i < bottom; i++) {
    surface.write(box.top + 1 + i, box.left + 1, lines[i]!.slice(0, box.cols - 2), textAttr);
  }
}

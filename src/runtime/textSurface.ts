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
 * control codes which no catalogued message prints (docs/fidelity.md "Text
 * beyond ASCII"); a font must supply them.
 *
 * The code assignments are a persisted contract: host-image checkpoints
 * (format version 1) store these bytes verbatim and restore them unchanged,
 * so a code once shipped keeps its meaning forever. 0x01..0x07 are the 1.x
 * assignments below; 0x08/0x09 were never assigned (a 1.x checkpoint cannot
 * contain them); the window-frame glyphs added later live at 0x0A upward.
 */

export const TEXT_COLS = 40;
export const TEXT_ROWS = 25;

/**
 * Box-drawing and cursor glyph codes exactly as 1.x checkpoints store them
 * (thin single lines through cell row 3 / column 3; the cursor is the
 * bottom two cell rows solid — see app/src/render/font8x8.ts).
 */
export const GLYPH_H = 0x01;
export const GLYPH_V = 0x02;
export const GLYPH_TL = 0x03;
export const GLYPH_TR = 0x04;
export const GLYPH_BL = 0x05;
export const GLYPH_BR = 0x06;
export const GLYPH_CURSOR = 0x07;

export type WindowFrameGeometry = "pc-2.001" | "pc" | "amiga" | "iigs";

/**
 * A filled gadget of an Amiga confirmation window (docs/fidelity.md
 * F-persistence-05-gadgets): the inclusive fill rectangle, its pen, and the
 * label cells inside it, which draw the glyphs over the pen themselves.
 */
export interface GadgetFill {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly pen: number;
  readonly label: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
}

/**
 * A gadget as the presentation draws it: the inclusive fill rectangle in
 * `pen`, and its label in pen 15 at a pixel position the original chose
 * off the cell grid (Intuition IntuiText LeftEdge 4, TopEdge 2 inside the
 * gadget; docs/fidelity.md F-persistence-05-gadgets).
 */
export interface GadgetLabel {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly pen: number;
  readonly text: string;
  readonly textX: number;
  readonly textY: number;
}

export interface WindowOverlay {
  readonly geometry: WindowFrameGeometry;
  readonly textTop: number;
  readonly textLeft: number;
  readonly textRows: number;
  readonly textCols: number;
  /** Inclusive 320x200 screen-pixel bounds of the window fill. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** Write stamp of the window overlay on `TextSurface`. */
  seq: number;
  /** Frame pixel indices (y * 320 + x) erased since the window opened; omitted when intact. */
  erased?: number[];
  /** Gadget fills inside the text interior; omitted for windows without gadgets. */
  gadgets?: readonly GadgetFill[];
}

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

const OVERLAY_WIDTH = 320;
const OVERLAY_HEIGHT = 200;
export const TITLE_FILL_HEIGHT = 11;
export const TITLE_FILL_PIXELS = OVERLAY_WIDTH * TITLE_FILL_HEIGHT;

export class TextSurface {
  /** Row-major cells: [char, attr] per cell, TEXT_COLS * TEXT_ROWS pairs. */
  readonly cells = new Uint8Array(TEXT_COLS * TEXT_ROWS * 2);
  /**
   * Pixel-resolution window frame overlay (320x200): 0 = transparent,
   * 1..16 = EGA palette index + 1 (16 = white fill, 5 = red border bar).
   */
  readonly overlay = new Uint8Array(OVERLAY_WIDTH * OVERLAY_HEIGHT);
  readonly overlayWritten = new Uint32Array(OVERLAY_WIDTH * OVERLAY_HEIGHT);
  hasOverlay = false;
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
  /**
   * Per-pixel write stamps of the Amiga status.line.off pen-0 RectFill(0, 0, 319, 10)
   * across window rows 0..10 (320 * 11 = 3,520 pixels). Kept apart from
   * `overlay` so closing a window never wipes it; every later picture,
   * priority, sprite, text or window write compares stamps or clears the
   * pixels it paints over.
   */
  readonly titleFill = new Uint32Array(TITLE_FILL_PIXELS);
  hasTitleFill = false;

  clear(): void {
    this.cells.fill(0);
    this.written.fill(0);
    if (this.hasTitleFill) {
      this.titleFill.fill(0);
      this.hasTitleFill = false;
    }
    if (this.hasOverlay) {
      this.overlay.fill(0);
      this.overlayWritten.fill(0);
      this.hasOverlay = false;
    }
    this.dirty++;
  }

  clearWindowOverlay(): void {
    if (!this.hasOverlay) return;
    this.overlay.fill(0);
    this.overlayWritten.fill(0);
    this.hasOverlay = false;
    this.dirty++;
  }

  /** Stamp the Amiga status.line.off pen-0 fill across window rows 0..10 (y = 0..10, x = 0..319). */
  fillTitleBar(): void {
    const stamp = ++this.seq;
    this.titleFill.fill(stamp);
    this.hasTitleFill = true;
    this.cells.fill(0, 0, TEXT_COLS * 2);
    this.written.fill(0, 0, TEXT_COLS);
    if (this.hasOverlay) {
      this.overlay.fill(0, 0, TITLE_FILL_PIXELS);
      this.overlayWritten.fill(0, 0, TITLE_FILL_PIXELS);
    }
    this.dirty++;
  }

  /** Drop any title-fill pixels covered by a full picture blit at `baseRow`. */
  clearPictureTitleFill(baseRow: number): void {
    if (!this.hasTitleFill) return;
    const y0 = Math.max(0, baseRow * 8);
    const y1 = Math.min(TITLE_FILL_HEIGHT, baseRow * 8 + 168);
    if (y0 >= y1) return;
    this.titleFill.fill(0, y0 * OVERLAY_WIDTH, y1 * OVERLAY_WIDTH);
    if (!this.titleFill.some((s) => s !== 0)) this.hasTitleFill = false;
    this.dirty++;
  }

  /** Replace the title-fill stamp array from a host checkpoint. */
  restoreTitleFill(stamps?: Uint32Array): void {
    if (stamps && stamps.some((s) => s !== 0)) {
      this.titleFill.set(stamps);
      this.hasTitleFill = true;
    } else {
      this.titleFill.fill(0);
      this.hasTitleFill = false;
    }
    this.dirty++;
  }

  /**
   * Compose the active window overlay and any uncovered Amiga title-bar fill
   * into `target` (320x200). Returns true when any overlay pixel is active.
   */
  composeOverlay(target: Uint8Array): boolean {
    if (!this.hasOverlay && !this.hasTitleFill) return false;
    if (this.hasOverlay) target.set(this.overlay);
    else target.fill(0);
    if (this.hasTitleFill) {
      for (let y = 0; y < TITLE_FILL_HEIGHT; y++) {
        const row = y >> 3;
        const rowBase = y * OVERLAY_WIDTH;
        const cellRowBase = row * TEXT_COLS;
        for (let col = 0; col < TEXT_COLS; col++) {
          const cell = cellRowBase + col;
          const cellStamp = this.cells[cell * 2] !== 0 ? this.written[cell]! : 0;
          const x0 = rowBase + col * 8;
          for (let dx = 0; dx < 8; dx++) {
            const idx = x0 + dx;
            const fillStamp = this.titleFill[idx]!;
            if (fillStamp === 0 || cellStamp >= fillStamp) continue;
            const winStamp =
              this.hasOverlay && this.overlay[idx] !== 0 ? this.overlayWritten[idx]! : 0;
            if (fillStamp > winStamp) target[idx] = 1;
          }
        }
      }
    }
    return true;
  }

  /** Write stamp of the composed overlay pixel at `idx` (window border or title fill). */
  overlayStampAt(idx: number): number {
    const w = this.overlayWritten[idx]!;
    if (this.hasTitleFill && idx < TITLE_FILL_PIXELS) {
      const f = this.titleFill[idx]!;
      if (f > w) return f;
    }
    return w;
  }

  private clearCellOverlay(row: number, col: number): void {
    const y0 = row * 8;
    const x0 = col * 8;
    for (let dy = 0; dy < 8; dy++) {
      const base = (y0 + dy) * OVERLAY_WIDTH + x0;
      for (let dx = 0; dx < 8; dx++) {
        this.overlay[base + dx] = 0;
        this.overlayWritten[base + dx] = 0;
      }
    }
  }

  private clearCellTitleFillBefore(row: number, col: number, stamp: number): void {
    const y0 = row * 8;
    if (y0 >= TITLE_FILL_HEIGHT) return;
    const y1 = Math.min(TITLE_FILL_HEIGHT, y0 + 8);
    const x0 = col * 8;
    for (let y = y0; y < y1; y++) {
      const base = y * OVERLAY_WIDTH + x0;
      for (let dx = 0; dx < 8; dx++) {
        if (this.titleFill[base + dx]! < stamp) this.titleFill[base + dx] = 0;
      }
    }
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
    if (this.hasOverlay) this.clearCellOverlay(row, col);
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
        if (this.hasOverlay) this.clearCellOverlay(r, c);
      }
    }
    this.dirty++;
  }

  /** Drop the given cells (row * TEXT_COLS + col); graphics painted over them for good. */
  dropCells(indices: Iterable<number>): void {
    let changed = false;
    for (const i of indices) {
      if (i < 0 || i >= TEXT_COLS * TEXT_ROWS) continue;
      if (this.cells[i * 2] === 0) continue;
      const cellStamp = this.written[i]!;
      this.cells[i * 2] = 0;
      this.cells[i * 2 + 1] = 0;
      this.written[i] = 0;
      if (this.hasTitleFill && i < TEXT_COLS * 2) {
        this.clearCellTitleFillBefore((i / TEXT_COLS) | 0, i % TEXT_COLS, cellStamp);
      }
      changed = true;
    }
    if (changed) this.dirty++;
  }

  /** Drop the two 320x200 window-overlay or title-fill pixels covered by a painted 160x168 picture pixel. */
  dropPicturePixelOverlay(pixel: number, baseRow: number): void {
    if (!this.hasOverlay && !this.hasTitleFill) return;
    const oIdx = baseRow * 8 * OVERLAY_WIDTH + pixel * 2;
    let changed = false;
    if (this.hasOverlay && oIdx >= 0 && oIdx + 1 < this.overlay.length) {
      if (this.overlay[oIdx] !== 0) {
        this.overlay[oIdx] = 0;
        this.overlayWritten[oIdx] = 0;
        changed = true;
      }
      if (this.overlay[oIdx + 1] !== 0) {
        this.overlay[oIdx + 1] = 0;
        this.overlayWritten[oIdx + 1] = 0;
        changed = true;
      }
    }
    if (this.hasTitleFill && oIdx >= 0 && oIdx + 1 < TITLE_FILL_PIXELS) {
      if (this.titleFill[oIdx] !== 0) {
        this.titleFill[oIdx] = 0;
        changed = true;
      }
      if (this.titleFill[oIdx + 1] !== 0) {
        this.titleFill[oIdx + 1] = 0;
        changed = true;
      }
    }
    if (changed) this.dirty++;
  }

  /**
   * Drop the cells and window-overlay pixels written after `since` whose area
   * meets the picture-space rectangle (x0..x1, y0..y1), the graphics having
   * been repainted there. Picture row 0 lies on text row `baseRow`; a cell
   * spans 4 by 8 logical pixels.
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
        const cellStamp = this.written[i]!;
        this.cells[i * 2] = 0;
        this.cells[i * 2 + 1] = 0;
        this.written[i] = 0;
        if (this.hasTitleFill && r < 2) this.clearCellTitleFillBefore(r, c, cellStamp);
        changed = true;
      }
    }
    if (this.hasOverlay || this.hasTitleFill) {
      const px0 = Math.max(0, x0 * 2);
      const px1 = Math.min(OVERLAY_WIDTH - 1, x1 * 2 + 1);
      const py0 = Math.max(0, baseRow * 8 + y0);
      const py1 = Math.min(OVERLAY_HEIGHT - 1, baseRow * 8 + y1);
      for (let py = py0; py <= py1; py++) {
        const rowBase = py * OVERLAY_WIDTH;
        for (let px = px0; px <= px1; px++) {
          const idx = rowBase + px;
          if (this.hasOverlay && this.overlayWritten[idx]! > since && this.overlay[idx] !== 0) {
            this.overlay[idx] = 0;
            this.overlayWritten[idx] = 0;
            changed = true;
          }
          if (this.hasTitleFill && idx < TITLE_FILL_PIXELS && this.titleFill[idx]! > since) {
            this.titleFill[idx] = 0;
            changed = true;
          }
        }
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
 * Greedy word wrap for modal windows, verified across all 20 shipped PC, Amiga
 * and IIgs binaries (FormStr wrap block, docs/fidelity.md): explicit newlines
 * start a new line; when a line is full the LAST space on it is consumed —
 * overwritten by the break and excluded from the line's width — and every
 * space that would lead the continuation line is dropped; a line with no space
 * is hard-split at exactly the width.
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
 * Window text formatting, verified across all 20 shipped PC, Amiga and IIgs
 * binaries (WindowNoWait verbose check, docs/fidelity.md): a message
 * formatting to more than winBot−1 lines (18 in PC 2.001, 19 in 2.089+ / Amiga
 * / IIgs) is replaced by the verbose notice quoting its first 20 characters,
 * then re-formatted — the window never silently clips.
 */
export function windowLines(text: string, width: number, maxLines = 19): string[] {
  const lines = wrapLines(text, width);
  if (lines.length <= maxLines) return lines;
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
 * Place a cell-bordered dialog box (used by engine-owned menus and the save
 * selector).
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

/**
 * Draw a cell-bordered dialog box with the 1.x thin-line glyphs 0x01..0x06
 * (used by engine-owned menus and the save selector).
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

/**
 * Compute text origin and screen-space (320x200) fill bounds for a print /
 * print.at / show.obj message window (docs/fidelity.md "Original window and
 * status-line text"):
 * - Centered text origin: topRow = ((winBot - 1 - rows) >> 1) + 1 + displayBase
 *   (winBot = 19 in PC 2.001, 20 in PC 2.089+, Amiga and IIgs),
 *   leftCol = (40 - cols) >> 1.
 * - Override text origin (print.at / print.at.v): topRow = displayBase + row,
 *   leftCol = col verbatim, with no clamping.
 * - Fill bounds:
 *   - PC (all 13 builds) & IIgs: [8*leftCol - 10, 8*(leftCol + cols) + 9] x
 *     [8*topRow - 5, 8*(topRow + rows) + 4]
 *   - Amiga (all 6 builds, inclusive RectFill):
 *     [8*leftCol - 10, 8*(leftCol + cols) + 10] x
 *     [8*topRow - 6, 8*(topRow + rows) + 4]
 */
export function placePrintWindow(
  lines: readonly string[],
  displayBase: number,
  geometry: WindowFrameGeometry = "pc",
  override?: { row?: number | undefined; col?: number | undefined },
): WindowOverlay {
  const textRows = lines.length;
  const textCols = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const winBot = geometry === "pc-2.001" ? 19 : 20;
  const textTop = displayBase + (override?.row ?? ((winBot - 1 - textRows) >> 1) + 1);
  const textLeft = override?.col ?? (TEXT_COLS - textCols) >> 1;
  const x0 = 8 * textLeft - 10;
  const x1 = 8 * (textLeft + textCols) + (geometry === "amiga" ? 10 : 9);
  const y0 = 8 * textTop - (geometry === "amiga" ? 6 : 5);
  const y1 = 8 * (textTop + textRows) + 4;
  return {
    geometry,
    textTop,
    textLeft,
    textRows,
    textCols,
    x0,
    y0,
    x1,
    y1,
    seq: 0,
  };
}

/**
 * Return the flat 320x200 indices of any frame pixels of `win` that have been
 * erased from `surface.overlay` since the window opened, or undefined when the
 * entire frame is intact.
 */
export function captureWindowErased(
  surface: TextSurface,
  win: WindowOverlay,
): number[] | undefined {
  const x0 = Math.max(0, win.x0);
  const x1 = Math.min(OVERLAY_WIDTH - 1, win.x1);
  const y0 = Math.max(0, win.y0);
  const y1 = Math.min(OVERLAY_HEIGHT - 1, win.y1);
  if (x1 < x0 || y1 < y0) return undefined;

  const intX0 = win.textLeft * 8;
  const intX1 = (win.textLeft + win.textCols) * 8 - 1;
  const intY0 = win.textTop * 8;
  const intY1 = (win.textTop + win.textRows) * 8 - 1;

  let erased: number[] | undefined;
  for (let y = y0; y <= y1; y++) {
    const inIntY = y >= intY0 && y <= intY1;
    const rowBase = y * OVERLAY_WIDTH;
    for (let x = x0; x <= x1; x++) {
      if (inIntY && x >= intX0 && x <= intX1) continue;
      const idx = rowBase + x;
      if (surface.overlay[idx] === 0) (erased ??= []).push(idx);
    }
  }
  return erased;
}

/**
 * Stamp the outer margin fill (white, EGA 15 -> 16) and border bars (red,
 * EGA 4 -> 5) of `win` onto `surface.overlay` at `win.seq`, leaving the
 * interior text cells to `surface.cells`. When `preserveNewerCells` is true
 * (checkpoint restore), cells written after `win.seq` and any frame pixels
 * recorded in `win.erased` keep priority over the overlay.
 */
export function stampWindowOverlayOnly(
  surface: TextSurface,
  win: WindowOverlay,
  preserveNewerCells = false,
): void {
  const x0 = Math.max(0, win.x0);
  const x1 = Math.min(OVERLAY_WIDTH - 1, win.x1);
  const y0 = Math.max(0, win.y0);
  const y1 = Math.min(OVERLAY_HEIGHT - 1, win.y1);
  if (x1 < x0 || y1 < y0) return;

  const intX0 = win.textLeft * 8;
  const intX1 = (win.textLeft + win.textCols) * 8 - 1;
  const intY0 = win.textTop * 8;
  const intY1 = (win.textTop + win.textRows) * 8 - 1;

  const isPc = win.geometry === "pc" || win.geometry === "pc-2.001";
  const barTopY = win.y0 + (isPc ? 1 : 2);
  const barBotY = win.y1 - (isPc ? 1 : 2);
  const barLeftX0 = win.x0 + 2;
  const barLeftX1 = win.x0 + (isPc ? 3 : 2);
  const barRightX0 = win.x1 - (isPc ? 3 : 2);
  const barRightX1 = win.x1 - 2;
  const barHorizX0 = win.x0 + 2;
  const barHorizX1 = win.x1 - 2;
  const erased = win.erased && win.erased.length > 0 ? new Set(win.erased) : null;

  let wrote = false;
  for (let y = y0; y <= y1; y++) {
    const row = y >> 3;
    const inIntY = y >= intY0 && y <= intY1;
    const rowBase = y * OVERLAY_WIDTH;
    for (let x = x0; x <= x1; x++) {
      if (inIntY && x >= intX0 && x <= intX1) continue;
      const idx = rowBase + x;
      if (erased?.has(idx)) continue;
      if (preserveNewerCells) {
        const cell = row * TEXT_COLS + (x >> 3);
        if (surface.cells[cell * 2] !== 0 && surface.written[cell]! > win.seq) continue;
      }
      const isHorizBar = (y === barTopY || y === barBotY) && x >= barHorizX0 && x <= barHorizX1;
      const isVertBar =
        y >= barTopY &&
        y <= barBotY &&
        ((x >= barLeftX0 && x <= barLeftX1) || (x >= barRightX0 && x <= barRightX1));
      surface.overlay[idx] = isHorizBar || isVertBar ? 5 : 16;
      surface.overlayWritten[idx] = win.seq;
      wrote = true;
    }
  }
  // Gadget fills sit inside the text interior. The label cells draw their
  // own glyphs over the pen, so the fill skips them, and the cell rows that
  // hang below the fill are painted white so no pen shows outside it.
  for (const g of win.gadgets ?? []) {
    const gy0 = Math.max(0, g.y0);
    const gy1 = Math.min(OVERLAY_HEIGHT - 1, Math.max(g.y1, g.label.y1));
    for (let y = gy0; y <= gy1; y++) {
      const rowBase = y * OVERLAY_WIDTH;
      for (let x = Math.max(0, g.x0); x <= Math.min(OVERLAY_WIDTH - 1, g.x1); x++) {
        const inLabel = x >= g.label.x0 && x <= g.label.x1 && y >= g.label.y0 && y <= g.label.y1;
        const inFill = y <= g.y1;
        if (inFill && inLabel) continue;
        if (!inFill && !inLabel) continue;
        const idx = rowBase + x;
        if (erased?.has(idx)) continue;
        surface.overlay[idx] = inFill ? g.pen + 1 : 16;
        surface.overlayWritten[idx] = win.seq;
        wrote = true;
      }
    }
  }
  if (wrote) {
    surface.hasOverlay = true;
    surface.dirty++;
  }
}

/**
 * Draw a message window: write the interior text cells on the 40x25 grid, then
 * stamp the pixel-exact outer fill and border bars into `surface.overlay`.
 */
export function stampWindow(
  surface: TextSurface,
  win: WindowOverlay,
  lines: readonly string[],
  textAttr: number,
): void {
  if (win.textRows > 0 && win.textCols > 0) {
    surface.fill(
      win.textTop,
      win.textLeft,
      win.textTop + win.textRows - 1,
      win.textLeft + win.textCols - 1,
      0x20,
      textAttr,
    );
    for (let i = 0; i < lines.length && i < win.textRows; i++) {
      surface.write(win.textTop + i, win.textLeft, lines[i]!.slice(0, win.textCols), textAttr);
    }
  } else {
    surface.seq++;
  }
  win.seq = surface.seq;
  stampWindowOverlayOnly(surface, win, false);
}

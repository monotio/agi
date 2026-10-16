/**
 * Frame compositor: the engine's 160x168 visual buffer and 40x25 text
 * surface become one 320x200 RGBA frame, with the profile’s presentation assets. Each
 * text column spans four logical picture pixels and each row spans
 * eight logical rows; the display base row offsets the picture.
 *
 * Both presentation paths draw this same frame: the three.js stage uploads
 * it as a texture, the Canvas2D fallback (and the Playwright pixel probe)
 * putImageData it.
 *
 * The profile's `Appearance` supplies the colours and the font, and on the
 * Amiga the two things its screen draws outside the cell grid: the status
 * line in the screen title bar and the confirmation gadgets' labels
 * (docs/fidelity.md "Amiga screen, font and pointer").
 */
import {
  AMIGA_DEPTH_GADGET_WIDTH,
  AMIGA_TITLE_BAR_HEIGHT,
  AMIGA_TITLE_BAR_ROWS,
  AMIGA_TITLE_TEXT_X,
  AMIGA_TITLE_TEXT_Y,
  PC_APPEARANCE,
  type Appearance,
} from "./appearance.ts";
import {
  GLYPH_CURSOR,
  TEXT_COLS,
  TEXT_ROWS,
  type GadgetLabel,
} from "../../../src/runtime/textSurface.ts";
import {
  INTUITION_BAR_ROWS,
  INTUITION_ITEM_TEXT_X,
  INTUITION_ITEM_TEXT_Y,
  INTUITION_TITLE_TEXT_X,
  INTUITION_TITLE_TEXT_Y,
  type NativeMenuChrome,
} from "../../../src/runtime/nativeMenu.ts";

import { FONT } from "./font8x8.ts";

/** Codes already reported as missing from the font, once per page. */
const reportedGlyphs = new Uint8Array(256);

export const FRAME_WIDTH = 320;
export const FRAME_HEIGHT = 200;
const PIC_WIDTH = 160;
const PIC_HEIGHT = 168;

/**
 * Inspector view modes. "visual" is the game; "priority" shows the priority
 * surface exactly as Sierra's show.pri.screen did (priority values in EGA);
 * "blend" washes a depth ramp over the game with control lines (0-3) hatched
 * hot; "split" is a visual/priority wipe at `splitAt` of the picture width.
 * The exploded layer view is GPU-only (see three/AgiStage.ts).
 */
export type ScreenViewMode = "visual" | "priority" | "blend" | "split";

/**
 * Blend-mode tints: control lines 0-3 read as hot signals, depth bands 4-15
 * run a cool-to-warm ramp so nearer (higher) priority reads brighter.
 */
const PRIORITY_TINTS: readonly [number, number, number][] = [
  [0xff, 0x40, 0x40],
  [0xff, 0xb0, 0x20],
  [0x40, 0xe0, 0x60],
  [0x40, 0xa0, 0xff],
  [0x30, 0x30, 0xb0],
  [0x30, 0x48, 0xc8],
  [0x30, 0x60, 0xd8],
  [0x28, 0x78, 0xe0],
  [0x28, 0x90, 0xe8],
  [0x30, 0xa8, 0xd8],
  [0x48, 0xc0, 0xb8],
  [0x70, 0xd0, 0x90],
  [0xa0, 0xd8, 0x68],
  [0xd0, 0xd0, 0x50],
  [0xf0, 0xb8, 0x40],
  [0xff, 0x90, 0x30],
];

export interface CompositeInput {
  /** 160x168 visual nibbles. */
  visual: Uint8Array;
  /** 160x168 priority nibbles; required by the debug view modes. */
  priority?: Uint8Array | undefined;
  /** Visible sprite ownership, needed by CGA's distinct picture and cel mappings. */
  ownership?: Uint16Array | undefined;
  /** Visible cel pixels without a live owner: add.to.pic stamps and show.obj previews. */
  celPixels?: Uint8Array | undefined;
  /** 40x25 [char, attr] cells; char 0 is transparent. */
  text: Uint8Array;
  /**
   * Optional 320x200 sub-cell window border overlay (`0` = transparent,
   * `1 + palette index` = opaque pixel) painted into the window's outer cells
   * before interior text cells overwrite it.
   */
  windowOverlay?: Uint8Array | undefined;
  /** Text row at which picture row 0 is presented (configure.screen). */
  picRow: number;
  /** Colours, font and platform layout; the PC look when omitted. */
  appearance?: Appearance | undefined;
  /**
   * The Amiga screen title while the status line shows: the Amiga layout
   * draws it as the title bar over rows 0..10, above every text cell.
   */
  statusBar?: string | null | undefined;
  /** Gadgets whose labels sit off the cell grid (the Amiga layout draws them). */
  gadgets?: readonly GadgetLabel[] | undefined;
  /** The open Amiga menu strip and pull-down (the Amiga layout draws them over everything). */
  menu?: NativeMenuChrome | undefined;
}

/** Paint the font's lit pixels of `ch` at a frame position in one colour. */
function drawGlyph(
  out: Uint8ClampedArray | Uint8Array,
  look: Appearance,
  ch: number,
  x0: number,
  y0: number,
  fg: readonly [number, number, number],
): void {
  for (let gy = 0; gy < 8; gy++) {
    const y = y0 + gy;
    if (y < 0 || y >= FRAME_HEIGHT) continue;
    const bits = (ch <= GLYPH_CURSOR ? FONT : look.font)[ch * 8 + gy]!;
    for (let gx = 0; gx < 8; gx++) {
      const x = x0 + gx;
      if (x < 0 || x >= FRAME_WIDTH || !(bits & (0x80 >> gx))) continue;
      const o = (y * FRAME_WIDTH + x) * 4;
      out[o] = fg[0];
      out[o + 1] = fg[1];
      out[o + 2] = fg[2];
      out[o + 3] = 255;
    }
  }
}

/** Fill an inclusive frame rectangle, clipped to the frame. */
function fillRect(
  out: Uint8ClampedArray | Uint8Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: readonly [number, number, number],
): void {
  for (let y = Math.max(0, y0); y <= Math.min(FRAME_HEIGHT - 1, y1); y++) {
    let o = (y * FRAME_WIDTH + Math.max(0, x0)) * 4;
    for (let x = Math.max(0, x0); x <= Math.min(FRAME_WIDTH - 1, x1); x++) {
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
      o += 4;
    }
  }
}

/**
 * The Amiga screen title bar: rows 0..9 in pen 15 with the title's glyphs
 * in pen 0 at (2, 1), the depth gadgets at the right edge and the pen 0
 * line on row 10 (docs/fidelity.md "Amiga screen, font and pointer").
 */
function drawAmigaTitleBar(
  out: Uint8ClampedArray | Uint8Array,
  look: Appearance,
  title: string,
): void {
  fillRect(out, 0, 0, FRAME_WIDTH - 1, AMIGA_TITLE_BAR_ROWS - 1, look.palette[15]!);
  const line = AMIGA_TITLE_BAR_HEIGHT - 1;
  fillRect(out, 0, line, FRAME_WIDTH - 1, line, look.palette[0]!);
  for (let col = 0; col < Math.min(title.length, TEXT_COLS); col++) {
    const ch = title.charCodeAt(col) & 0xff;
    if (ch === 0x20) continue;
    drawGlyph(out, look, ch, AMIGA_TITLE_TEXT_X + col * 8, AMIGA_TITLE_TEXT_Y, look.palette[0]!);
  }
  const gadgets = look.titleGadgets;
  if (!gadgets) return;
  const gx0 = FRAME_WIDTH - 2 * AMIGA_DEPTH_GADGET_WIDTH;
  for (let y = 0; y < AMIGA_TITLE_BAR_ROWS; y++) {
    let o = (y * FRAME_WIDTH + gx0) * 4;
    for (let x = 0; x < 2 * AMIGA_DEPTH_GADGET_WIDTH; x++) {
      const c = look.palette[gadgets[y * 2 * AMIGA_DEPTH_GADGET_WIDTH + x]!]!;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
      o += 4;
    }
  }
}

/** Draw a glyph run in one colour at a pixel position. */
function drawText(
  out: Uint8ClampedArray | Uint8Array,
  look: Appearance,
  text: string,
  x: number,
  y: number,
  fg: readonly [number, number, number],
): void {
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i) & 0xff;
    if (ch !== 0x20) drawGlyph(out, look, ch, x + 8 * i, y, fg);
  }
}

/**
 * The Intuition menu strip Kickstart 1.3 draws while the right button is
 * held (docs/fidelity.md "Original Amiga menu strip and pull-downs"): the
 * bar in the block pen over the title bar's rows with the detail-pen line
 * under it, titles two pixels in and one row down, the active title's box
 * complemented, and the pull-down with a one-pixel top and bottom line,
 * two-pixel sides, item text four pixels in and one row down inside each
 * select box, the highlighted box complemented, and ghosted items erased
 * through Intuition's 0x4444/0x1111 pattern.
 */
function drawIntuitionMenu(
  out: Uint8ClampedArray | Uint8Array,
  look: Appearance,
  menu: NativeMenuChrome,
): void {
  const pen0 = look.palette[0]!;
  const pen15 = look.palette[15]!;
  fillRect(out, 0, 0, FRAME_WIDTH - 1, INTUITION_BAR_ROWS - 1, pen15);
  fillRect(out, 0, INTUITION_BAR_ROWS, FRAME_WIDTH - 1, INTUITION_BAR_ROWS, pen0);
  for (const t of menu.titles) {
    if (t.highlighted) fillRect(out, t.left + 1, 0, t.left + t.width, 8, pen0);
    drawText(
      out,
      look,
      t.text,
      t.left + INTUITION_TITLE_TEXT_X,
      INTUITION_TITLE_TEXT_Y,
      t.highlighted ? pen15 : pen0,
    );
  }
  const p = menu.pulldown;
  if (!p) return;
  fillRect(out, p.x0, p.y0, p.x1, p.y1, pen0);
  fillRect(out, p.x0 + 2, p.y0 + 1, p.x1 - 2, p.y1 - 1, pen15);
  p.items.forEach((it, i) => {
    const highlighted = i === p.highlighted;
    if (highlighted) fillRect(out, it.x0, it.y0, it.x1, it.y1, pen0);
    drawText(
      out,
      look,
      it.text,
      it.x0 + INTUITION_ITEM_TEXT_X,
      it.y0 + INTUITION_ITEM_TEXT_Y,
      highlighted ? pen15 : pen0,
    );
    if (it.enabled) return;
    for (let y = it.y0; y <= it.y1; y++) {
      // The pattern is aligned to the screen, not the item: pattern row
      // 0x4444 on even rows erases x % 4 == 3, 0x1111 on odd rows x % 4 == 1.
      const phase = (y & 1) === 1 ? 1 : 3;
      for (let x = it.x0 + ((((phase - it.x0) % 4) + 4) % 4); x <= it.x1; x += 4) {
        if (x < 0 || x >= FRAME_WIDTH || y < 0 || y >= FRAME_HEIGHT) continue;
        const o = (y * FRAME_WIDTH + x) * 4;
        out[o] = pen15[0];
        out[o + 1] = pen15[1];
        out[o + 2] = pen15[2];
      }
    }
  });
}

/**
 * Fill `out` (320*200*4 bytes) with the composed frame. `text` selects how
 * the text surface participates: "compose" (default) merges cells over the
 * picture; "skip" leaves the picture only (the exploded GPU view, which draws
 * text on its own front plane so dialogs don't smear across depth layers);
 * "only" renders just text cells — glyph pixels opaque, everything else
 * transparent — for that front plane's texture.
 */
export function compositeFrame(
  input: CompositeInput,
  out: Uint8ClampedArray | Uint8Array,
  mode: ScreenViewMode = "visual",
  splitAt = 0.5,
  text: "compose" | "skip" | "only" = "compose",
): void {
  const look = input.appearance ?? PC_APPEARANCE;
  const palette = look.palette;
  const background = text === "only" ? undefined : look.background;
  if (background) {
    for (let o = 0; o < out.length; o += 4) {
      out[o] = background[0];
      out[o + 1] = background[1];
      out[o + 2] = background[2];
      out[o + 3] = 255;
    }
  } else out.fill(0);
  const priority = mode === "visual" ? undefined : input.priority;
  const splitX = Math.round(Math.min(Math.max(splitAt, 0), 1) * PIC_WIDTH);
  // Picture band: each logical pixel doubled horizontally.
  const top = input.picRow * 8;
  for (let py = 0; text !== "only" && py < PIC_HEIGHT; py++) {
    const y = top + py;
    if (y < 0 || y >= FRAME_HEIGHT) continue;
    const src = py * PIC_WIDTH;
    let o = y * FRAME_WIDTH * 4;
    for (let px = 0; px < PIC_WIDTH; px++) {
      const i = src + px;
      const colour =
        mode === "priority" || (mode === "split" && px > splitX)
          ? (priority?.[i] ?? 15) & 0x0f
          : input.visual[i]! & 0x0f;
      const pair = (
        (input.celPixels?.[i] || input.ownership?.[i]) &&
        mode !== "priority" &&
        !(mode === "split" && px > splitX)
          ? look.spritePairs
          : y & 1
            ? (look.alternatePicturePairs ?? look.picturePairs)
            : look.picturePairs
      )?.[colour];
      let [r, g, b] = pair?.[0] ?? palette[colour]!;
      let rr = pair?.[1][0] ?? r;
      let rg = pair?.[1][1] ?? g;
      let rb = pair?.[1][2] ?? b;
      if (mode === "split" && (px === splitX || px === splitX + 1)) {
        r = g = b = rr = rg = rb = 0xff;
      } else if (mode === "blend") {
        const pri = (priority?.[i] ?? 15) & 0x0f;
        const [tr, tg, tb] = PRIORITY_TINTS[pri]!;
        // Control lines get a parity hatch on top of a stronger wash.
        const a = pri <= 3 ? 0.55 + (((px + py) & 1) === 0 ? 0.25 : 0) : 0.34;
        r = Math.round(r * (1 - a) + tr * a);
        g = Math.round(g * (1 - a) + tg * a);
        b = Math.round(b * (1 - a) + tb * a);
        rr = Math.round(rr * (1 - a) + tr * a);
        rg = Math.round(rg * (1 - a) + tg * a);
        rb = Math.round(rb * (1 - a) + tb * a);
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
      out[o + 4] = rr;
      out[o + 5] = rg;
      out[o + 6] = rb;
      out[o + 7] = 255;
      o += 8;
    }
  }
  if (text === "skip") return;
  // Opaque text cells on top. In "only" mode the picture stayed transparent,
  // so written cells (window backgrounds included) are the sole opaque pixels.
  const title = look.layout === "amiga" ? (input.statusBar ?? null) : null;
  const overlay = input.windowOverlay;
  for (let row = 0; row < TEXT_ROWS; row++) {
    for (let col = 0; col < TEXT_COLS; col++) {
      const at = (row * TEXT_COLS + col) * 2;
      const ch = input.text[at]!;
      if (ch === 0) continue;
      if (!look.hasGlyph[ch] && !reportedGlyphs[ch]) {
        // A translated or fan game can print codes past ASCII; say so
        // rather than leave a silent blank.
        reportedGlyphs[ch] = 1;
        console.warn(
          `Game text uses character 0x${ch.toString(16).padStart(2, "0")}, which the 8×8 font does not draw; it shows as a blank cell.`,
        );
      }
      const a = input.text[at + 1]!;
      // A nonzero background becomes attribute 0x8f: the driver draws a
      // bit-inverted glyph in colour 3 (docs/fidelity.md "PC fonts and
      // display adapters"), so strokes take the background colour.
      const inverse = look.cgaRgb && a >> 4 !== 0;
      const fg = palette[inverse ? 0 : a & 0x0f]!;
      const bg = palette[inverse ? 15 : (a >> 4) & 0x0f]!;
      for (let gy = 0; gy < 8; gy++) {
        const bits = (ch <= GLYPH_CURSOR ? FONT : look.font)[ch * 8 + gy]!;
        let px = (row * 8 + gy) * FRAME_WIDTH + col * 8;
        let o = px * 4;
        for (let gx = 0; gx < 8; gx++, px++, o += 4) {
          if (overlay && overlay[px] !== 0) continue;
          const c = bits & (0x80 >> gx) ? fg : bg;
          out[o] = c[0];
          out[o + 1] = c[1];
          out[o + 2] = c[2];
          out[o + 3] = 255;
        }
      }
    }
  }
  // Sub-cell window border overlay painted into the window's outer margin
  // (excluding interior text cells and any cells written after the window).
  if (overlay) {
    for (let i = 0; i < FRAME_WIDTH * FRAME_HEIGHT; i++) {
      const v = overlay[i]!;
      if (v === 0 || v > 16) continue;
      const c = palette[(v - 1) & 0x0f]!;
      const o = i * 4;
      out[o] = c[0];
      out[o + 1] = c[1];
      out[o + 2] = c[2];
      out[o + 3] = 255;
    }
  }
  // Gadgets are filled rectangles whose labels sit where the original put
  // them, off the cell grid; the label cells underneath are covered.
  if (look.layout === "amiga" && input.gadgets) {
    for (const g of input.gadgets) {
      fillRect(out, g.x0, g.y0, g.x1, g.y1, palette[g.pen & 0x0f]!);
      for (let i = 0; i < g.text.length; i++)
        drawGlyph(out, look, g.text.charCodeAt(i) & 0xff, g.textX + 8 * i, g.textY, palette[15]!);
    }
  }
  // The screen title bar lies over everything in the window, text included;
  // an open menu strip replaces it.
  if (look.layout === "amiga" && input.menu) drawIntuitionMenu(out, look, input.menu);
  else if (title !== null) drawAmigaTitleBar(out, look, title);
}

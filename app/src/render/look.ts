/**
 * The shape of a platform look and the Amiga title bar's geometry, shared by
 * the compositor, the built-in PC look and the on-demand Amiga look
 * (docs/fidelity.md "Amiga screen, font and pointer").
 */
import type { Presentation } from "../../../src/runtime/profile.ts";

export interface Appearance {
  /** AGI colours 0..15 as RGB. */
  readonly palette: readonly [number, number, number][];
  /** Packed 8×8 glyph rows, `font[code * 8 + row]`, bit 7 leftmost. */
  readonly font: Uint8Array;
  /** 1 for each code the font draws. */
  readonly hasGlyph: Uint8Array;
  /** Platform layout: where the status line and gadget labels go. */
  readonly layout: Presentation;
  /**
   * Pens of the screen title bar's depth gadgets, `AMIGA_TITLE_BAR_ROWS`
   * rows of `2 × AMIGA_DEPTH_GADGET_WIDTH`; present on the Amiga layout.
   */
  readonly titleGadgets?: Uint8Array;
}

/**
 * Amiga screen title bar (docs/fidelity.md "Amiga screen, font and
 * pointer"): the interpreter's status line is the Intuition screen title,
 * which Kickstart 1.3 draws as ten rows of the screen's block pen (15)
 * with the text one row down and two pixels in, a bottom line in the
 * detail pen (0), and the two screen depth gadgets at the right edge.
 */
export const AMIGA_TITLE_BAR_ROWS = 10;
/** Rows 0..10 belong to the bar: the bottom line is row 10. */
export const AMIGA_TITLE_BAR_HEIGHT = 11;
export const AMIGA_TITLE_TEXT_X = 2;
export const AMIGA_TITLE_TEXT_Y = 1;
/** Width of each depth gadget; the pair ends at the right screen edge. */
export const AMIGA_DEPTH_GADGET_WIDTH = 17;

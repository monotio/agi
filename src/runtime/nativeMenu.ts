/**
 * The Amiga interpreters' Intuition menu strip, as the six builds construct
 * it from set.menu / set.menu.item and as Kickstart 1.3 draws it while the
 * right mouse button is held (docs/fidelity.md "Original Amiga menu strip
 * and pull-downs"). Geometry only: the engine owns the state, the host
 * paints the described chrome.
 *
 * Measurements are in 320x200 screen pixels, rectangles inclusive.
 */

export interface NativeMenuItemDef {
  text: string;
  enabled: boolean;
}

export interface NativeMenuHeadingDef {
  title: string;
  items: readonly NativeMenuItemDef[];
}

export interface IntuitionTitle {
  text: string;
  /** Menu.LeftEdge: the sum of the earlier titles' widths. */
  left: number;
  /** Menu.Width: 8 x (len + 1). */
  width: number;
}

export interface IntuitionItem {
  text: string;
  enabled: boolean;
  /** The select box Intuition complements for the highlighted item. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface IntuitionPulldown {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  items: IntuitionItem[];
}

/** What the host paints: the strip over the title bar and the open pull-down. */
export interface NativeMenuChrome {
  titles: (IntuitionTitle & { highlighted: boolean })[];
  pulldown: (IntuitionPulldown & { highlighted: number | null }) | null;
}

const SCREEN_WIDTH = 320;
const FONT_WIDTH = 8;
const FONT_HEIGHT = 8;
/** Menu.Height and MenuItem.Height: the font height plus one. */
const ITEM_HEIGHT = FONT_HEIGHT + 1;
/** Rows 0..9 of the strip are the block pen, like the screen title bar. */
export const INTUITION_BAR_ROWS = 10;
/** The pull-down box starts on the strip's last row. */
const PULLDOWN_TOP = INTUITION_BAR_ROWS - 1;
/** Title text sits two pixels in and one row down, like the screen title. */
export const INTUITION_TITLE_TEXT_X = 2;
export const INTUITION_TITLE_TEXT_Y = 1;
/** Item text: IntuiText LeftEdge 4, TopEdge 1 inside the select box. */
export const INTUITION_ITEM_TEXT_X = 4;
export const INTUITION_ITEM_TEXT_Y = 1;
/** The select boxes sit four pixels inside the pull-down box. */
const PULLDOWN_INSET = 4;

export function intuitionTitles(headings: readonly NativeMenuHeadingDef[]): IntuitionTitle[] {
  const out: IntuitionTitle[] = [];
  let left = 0;
  for (const h of headings) {
    const width = FONT_WIDTH * (h.title.length + 1);
    out.push({ text: h.title, left, width });
    left += width;
  }
  return out;
}

/**
 * The pull-down of one heading. Item widths are 8 x len + 8; the first
 * item decides the shared LeftEdge: zero unless the title's LeftEdge plus
 * that width reaches the screen's right edge, when every item starts at
 * Menu.Width - itemWidth instead (h221+0x19c..0x1be). The box wraps the
 * select boxes with four pixels on each side and stays on screen.
 */
export function intuitionPulldown(
  headings: readonly NativeMenuHeadingDef[],
  heading: number,
): IntuitionPulldown | null {
  const def = headings[heading];
  if (!def || def.items.length === 0) return null;
  const titles = intuitionTitles(headings);
  const title = titles[heading]!;
  const widths = def.items.map((it) => FONT_WIDTH * it.text.length + FONT_WIDTH);
  const itemsLeft = title.left + widths[0]! >= SCREEN_WIDTH ? title.width - widths[0]! : 0;
  const boxWidth = Math.max(...widths) + 2 * PULLDOWN_INSET;
  const boxHeight = ITEM_HEIGHT * def.items.length + 2 * PULLDOWN_INSET;
  const x0 = Math.max(0, Math.min(SCREEN_WIDTH - boxWidth, title.left + itemsLeft - 2));
  const y0 = PULLDOWN_TOP;
  const items = def.items.map((it, i) => ({
    text: it.text,
    enabled: it.enabled,
    x0: x0 + PULLDOWN_INSET,
    y0: y0 + PULLDOWN_INSET + ITEM_HEIGHT * i,
    x1: x0 + PULLDOWN_INSET + widths[i]! - 1,
    y1: y0 + PULLDOWN_INSET + ITEM_HEIGHT * i + ITEM_HEIGHT - 1,
  }));
  return { x0, y0, x1: x0 + boxWidth - 1, y1: y0 + boxHeight - 1, items };
}

/** The title whose strip zone holds the pointer, or null. */
export function intuitionTitleAt(
  titles: readonly IntuitionTitle[],
  x: number,
  y: number,
): number | null {
  if (y < 0 || y >= INTUITION_BAR_ROWS) return null;
  const i = titles.findIndex((t) => x >= t.left && x < t.left + t.width);
  return i < 0 ? null : i;
}

/** The enabled item whose select box holds the pointer, or null. */
export function intuitionItemAt(
  pulldown: IntuitionPulldown | null,
  x: number,
  y: number,
): number | null {
  if (!pulldown) return null;
  const i = pulldown.items.findIndex(
    (it) => it.enabled && x >= it.x0 && x <= it.x1 && y >= it.y0 && y <= it.y1,
  );
  return i < 0 ? null : i;
}

/** The chrome for a strip with `heading` open and `item` highlighted. */
export function intuitionMenuChrome(
  headings: readonly NativeMenuHeadingDef[],
  heading: number | null,
  item: number | null,
): NativeMenuChrome {
  const titles = intuitionTitles(headings).map((t, i) => ({ ...t, highlighted: i === heading }));
  const pulldown = heading === null ? null : intuitionPulldown(headings, heading);
  return {
    titles,
    pulldown:
      pulldown === null
        ? null
        : {
            ...pulldown,
            highlighted: item !== null && pulldown.items[item]?.enabled === true ? item : null,
          },
  };
}

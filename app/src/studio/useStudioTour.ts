/**
 * The Studios' first-run tour: three short marks per Studio, each beside a
 * piece of chrome it names (StudioTour.vue places them). A Studio offers its
 * tour once per viewer on open, and stays silent while a lesson's "Try this"
 * card is on screen; the key sheet's Tour button and the card's
 * "30-second tour" link start it by hand. Skip, Esc and Done mark the Studio
 * seen, except during a lesson, so a viewer who met a Studio through a lesson
 * still gets the tour on their first free visit.
 *
 * The record is `{ version: 1, seen: ["room", "sprite"] }` under
 * `monotio_agi.studioTour`. A record this build cannot read (another version,
 * or not a record at all) reads as nothing seen and is left as it is; blocked
 * storage (a private window) just shows the tour again.
 */
import { computed, shallowRef } from "vue";

export type StudioTourName = "room" | "sprite";

export interface TourMark {
  readonly title: string;
  /** One line of text. */
  readonly body: string;
  /** The test ids of the chrome this mark rings. */
  readonly anchors: readonly string[];
  /** Which anchor the mark sits beside. */
  readonly place: string;
  /** The side of `place` it tries first. */
  readonly side: TourSide;
}

export type TourSide = "below" | "above" | "right" | "left";

export const STUDIO_TOUR_KEY = "monotio_agi.studioTour";

const KEEP_MARK: TourMark = {
  title: "Keep",
  body: "Keep puts your changes in the game. Undo works before and after.",
  anchors: ["studio-keep"],
  place: "studio-keep",
  side: "below",
};

export const STUDIO_TOURS: Record<StudioTourName, readonly TourMark[]> = {
  room: [
    {
      title: "Lenses",
      body: "Art is what the player sees. Depth says what stands in front. Walk says where the hero can go. Press 1, 2, 3.",
      anchors: ["studio-lens"],
      place: "studio-lens",
      side: "below",
    },
    {
      title: "Items",
      body: "Click a name to select it. Drag the slider under the canvas to watch the picture paint itself.",
      anchors: ["studio-scene", "studio-scrubber"],
      place: "studio-scrubber",
      // Over the Scene list's foot, between the two things it names.
      side: "left",
    },
    KEEP_MARK,
  ],
  sprite: [
    {
      title: "Loops and cels",
      body: "One loop per direction, one cel per frame. Click a cel to draw on it.",
      anchors: ["sprite-timeline"],
      place: "sprite-timeline",
      side: "right",
    },
    {
      title: "See-through",
      body: "Pixels in ∅ show the room behind the character. The eraser paints it.",
      // The whole palette, so the mark leaves the ∅ swatch in view.
      anchors: ["sprite-palette"],
      place: "sprite-palette",
      side: "below",
    },
    {
      ...KEEP_MARK,
      body: "Keep saves the character into every room that uses it. Undo works before and after.",
    },
  ],
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const defaultStorage = (): StorageLike | undefined =>
  typeof localStorage === "undefined" ? undefined : localStorage;

/** The Studios a version-1 record lists; null when the record is not one this build may rewrite. */
function readSeen(storage: StorageLike | undefined): string[] | null {
  let raw: string | null;
  try {
    raw = storage?.getItem(STUDIO_TOUR_KEY) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return [];
  try {
    const record = JSON.parse(raw) as unknown;
    if (!record || typeof record !== "object") return null;
    const { version, seen } = record as Record<string, unknown>;
    if (version !== 1 || !Array.isArray(seen)) return null;
    return seen.filter((name): name is string => typeof name === "string");
  } catch {
    return null;
  }
}

/** The Studios whose tour this viewer has seen. */
export function readToursSeen(storage: StorageLike | undefined): ReadonlySet<string> {
  return new Set(readSeen(storage) ?? []);
}

function markSeen(studio: StudioTourName, storage: StorageLike | undefined): void {
  const seen = readSeen(storage);
  if (seen === null || seen.includes(studio)) return;
  try {
    storage?.setItem(STUDIO_TOUR_KEY, JSON.stringify({ version: 1, seen: [...seen, studio] }));
  } catch {
    /* the tour shows again next time */
  }
}

export function useStudioTour(
  studio: StudioTourName,
  options: {
    /** A lesson's card is open: the tour stays silent and never marks itself seen. */
    readonly lesson: () => boolean;
    readonly storage?: StorageLike | undefined;
  },
) {
  const storage = "storage" in options ? options.storage : defaultStorage();
  const marks = STUDIO_TOURS[studio];
  /** The mark on screen, by index; null while the tour is closed. */
  const step = shallowRef<number | null>(null);
  const mark = computed(() => (step.value === null ? null : (marks[step.value] ?? null)));
  const last = computed(() => step.value === marks.length - 1);

  /** On open: show the tour if this viewer has not seen it and no lesson is on screen. */
  function offer(): boolean {
    if (options.lesson() || readToursSeen(storage).has(studio)) return false;
    step.value = 0;
    return true;
  }
  /** From the key sheet or the lesson card: always from the first mark. */
  function start(): void {
    step.value = 0;
  }
  /** Skip, Esc or Done. */
  function end(): void {
    if (step.value === null) return;
    step.value = null;
    if (!options.lesson()) markSeen(studio, storage);
  }
  /** Next; on the last mark, Done. */
  function next(): void {
    if (step.value === null) return;
    if (last.value) end();
    else step.value += 1;
  }

  return { marks, step, mark, last, offer, start, next, end };
}

export type StudioTour = ReturnType<typeof useStudioTour>;

/** A rectangle in page pixels. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface MarkPlacement {
  readonly left: number;
  readonly top: number;
  readonly side: TourSide;
  /** Where the caret points along the edge that faces the anchor; null when the mark sits apart from it. */
  readonly caret: number | null;
}

const SIDES: readonly TourSide[] = ["below", "above", "right", "left"];
const GAP = 10;
/** How far the caret keeps from the mark's corners. */
const CARET_INSET = 16;

const overlap = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

interface Candidate extends MarkPlacement {
  readonly box: Box;
  /** It shares a span with its anchor, so the caret can point at it. */
  readonly near: boolean;
}

/** Every spot beside `anchor` that fits `bounds`, including ones slid clear of `avoid`. */
function candidates(
  anchor: Box,
  width: number,
  height: number,
  bounds: Box,
  order: readonly TourSide[],
  avoid: readonly Box[],
): Candidate[] {
  const found: Candidate[] = [];
  for (const side of order) {
    const across = side === "below" || side === "above";
    const fixed =
      side === "below"
        ? anchor.bottom + GAP
        : side === "above"
          ? anchor.top - GAP - height
          : side === "right"
            ? anchor.right + GAP
            : anchor.left - GAP - width;
    const [fixedMin, fixedMax, fixedSize] = across
      ? [bounds.top, bounds.bottom, height]
      : [bounds.left, bounds.right, width];
    if (fixed < fixedMin || fixed + fixedSize > fixedMax) continue;
    const [lo, hi, size, min, max] = across
      ? [anchor.left, anchor.right, width, bounds.left, bounds.right]
      : [anchor.top, anchor.bottom, height, bounds.top, bounds.bottom];
    if (max - min < size) continue;
    const slides = avoid.flatMap((box) =>
      across
        ? [box.right + GAP, box.left - GAP - width]
        : [box.bottom + GAP, box.top - GAP - height],
    );
    for (const start of [(lo + hi) / 2 - size / 2, lo, hi - size, ...slides]) {
      const at = Math.min(Math.max(start, min), max - size);
      const box = across
        ? { left: at, top: fixed, right: at + width, bottom: fixed + height }
        : { left: fixed, top: at, right: fixed + width, bottom: at + height };
      if (overlap(box, anchor) > 0) continue;
      const shared = Math.min(hi, at + size) - Math.max(lo, at);
      const near = shared >= Math.min(24, hi - lo);
      const caret = near
        ? Math.min(
            Math.max((Math.max(lo, at) + Math.min(hi, at + size)) / 2 - at, CARET_INSET),
            size - CARET_INSET,
          )
        : null;
      found.push({ left: box.left, top: box.top, side, caret, box, near });
    }
  }
  return found;
}

/**
 * Where a `width`×`height` mark sits beside `anchor` within `bounds`: on
 * chrome, clear of the whole `stage`, when a spot next to the anchor allows;
 * then next to the anchor and clear of the `picture` (what shows of the
 * picture or the cel); then anywhere clear of the stage, or of the picture;
 * last, wherever covers the least of the picture. `first` is the side it
 * tries first at each step.
 */
export function placeMark(
  anchor: Box,
  width: number,
  height: number,
  bounds: Box,
  first: TourSide,
  avoid: { readonly stage: readonly Box[]; readonly picture: readonly Box[] },
): MarkPlacement {
  const order = [first, ...SIDES.filter((side) => side !== first)];
  const clear = (spot: Candidate, boxes: readonly Box[]) =>
    boxes.every((box) => overlap(spot.box, box) === 0);
  const onChrome = candidates(anchor, width, height, bounds, order, avoid.stage);
  const offPicture = candidates(anchor, width, height, bounds, order, avoid.picture);
  const spot =
    onChrome.find((c) => c.near && clear(c, avoid.stage)) ??
    offPicture.find((c) => c.near && clear(c, avoid.picture)) ??
    onChrome.find((c) => clear(c, avoid.stage)) ??
    offPicture.find((c) => clear(c, avoid.picture)) ??
    offPicture.reduce<Candidate | undefined>((best, c) => {
      const cost = (spot: Candidate) =>
        avoid.picture.reduce((sum, box) => sum + overlap(spot.box, box), 0);
      return best === undefined || cost(c) < cost(best) ? c : best;
    }, undefined);
  if (spot) return { left: spot.left, top: spot.top, side: spot.side, caret: spot.caret };
  return { left: bounds.left, top: bounds.top, side: first, caret: null };
}

/**
 * Automatic groups for the Room Studio's Scene list. An imported picture
 * becomes one native item per drawing element (hundreds for a detailed
 * scene), so consecutive items that share their kind and their dominant value
 * (visual colour for art and mixed, priority for depth and walk) fold into one
 * group. Groups are a view over the document: nothing is written to the
 * source, so the bytes and annotations never change.
 */

export interface SceneGroupMember<K extends string = string> {
  /** The item's kind (`art`, `depth`, `walk` or `mixed`). */
  readonly kind: K;
  /**
   * The value most of the item's own pixels hold on its plane (visual for
   * art and mixed, priority for depth and walk), or null when later drawing
   * covered all of them.
   */
  readonly value: number | null;
}

export interface SceneGroup<K extends string = string> {
  /** Index of the first member in the input. */
  readonly start: number;
  /** Number of members, at least 1. */
  readonly count: number;
  readonly kind: K;
  readonly value: number | null;
}

/** EGA colour names, index = colour number. */
export const EGA_COLOUR_NAMES: readonly string[] = [
  "black",
  "blue",
  "green",
  "cyan",
  "red",
  "magenta",
  "brown",
  "light grey",
  "dark grey",
  "light blue",
  "light green",
  "light cyan",
  "light red",
  "light magenta",
  "yellow",
  "white",
];

/**
 * Split `items` (in draw order) into maximal runs of consecutive items with
 * the same kind and value. Every item lands in exactly one group, in order;
 * a group of one stands for a plain item.
 */
export function groupSceneItems<K extends string>(
  items: readonly SceneGroupMember<K>[],
): SceneGroup<K>[] {
  const groups: SceneGroup<K>[] = [];
  let start = 0;
  for (let i = 1; i <= items.length; i++) {
    const first = items[start]!;
    const next = items[i];
    if (next && next.kind === first.kind && next.value === first.value) continue;
    if (i > start) groups.push({ start, count: i - start, kind: first.kind, value: first.value });
    start = i;
  }
  return groups;
}

/** Above this many top-level rows, the Scene list folds them into draw-order sections. */
export const SECTION_ROW_LIMIT = 60;
/** About how many sections a long list gets. */
export const SECTION_TARGET = 36;

export interface SceneSpan {
  /** Index of the first top-level row. */
  readonly start: number;
  /** Number of rows, at least 1. */
  readonly count: number;
}

/**
 * Fold top-level rows (groups and single items, in draw order) into about
 * `target` contiguous sections of even weight, where a row weighs its
 * command count (at least 1). A row is never split, so one heavy row may
 * swallow several shares and leave fewer sections. Returns null when there
 * are at most `limit` rows: short lists need no sections.
 */
export function sectionSceneRows(
  weights: readonly number[],
  { limit = SECTION_ROW_LIMIT, target = SECTION_TARGET } = {},
): SceneSpan[] | null {
  if (weights.length <= limit) return null;
  const weight = weights.map((w) => Math.max(1, w));
  const total = weight.reduce((sum, w) => sum + w, 0);
  const spans: SceneSpan[] = [];
  let start = 0;
  let sum = 0;
  let share = 1;
  weight.forEach((w, i) => {
    sum += w;
    if (i < weight.length - 1 && sum * target < share * total) return;
    spans.push({ start, count: i + 1 - start });
    start = i + 1;
    while (share * total <= sum * target) share++;
  });
  return spans;
}

/**
 * The `limit` values with the most weight, heaviest first (ties by value);
 * null values are skipped. For a section's swatches.
 */
export function dominantValues(
  entries: readonly { readonly value: number | null; readonly weight: number }[],
  limit = 3,
): number[] {
  const weightOf = new Map<number, number>();
  for (const { value, weight } of entries)
    if (value !== null) weightOf.set(value, (weightOf.get(value) ?? 0) + weight);
  return [...weightOf]
    .sort(([a, wa], [b, wb]) => wb - wa || a - b)
    .slice(0, limit)
    .map(([value]) => value);
}

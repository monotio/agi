/**
 * Native items: the Room Studio's first view of a picture that has no
 * `@item` directives yet (typically `disassemblePicture` output). The drawing
 * elements of `groupPictureElements` become `@item` comments, so the compiled
 * bytes never change.
 */

import type { AgiProfile } from "../runtime/profile.ts";
import {
  groupPictureElements,
  PLANE_CONTROL,
  PLANE_DEPTH,
  PLANE_VISUAL,
} from "../picture/elements.ts";
import { compilePictureSource } from "../picture/source.ts";
import { isPictureDirective, type PictureItemKind } from "./pictureDocument.ts";

/**
 * Whether `id` is one `inferNativeItems` assigns: `el-N`, or `el-N-M` for the
 * later parts of an element split over non-adjacent lines.
 */
export function isInferredItemId(id: string): boolean {
  return /^el-\d+(?:-\d+)?$/.test(id);
}

/** The kind of an item from the planes its lines write. */
function kindOf(planes: number): PictureItemKind {
  if (planes === PLANE_VISUAL) return "art";
  if (planes === PLANE_DEPTH) return "depth";
  if (planes === PLANE_CONTROL) return "walk";
  return "mixed";
}

/**
 * Wrap each drawing element in `# @item el-N "Element N" <kind>` / `# @end`.
 * Items cover consecutive lines, so an element whose lines are not adjacent
 * (a fill seeded later in the file) becomes one item per run: `el-N`, then
 * `el-N-2 "Element N part 2"` and so on. State lines and comments belong to
 * the element they precede; blank lines before an element, lines after the
 * last drawing command and `end` stay loose. `copy` ranges are renumbered to
 * the shifted lines. A source that already has directives is returned as is.
 * Throws PictureSourceSyntaxError when the source does not compile.
 */
export function inferNativeItems(source: string, opts: { profile: AgiProfile }): string {
  const raw = source.split("\n");
  if (raw.some(isPictureDirective)) return source;
  const groups = groupPictureElements(source, { profile: opts.profile, joinContinuations: true });
  const eol = source.includes("\r\n") ? "\r" : "";
  const out: string[] = [];
  /** 1-based output line of each input line, for `copy` ranges. */
  const moved: number[] = [];
  const parts = new Map<number, number>();
  const emit = (k: number): void => {
    moved[k] = out.length + 1;
    const copy = /^(\s*copy\s+)(\d+)-(\d+)/i.exec(raw[k]!);
    const from = moved[Number(copy?.[2]) - 1];
    const to = moved[Number(copy?.[3]) - 1];
    if (copy && from !== undefined && to !== undefined) {
      out.push(`${copy[1]}${from}-${to}${raw[k]!.slice(copy[0].length)}`);
    } else {
      out.push(raw[k]!);
    }
  };
  let k = 0;
  while (k < raw.length) {
    const element = groups.elementOf[k]!;
    if (element === 0) {
      emit(k++);
      continue;
    }
    let end = k;
    while (end + 1 < raw.length && groups.elementOf[end + 1] === element) end++;
    while (k < end && raw[k]!.trim().length === 0) emit(k++);
    let planes = 0;
    for (let j = k; j <= end; j++) planes |= groups.planes[j]!;
    const part = (parts.get(element) ?? 0) + 1;
    parts.set(element, part);
    const id = part === 1 ? `el-${element}` : `el-${element}-${part}`;
    const label = part === 1 ? `Element ${element}` : `Element ${element} part ${part}`;
    out.push(`# @item ${id} ${JSON.stringify(label)} ${kindOf(planes)}${eol}`);
    while (k <= end) emit(k++);
    out.push(`# @end${eol}`);
  }
  const result = out.join("\n");
  const bytes = compilePictureSource(result, { lenient: true, profile: opts.profile }).bytes;
  const expected = groups.compiled.bytes;
  if (bytes.length !== expected.length || bytes.some((b, i) => b !== expected[i])) {
    throw new Error("inferNativeItems changed the compiled picture");
  }
  return result;
}

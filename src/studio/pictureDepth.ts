/** Derived item priority, encoded as ordinary horizontal AGI lines. */
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../types.ts";
import { priorityForY } from "../runtime/priority.ts";
import { commandHead, registerLine } from "./editState.ts";
import { EditRefusal } from "./editSource.ts";
import {
  bodyOf,
  editableItem,
  finish,
  inputLines,
  newLine,
  refuseCopiesOf,
  stateBefore,
  type Context,
  type EditSuccess,
} from "./editSegments.ts";
import { itemVisualFootprint } from "./pictureQuery.ts";
import type { PictureItem } from "./pictureDocument.ts";

/** Remove only the metadata, retaining the ordinary painted priority commands. */
export function clearItemDepth(ctx: Context, item: PictureItem): EditSuccess {
  return finish(
    inputLines(ctx, 1, ctx.lines.length).filter(
      (line) => line.from !== item.depth?.openLine && line.from !== item.depth?.closeLine,
    ),
    ctx,
  );
}

/**
 * Replace all of the item's painted priority with its visual coverage's band.
 * Horizontal runs cost at most five bytes each (three for a single pixel).
 * Lines overwrite existing priority, so other items' depth cannot stop a fill.
 */
export function standItemUp(
  ctx: Context,
  itemId: string,
  baseY?: number,
  priorityBase = 48,
): EditSuccess {
  const item = editableItem(ctx, itemId);
  refuseCopiesOf(ctx, item, "setting depth for");
  const { mask, bottom } = itemVisualFootprint(ctx.document, itemId, ctx.profile);
  if (bottom === null && !item.depth)
    throw new EditRefusal(`item '${itemId}' draws no visual pixels`);
  const base = baseY ?? bottom ?? item.depth!.baseY;
  if (!Number.isInteger(base) || base < 0 || base >= SCREEN_HEIGHT) {
    throw new EditRefusal("baseY must be a surface row 0..167");
  }
  if (!Number.isInteger(priorityBase) || priorityBase < 0 || priorityBase >= SCREEN_HEIGHT) {
    throw new EditRefusal("priorityBase must be a surface row 0..167");
  }
  const effectiveBase = ctx.profile.priorityBaseAction === "effect" ? priorityBase : 48;
  const originalEnd = stateBefore(ctx, item.closeLine);
  const body = bodyOf(ctx, item).filter((line) => {
    const from = line.from!;
    if (item.depth && from >= item.depth.openLine && from <= item.depth.closeLine) return false;
    const head = commandHead(line.text);
    if (["raw", "copy", "end"].includes(head)) {
      throw new EditRefusal(
        `line ${from} uses ${head}; expand it into drawing commands before setting depth`,
      );
    }
    if (head === "pri" || head === "priority") return false;
    if (
      ["line", "polyline", "polygon", "rect", "rel", "xcorner", "ycorner", "fill", "plot"].includes(
        head,
      )
    ) {
      return item.depth !== undefined || stateBefore(ctx, from).visual !== null;
    }
    return true;
  });
  const depth = [
    `# @depth base=${base}${effectiveBase === 48 ? "" : ` pri-base=${effectiveBase}`}`,
    "vis off",
    `pri ${priorityForY(base, effectiveBase)}`,
  ];
  for (let y = 0; y < SCREEN_HEIGHT; y++) {
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      if (!mask[y * SCREEN_WIDTH + x]) continue;
      const start = x;
      while (x + 1 < SCREEN_WIDTH && mask[y * SCREEN_WIDTH + x + 1]) x++;
      depth.push(`line ${start},${y}${start === x ? "" : ` ${x},${y}`}`);
    }
  }
  depth.push(
    registerLine("visual", originalEnd, ctx.profile),
    registerLine("priority", originalEnd, ctx.profile),
    "# @depth end",
  );
  const result = finish(
    [
      ...inputLines(ctx, 1, item.openLine),
      newLine(ctx, "pri off"),
      ...body,
      ...depth.map((text) => newLine(ctx, text)),
      ...inputLines(ctx, item.closeLine, ctx.lines.length),
    ],
    ctx,
  );
  return result;
}

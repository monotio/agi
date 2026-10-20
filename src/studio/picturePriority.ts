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
export function clearItemPriority(ctx: Context, item: PictureItem): EditSuccess {
  return finish(
    inputLines(ctx, 1, ctx.lines.length).filter(
      (line) => line.from !== item.priority?.openLine && line.from !== item.priority?.closeLine,
    ),
    ctx,
  );
}

/**
 * Replace all of the item's painted priority with its visual coverage's band.
 * Horizontal runs cost at most five bytes each (three for a single pixel).
 * Lines overwrite existing priority, so other items' priority cannot stop a fill.
 * With `wall` (Stand in the room) a control-0 line along the base row is
 * drawn too: the item stands on it, and the wall is regenerated with the
 * coverage. The marker `# @depth ... wall` keeps the choice on the item.
 */
export function addPriority(
  ctx: Context,
  itemId: string,
  baseY?: number,
  priorityBase = 48,
  wall?: boolean,
): EditSuccess {
  const item = editableItem(ctx, itemId);
  refuseCopiesOf(ctx, item, "setting priority for");
  const { mask, bottom } = itemVisualFootprint(ctx.document, itemId, ctx.profile);
  if (bottom === null && !item.priority)
    throw new EditRefusal(`item '${itemId}' draws no visual pixels`);
  const base = baseY ?? bottom ?? item.priority!.baseY;
  if (!Number.isInteger(base) || base < 0 || base >= SCREEN_HEIGHT) {
    throw new EditRefusal("baseY must be a surface row 0..167");
  }
  if (!Number.isInteger(priorityBase) || priorityBase < 0 || priorityBase >= SCREEN_HEIGHT) {
    throw new EditRefusal("priorityBase must be a surface row 0..167");
  }
  const effectiveBase = ctx.profile.priorityBaseAction === "effect" ? priorityBase : 48;
  const withWall = wall ?? item.priority?.wall ?? false;
  const originalEnd = stateBefore(ctx, item.closeLine);
  const body = bodyOf(ctx, item).filter((line) => {
    const from = line.from!;
    if (item.priority && from >= item.priority.openLine && from <= item.priority.closeLine)
      return false;
    const head = commandHead(line.text);
    if (["raw", "copy", "end"].includes(head)) {
      throw new EditRefusal(
        `line ${from} uses ${head}; expand it into drawing commands before setting priority`,
      );
    }
    if (head === "pri" || head === "priority") return false;
    if (
      ["line", "polyline", "polygon", "rect", "rel", "xcorner", "ycorner", "fill", "plot"].includes(
        head,
      )
    ) {
      return item.priority !== undefined || stateBefore(ctx, from).visual !== null;
    }
    return true;
  });
  const priority = [
    `# @depth base=${base}${effectiveBase === 48 ? "" : ` pri-base=${effectiveBase}`}${withWall ? " wall" : ""}`,
    "vis off",
    `pri ${priorityForY(base, effectiveBase)}`,
  ];
  for (let y = 0; y < SCREEN_HEIGHT; y++) {
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      if (!mask[y * SCREEN_WIDTH + x]) continue;
      const start = x;
      while (x + 1 < SCREEN_WIDTH && mask[y * SCREEN_WIDTH + x + 1]) x++;
      priority.push(`line ${start},${y}${start === x ? "" : ` ${x},${y}`}`);
    }
  }
  if (withWall) {
    priority.push("pri 0");
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      if (!mask[base * SCREEN_WIDTH + x]) continue;
      const start = x;
      while (x + 1 < SCREEN_WIDTH && mask[base * SCREEN_WIDTH + x + 1]) x++;
      priority.push(`line ${start},${base}${start === x ? "" : ` ${x},${base}`}`);
    }
  }
  priority.push(
    registerLine("visual", originalEnd, ctx.profile),
    registerLine("priority", originalEnd, ctx.profile),
    "# @depth end",
  );
  const result = finish(
    [
      ...inputLines(ctx, 1, item.openLine),
      newLine(ctx, "pri off"),
      ...body,
      ...priority.map((text) => newLine(ctx, text)),
      ...inputLines(ctx, item.closeLine, ctx.lines.length),
    ],
    ctx,
  );
  return result;
}

/**
 * Stand in the room: the item's derived priority takes the band of its base row
 * and a control-0 wall line is drawn along that base, both inside the item's
 * priority block so they travel and regenerate with it.
 */
export function standInRoom(
  ctx: Context,
  itemId: string,
  baseY?: number,
  priorityBase = 48,
): EditSuccess {
  return addPriority(ctx, itemId, baseY, priorityBase, true);
}

/**
 * "Watch it paint itself": the frame plan of a picture clip. AGI pictures
 * are command lists the original interpreter drew visibly, line by line and
 * fill by fill; the clip replays them in draw order at a steady frame rate,
 * holds the finished picture, then shows the caption card (shareFrame.ts).
 * Everything here is pure: renderClip.ts turns the plan into video.
 */

import { renderPicture } from "../../../../src/picture/renderer.ts";
import type { PictureSourceSpan } from "../../../../src/picture/source.ts";
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import type { TimelineEntry } from "../../../../src/studio/pictureQuery.ts";
import { createPictureSurface } from "../../../../src/types.ts";
import { spanIndexAt, tickFor } from "../studioView.ts";

export const CLIP_FPS = 30;
/** About five seconds of painting. */
export const PAINT_FRAMES = 150;
/** The finished picture alone for a second… */
export const HOLD_FRAMES = 30;
/** …then with its caption for a second and a half. */
export const CAPTION_FRAMES = 45;

/** One video frame: the picture after its first `commands` commands, captioned or not. */
export interface ClipFrame {
  commands: number;
  caption: boolean;
}

/**
 * How many cell writes each command makes on the way to the finished
 * picture: one render with the renderer's write trace, each write counted
 * against the command whose opcode made it. Index k matches `spans[k]`.
 */
export function commandCells(
  compiled: { bytes: Uint8Array; spans: readonly PictureSourceSpan[] },
  profile: AgiProfile,
): number[] {
  const { spans } = compiled;
  const cells = spans.map(() => 0);
  renderPicture(compiled.bytes, createPictureSurface(), {
    profile,
    onCellWrite: (_cell, opcode) => {
      const k = spanIndexAt(spans, opcode);
      if (k >= 0) cells[k]!++;
    },
  });
  return cells;
}

/**
 * What a command costs to paint, in clip time. The original drew every
 * cell, so time follows the cells a command writes, but not linearly: a
 * sky fill of 20,000 cells would otherwise stall the clip for seconds on a
 * single frame while the hundred lines that shape the room flash past. The
 * square root keeps a fill a visible beat (a full-screen fill ≈ 165) and a
 * long line longer than a short one (a 100-cell line 11, a 4-cell line 3),
 * and the 1 gives even a single plotted cell a moment. A command that draws
 * nothing you can see (a state change, or drawing only on the priority
 * plane, which the clip does not show) costs nothing.
 */
export function commandCost(cells: number, visible: boolean): number {
  return visible && cells > 0 ? 1 + Math.sqrt(cells) : 0;
}

/** The paint cost of each timeline entry, from its cell writes (`commandCells`). */
export function paintWeights(
  timeline: readonly TimelineEntry[],
  cells: readonly number[],
): number[] {
  return timeline.map((entry, k) =>
    commandCost(cells[k] ?? 0, tickFor(entry).kind !== "state" && entry.visual !== null),
  );
}

/**
 * Commands drawn by each of `frames` paint frames: the f-th (from 1) shows
 * every command whose running cost is paid by f/frames of the total, so
 * cheap commands share a frame and a costly one holds the frames it paid
 * for. The last frame always shows every command.
 */
export function planPaintFrames(weights: readonly number[], frames = PAINT_FRAMES): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const counts: number[] = [];
  let drawn = 0;
  let paid = 0;
  for (let f = 1; f <= frames; f++) {
    const due = (total * f) / frames;
    while (drawn < weights.length && paid + weights[drawn]! <= due) paid += weights[drawn++]!;
    counts.push(f === frames ? weights.length : drawn);
  }
  return counts;
}

/** The whole clip: the painting, the finished picture held, then the captioned card. */
export function planClip(weights: readonly number[]): ClipFrame[] {
  const all = weights.length;
  return [
    ...planPaintFrames(weights).map((commands) => ({ commands, caption: false })),
    ...Array.from({ length: HOLD_FRAMES }, () => ({ commands: all, caption: false })),
    ...Array.from({ length: CAPTION_FRAMES }, () => ({ commands: all, caption: true })),
  ];
}

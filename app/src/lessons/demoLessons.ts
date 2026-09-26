/**
 * TEMPORARY: two lessons against the current Adventure Department (PIC 1,
 * the Picture Gallery, and VIEW 0, the apprentice) so the lesson framework
 * has content to run on. The tutorial's own set (games/adventure-department/
 * lessons.ts, TUTORIAL_LESSONS) replaces this file.
 */
import { renderPicture } from "../../../src/picture/renderer.ts";
import { createPictureSurface } from "../../../src/types.ts";
import { parseView } from "../../../src/view/view.ts";
import type { LessonSet, LessonVerifyInput } from "./types.ts";

function visualPlane(input: LessonVerifyInput, bytes: Uint8Array): Uint8Array {
  const surface = createPictureSurface();
  renderPicture(bytes, surface, { profile: input.profile });
  return surface.visual;
}

const samePixels = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Loop 0's cels as drawn: their sizes and pixels. */
function loopZero(input: LessonVerifyInput, bytes: Uint8Array): string {
  const loop = parseView(bytes, input.profile).loops[0];
  return (loop?.cels ?? [])
    .map((cel) => `${cel.width}x${cel.height}:${cel.pixels.join(",")}`)
    .join("|");
}

export const DEMO_LESSONS: LessonSet = {
  catalogId: "adventure-department",
  title: "Adventure Department: under the hood",
  lessons: [
    {
      id: "ad-demo-gallery-art",
      title: "The gallery's recipe",
      teaser: "Open the Picture Gallery in Room Studio and replay how it is drawn.",
      steps: [
        "Drag the scrubber under the picture to replay it command by command.",
        "Press 1 for the Art lens and pick an item in the scene list.",
        "Draw or move something the player will see, then Keep.",
      ],
      open: { studio: "room", picture: 1 },
      challenge: {
        prompt: "Change something the player sees in the gallery, then Keep.",
        verify: (input) =>
          samePixels(visualPlane(input, input.before), visualPlane(input, input.after))
            ? {
                ok: false,
                hint: "The art looks the same: in the Art lens (1), draw or move something the player sees.",
              }
            : { ok: true },
      },
    },
    {
      id: "ad-demo-apprentice-flipbook",
      title: "The apprentice's flipbook",
      teaser: "Open the apprentice in Sprite Studio and flip through a walk cycle.",
      steps: [
        "Pick a cel in the timeline under the canvas: each loop is one facing.",
        "Paint a few pixels in loop 0 with the Pencil (B).",
        "Keep, then walk the apprentice to see the new frames.",
      ],
      open: { studio: "sprite", view: 0 },
      challenge: {
        prompt: "Repaint part of loop 0, then Keep.",
        verify: (input) =>
          loopZero(input, input.before) === loopZero(input, input.after)
            ? { ok: false, hint: "Loop 0 is unchanged: paint in one of its cels, then Keep." }
            : { ok: true },
      },
    },
  ],
};

/**
 * Sprite Studio's plain wording for the sprite kernel's refusals and the
 * validation that follows every edit. The kernel's text names operands and
 * ranges, which is right for logs, tests and the agent; the creator reads
 * one short sentence and can open the technical text as its detail.
 */

import type { SpriteValidation } from "../../../../src/studio/sprite/spriteValidation.ts";

/** Kernel refusal patterns, first match wins, each with its plain sentence. */
const PLAIN: readonly (readonly [RegExp, (match: RegExpMatchArray) => string])[] = [
  [/is the cel's transparent colour/, () => "The eraser (E) paints the transparent colour."],
  [/cannot delete the last cel/, () => "A loop needs at least one cel. Delete the loop instead."],
  [/cannot delete the view's last loop/, () => "A view needs at least one loop."],
  [/already has the maximum (\d+) cels/, (m) => `A loop holds at most ${m[1]} cels here.`],
  [/already has the maximum (\d+) loops/, (m) => `A view holds at most ${m[1]} loops.`],
  [
    /loop (\d+)'s cels are not exact mirror images of loop (\d+)'s/,
    (m) => `Loop ${m[1]} is not an exact mirror of loop ${m[2]}; replace it to link them.`,
  ],
  [/already shares loop (\d+)'s data block/, (m) => `This loop already mirrors loop ${m[1]}.`],
  [/does not share its data block/, () => "This loop has its own pixels."],
  [/a loop cannot mirror itself/, () => "A loop cannot mirror itself."],
  [
    /no stored orientation can display|shares loop \d+'s data block but its cels differ/,
    () => "The VIEW format cannot store linked loops that differ like this.",
  ],
  [/opaque pixels already use colour (\d+)/, (m) => `Pixels already use colour ${m[1]}.`],
  [/must be an integer in/, () => "That value is out of range for this cel."],
];

/** The creator's sentence for kernel refusal `error`. */
export function plainSpriteRefusal(error: string): string {
  for (const [pattern, say] of PLAIN) {
    const match = error.match(pattern);
    if (match) return say(match);
  }
  return "The view can't be changed that way.";
}

const list = (loops: readonly number[]): string =>
  loops.length === 1
    ? `loop ${loops[0]}`
    : `loops ${loops.slice(0, -1).join(", ")} and ${loops.at(-1)}`;

/** The sentence for a validation that refused an edit: which other loops it reached. */
export function validationRefusal(check: SpriteValidation): string {
  const reached = [
    ...new Set(
      check.violations.flatMap((violation) =>
        "loops" in violation ? violation.loops : [violation.loop],
      ),
    ),
  ].sort((a, b) => a - b);
  return reached.length === 0
    ? "This edit would change more than the loop you are editing."
    : `This edit would also change ${list(reached)}, outside the loop you are editing.`;
}

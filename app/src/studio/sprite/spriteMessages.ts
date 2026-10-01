import { VOCABULARY } from "../../../../src/vocabulary.ts";
/**
 * Sprite Studio's plain wording for the sprite kernel's refusals and the
 * validation that follows every edit. The kernel's text names operands and
 * ranges, which is right for logs, tests and the agent; the creator reads
 * one short sentence and can open the technical text as its detail.
 */

import type { SpriteValidation } from "../../../../src/studio/sprite/spriteValidation.ts";

/** Kernel refusal patterns, first match wins, each with its plain sentence. */
const PLAIN: readonly (readonly [RegExp, (match: RegExpMatchArray) => string])[] = [
  [
    /is the cel's transparent colour/,
    () => "That is the transparent colour. Use the eraser to paint it.",
  ],
  [
    /cannot delete the last cel/,
    () => "Loops hold one or more cels. To remove this cel, delete the loop.",
  ],
  [
    /cannot delete the view's last loop/,
    () => "A VIEW holds one or more loops. Select the VIEW to remove it.",
  ],
  [
    /already has the maximum (\d+) cels/,
    (m) => `This loop has ${m[1]} cels, its limit. Delete a cel before adding one.`,
  ],
  [
    /already has the maximum (\d+) loops/,
    (m) => `This VIEW has ${m[1]} loops, its limit. Delete a loop before adding one.`,
  ],
  [
    /loop (\d+)'s cels are not exact mirror images of loop (\d+)'s/,
    (m) => `Loop ${m[1]} differs from loop ${m[2]} flipped. Replace it to mirror.`,
  ],
  [
    /already shares loop (\d+)'s data block/,
    (m) => `This loop already mirrors loop ${m[1]}. Choose another loop to mirror.`,
  ],
  [
    /does not share its data block/,
    () =>
      "This loop has independent cels. The selected loop is the mirror source. Choose another loop to mirror.",
  ],
  [
    /a loop cannot mirror itself/,
    () => "The selected loop is the mirror source. Choose another loop to mirror.",
  ],
  [
    /no stored orientation can display|shares loop \d+'s data block but its cels differ/,
    () => "The mirrored cels differ. Turn on Edit both or edit only this loop.",
  ],
  [
    /opaque pixels already use colour (\d+)/,
    (m) => `Pixels already use colour ${m[1]}. Choose an unused transparent colour.`,
  ],
  [
    /must be an integer in/,
    () => "The value is outside this cel's range. Enter a value within the shown limits.",
  ],
];

/** The creator's sentence for kernel refusal `error`. */
export function plainSpriteRefusal(error: string): string {
  for (const [pattern, say] of PLAIN) {
    const match = error.match(pattern);
    if (match) return say(match);
  }
  return `${VOCABULARY.view.label} edit: ${error}. Correct the source or undo your last change.`;
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
    ? "This edit would change another loop too. Turn on Edit both, or edit only this loop."
    : `This edit would also change ${list(reached)}. Turn on Edit both, or edit only this loop.`;
}

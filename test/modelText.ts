import assert from "node:assert/strict";

/**
 * Model-facing text carries words and small numbers, never image bytes or
 * pixel arrays: those travel as image blocks. This checks the content itself,
 * so a richer message can grow without tripping a size budget.
 */
export function assertNoImageData(text: string, label = "model text"): void {
  assert.doesNotMatch(text, /data:image|iVBORw0KGgo/, `${label} embeds an encoded image`);
  assert.doesNotMatch(text, /(?:-?\d+\s*,\s*){63}-?\d+/, `${label} embeds a pixel array`);
}

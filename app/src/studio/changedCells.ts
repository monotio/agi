import { SCREEN_HEIGHT, SCREEN_WIDTH } from "../../../src/types.ts";
const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;

/** 160x168: 1 where either plane differs. */
export function changedCells(
  before: { readonly visual: Uint8Array; readonly priority: Uint8Array },
  after: { readonly visual: Uint8Array; readonly priority: Uint8Array },
): Uint8Array {
  const mask = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i++)
    if (before.visual[i] !== after.visual[i] || before.priority[i] !== after.priority[i])
      mask[i] = 1;
  return mask;
}

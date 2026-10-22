import {
  encodeViewBlocks,
  type BuildViewInput,
  type ViewCapabilities,
} from "../../../src/view/view.ts";

/**
 * The 1.2.4 builder's native block layout, retained only to authenticate older
 * source claims. Released bytes are pinned in fixtures/view-builder-1.2.4.json.
 * The block encoder retains that layout; 1.2.4 also rejected packed aliases and
 * independently mirror-enabled blocks above loop 3.
 */
export function buildReleasedView(input: BuildViewInput, profile: ViewCapabilities): Uint8Array {
  if (profile.packedViewLoopHeader)
    for (const [index, loop] of input.loops.entries()) {
      if (index <= 3) continue;
      if (
        (!loop.cels?.length && typeof loop.mirrorLoop === "number") ||
        loop.cels?.some((cel) => cel.mirror) ||
        input.loops.some((alias) => !alias.cels?.length && alias.mirrorLoop === index)
      )
        throw new RangeError("packed mutable loop indices must be in 0..3");
    }
  return encodeViewBlocks(input, profile);
}

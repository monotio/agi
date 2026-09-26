import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";
import { buildView } from "../src/view/view.ts";

/**
 * The tiny view the sprite tests share, stored rows row-major:
 * - loop 0: cel 0 is 2x2 [1,2 / 3,0], cel 1 is 3x2 [4,5,6 / 0,7,8], transparent 0;
 * - loop 1: shares loop 0's block and displays it mirrored;
 * - loop 2: cel 0 is 2x2 [5,15 / 5,5] with transparent 15, cel 1 is 3x2
 *   [1,2,3 / 4,1,6] with transparent 0.
 */
export function mirroredView(): Uint8Array {
  return buildView(
    {
      loops: [
        {
          cels: [
            { width: 2, height: 2, transparentColor: 0, pixels: [1, 2, 3, 0] },
            { width: 3, height: 2, transparentColor: 0, pixels: [4, 5, 6, 0, 7, 8] },
          ],
        },
        { mirrorLoop: 0 },
        {
          cels: [
            { width: 2, height: 2, transparentColor: 15, pixels: [5, 15, 5, 5] },
            { width: 3, height: 2, transparentColor: 0, pixels: [1, 2, 3, 4, 1, 6] },
          ],
        },
      ],
    },
    DEFAULT_V2_PROFILE,
  );
}

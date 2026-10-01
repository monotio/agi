/** Temporary cel audition changes presentation pixels only. */
import type { Engine } from "../../../src/runtime/engine.ts";
import { parseView } from "../../../src/view/view.ts";
export function createImageHeroPreview(
  engine: Engine,
  bytes: Uint8Array,
  started: number,
  loopNumbers?: readonly number[],
) {
  if (bytes.length > 65535) throw new Error("The preview exceeds the VIEW byte limit.");
  const view = parseView(bytes, engine.profile);
  if (
    loopNumbers &&
    (loopNumbers.length !== view.loops.length ||
      new Set(loopNumbers).size !== loopNumbers.length ||
      loopNumbers.some((loop) => !Number.isInteger(loop) || loop < 0 || loop > 254))
  )
    throw new Error("Preview loop numbers must match the marked loops.");
  return (frame: ReturnType<Engine["getPresentation"]>, cycle: number) => {
    const hero = engine.readObjects().find((object) => object.num === 0);
    if (!hero) return;
    const index = loopNumbers
      ? Math.max(0, loopNumbers.indexOf(hero.loop))
      : Math.min(hero.loop, view.loops.length - 1);
    const loop = view.loops[index];
    if (!loop?.cels.length) return;
    const cel =
      loop.cels[
        Math.floor((cycle - started) / Math.max(1, hero.cycleTime || 3)) % loop.cels.length
      ]!;
    const ownership = engine.getOwnership();
    const picture = engine.getPictureSurface();
    for (let i = 0; i < frame.visual.length; i++)
      if (ownership[i] === 1) frame.visual[i] = picture.visual[i]!;
    for (let y = 0; y < cel.height; y++)
      for (let x = 0; x < cel.width; x++) {
        const dx = hero.x + x,
          dy = hero.y - cel.height + 1 + y;
        if (dx < 0 || dx >= 160 || dy < 0 || dy >= 168) continue;
        const index = dy * 160 + dx,
          color = cel.pixels[y * cel.width + x]!;
        if (
          color !== cel.transparentColor &&
          picture.priority[index]! <= hero.priority &&
          (ownership[index] === 0 || ownership[index] === 1)
        )
          frame.visual[index] = color;
      }
  };
}

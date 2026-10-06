import { shallowRef } from "vue";
import type { SpriteCel } from "../../../src/view/spriteDocument.ts";

export interface GuidedPlacement {
  kind: "hero" | "box";
  x: number;
  y: number;
  box: { x1: number; y1: number; x2: number; y2: number };
  cel: SpriteCel | undefined;
  background: string | undefined;
  label: string;
  done: (value: GuidedPlacement) => void;
  cancel: () => void;
}

/** Create's placement request is shared with the running dock, then retired on Done or Cancel. */
export const guidedPlacement = shallowRef<GuidedPlacement>();

/** Same canvas-content mapping as click-to-walk, then frame pixels → picture coordinates. */
export function dockPicturePoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  picRow: number,
): { x: number; y: number } {
  return {
    x: Math.min(159, Math.max(0, Math.floor(((clientX - rect.left) * 160) / rect.width))),
    y: Math.min(
      167,
      Math.max(0, Math.floor(((clientY - rect.top) * 200) / rect.height) - picRow * 8),
    ),
  };
}

import type { BuildCelInput, BuildViewInput } from "../../src/view/view.ts";

/** The lamp is a solid block, so its transparent index is simply one it never uses. */
const TRANSPARENT = 13;

const SIGNAL_COLORS: Record<string, number> = {
  K: 0,
  r: 4,
  g: 10,
};

function signalCel(rows: readonly string[]): BuildCelInput {
  const width = 6;
  const height = 4;
  if (rows.length !== height || rows.some((row) => row.length !== width)) {
    throw new Error("signal cel must be exactly 6 by 4 pixels");
  }
  return {
    width,
    height,
    transparentColor: TRANSPARENT,
    pixels: rows.flatMap((row) => [...row].map((symbol) => SIGNAL_COLORS[symbol]!)),
  };
}

/**
 * A shelf lamp beside the archive counter confirms the priority repair: cel 0
 * burns red until FIX PRIORITY succeeds, cel 1 is the green all-clear that room
 * re-entry restores from the repair flag.
 */
export const SIGNAL_VIEW: BuildViewInput = {
  description: "Archive repair signal",
  loops: [
    {
      cels: [
        signalCel(["KKKKKK", "KrrrrK", "KrrrrK", "KKKKKK"]),
        signalCel(["KKKKKK", "KggggK", "KggggK", "KKKKKK"]),
      ],
    },
  ],
};

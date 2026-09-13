import { Engine, type EngineHost } from "../../src/runtime/engine.ts";
import { openContainer } from "../../src/container/container.ts";
import { compositeFrame } from "./composite.ts";

export interface GameInspection {
  status: "ready" | "needs-input";
  message: string;
  profile: string;
  rgba: Uint8ClampedArray<ArrayBuffer>;
  rows: string[];
}

/** The preview worker's protocol — separate from the engine worker's. */
export interface PreviewWorkerInbound {
  files: Record<string, Uint8Array>;
  words: [string, number][];
}
export type PreviewWorkerOutbound = { result: GameInspection } | { error: string };

class PreviewInput extends Error {}

/** A disposable interpreter, with no authoring, persistence, audio or network capabilities. */
export function inspectGame(game: {
  files: Record<string, Uint8Array>;
  words: [string, number][];
}): GameInspection {
  const stop = (): never => {
    throw new PreviewInput();
  };
  const host: EngineHost = {
    print() {},
    displayAt() {},
    statusLine() {},
    takeInputLine: () => null,
    takeKeys: () => [],
    waitKey: stop,
    promptNumber: stop,
    promptString: stop,
    saveGame: stop,
    restoreGame: stop,
    quit: stop,
    randomWord: () => 12345,
  };
  const engine = new Engine(
    openContainer(new Map(Object.entries(game.files))),
    host,
    new Map(game.words),
    { instructionBudget: 100_000 },
  );
  let needsInput = false;
  let visible = false;
  try {
    for (let tick = 0; tick < 120; tick++) {
      engine.tick();
      const state = engine.readState();
      visible = state.pictureShown || engine.textCells.some((b, i) => i % 2 === 0 && b > 32);
      if (engine.modalKind) {
        needsInput = true;
        break;
      }
      if (tick >= 3 && visible) break;
      engine.advanceClock(50);
    }
  } catch (error) {
    if (!(error instanceof PreviewInput)) throw error;
    needsInput = true;
  }
  if (!visible) needsInput = true;
  const presentation = engine.getPresentation();
  const rgba = new Uint8ClampedArray(320 * 200 * 4);
  compositeFrame(
    { visual: presentation.visual, text: presentation.text, picRow: engine.displayBase },
    rgba,
  );
  return {
    status: needsInput ? "needs-input" : "ready",
    message: needsInput
      ? "Opening checked. The game may need a key or an answer to continue."
      : "Opening checked. Later rooms have not been playtested.",
    profile: engine.profile.id,
    rgba,
    rows: Array.from({ length: 25 }, (_, row) => engine.textRow(row)),
  };
}

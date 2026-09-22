import { Engine, type EngineHost } from "../../src/runtime/engine.ts";
import { openContainer } from "../../src/container/container.ts";
import { compositeFrame } from "./composite.ts";
import {
  detectProfileDecision,
  type ProfileDetectionKind,
  type ProfileId,
} from "../../src/runtime/profile.ts";

export interface GameInspection {
  status: "ready" | "needs-input";
  message: string;
  /** The detected profile — what the game runs under without an override. */
  profile: string;
  kind: ProfileDetectionKind;
  build: string | undefined;
  rgba: Uint8ClampedArray<ArrayBuffer>;
  rows: string[];
}

/** The preview worker's protocol — separate from the engine worker's. */
export interface PreviewWorkerInbound {
  files: Record<string, Uint8Array>;
  words: [string, number][];
  /** The library entry's override; the opening runs under it. */
  profile?: ProfileId | undefined;
}
export type PreviewWorkerOutbound = { result: GameInspection } | { error: string };

class PreviewInput extends Error {}

/** A disposable interpreter, with no authoring, persistence, audio or network capabilities. */
export function inspectGame(game: PreviewWorkerInbound): GameInspection {
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
    randomByte: () => 123,
  };
  const files = new Map(Object.entries(game.files));
  const engine = new Engine(openContainer(files), host, new Map(game.words), {
    instructionBudget: 100_000,
    ...(game.profile ? { profile: game.profile } : {}),
  });
  const detected = game.profile ? detectProfileDecision(files).profile : engine.profile;
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
    profile: detected.id,
    kind: engine.profileKind,
    build: engine.profileBuild ?? undefined,
    rgba,
    rows: Array.from({ length: 25 }, (_, row) => engine.textRow(row)),
  };
}

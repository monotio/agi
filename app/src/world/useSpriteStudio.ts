/**
 * Opening Sprite Studio from Create: a room's VIEWs in the World panel, the
 * Resources tab's list, or a staged character-sheet candidate from reference
 * art. Each builds the centre's request from the running game's booted
 * files (the room map's scan) and the live engine's cycle delay and priority
 * base, and reads the same view again when a refused Keep reopens it.
 */
import { base64ToBytes } from "../project/bytes.ts";
import { useEngineApi } from "../engine/engineContext.ts";
import type { StoredReference } from "../references/referenceArt.ts";
import { useCreateWorkspace, type SpriteStudioRequest } from "../shell/useCreateWorkspace.ts";
import type { EngineStateReport, ScreenObjectState } from "../../../src/runtime/engine.ts";
import { parseView } from "../../../src/view/view.ts";

const RELOADED = "Loaded the latest saved version of this game.";

/** The engine's speed variable: the cycle delay, in 1/20 s timer increments. */
const SPEED_VAR = 10;

/** What Sprite Studio reads of the running game when it opens. */
interface LiveState {
  readonly state: EngineStateReport | null;
  readonly objects: readonly ScreenObjectState[];
}

interface Staged {
  readonly id: string;
  readonly bytes: Uint8Array;
}

export function useSpriteStudio() {
  const engine = useEngineApi();
  const workspace = useCreateWorkspace();
  const map = engine.roomMap;

  const readState = async (): Promise<LiveState> => {
    const [state, objects] = await Promise.all([
      engine.readEngineState().catch(() => null),
      engine.readObjects().catch(() => []),
    ]);
    return { state, objects };
  };

  /** Sprite Studio's request for one VIEW (or a staged candidate), read from the running game. */
  function build(
    view: number,
    staged: Staged | undefined,
    { state, objects }: LiveState,
    notice?: string,
  ): SpriteStudioRequest | null {
    const source = map.spriteSource(view, staged?.bytes);
    if (!source) return null;
    let title = staged ? "Staged character sheet" : `VIEW ${view}`;
    try {
      title = parseView(source.bytes, source.profile).description ?? title;
    } catch {
      // An undecodable view keeps its number as its name.
    }
    return {
      kind: "sprite",
      viewNumber: view,
      ...source,
      title,
      speed: state?.vars[SPEED_VAR] ?? 1,
      // The loop preview borrows the cycle time of an object showing the view.
      cyclers: objects.map(({ num, view, loop, cycling, cycleTime }) => ({
        num,
        view,
        loop,
        cycling,
        cycleTime,
      })),
      priorityBase: state?.priorityBase,
      stagedReference: staged?.id,
      notice,
      reload: () => build(view, staged, { state, objects }),
      reloadFromStorage: async () =>
        (await engine.reloadFromStorage()) && engine.state.phase !== "error"
          ? build(view, staged, await readState(), RELOADED)
          : null,
    };
  }

  async function request(view: number, staged?: Staged): Promise<SpriteStudioRequest | null> {
    return build(view, staged, await readState());
  }

  async function open(view: number): Promise<void> {
    const next = await request(view);
    if (next) workspace.openStudio(next);
  }

  /** Open a staged character-sheet candidate to repair it before keeping. */
  async function openStaged(reference: StoredReference): Promise<void> {
    const staged = reference.staged;
    if (!staged) return;
    const next = await request(staged.num, {
      id: reference.id,
      bytes: new Uint8Array(base64ToBytes(staged.payload)),
    });
    if (next) workspace.openStudio(next);
  }

  return { request, open, openStaged };
}

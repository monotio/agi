/**
 * Detached picture reconstruction for same-Engine preview admission.
 *
 * The live `draw.pic`/`overlay.pic`/`add.to.pic` path records every surface
 * mutation as host replay evidence (the same pairs `autosaveImage` uses to
 * rebuild a detached screen). Preview admission reuses that evidence to
 * compose the would-be backdrop on a detached `PictureSurface`, so a changed
 * PIC payload can be validated and installed without calling live
 * `drawPicture`, `replaySequence` or a room reentry.
 *
 * Pair kinds mirror the `REPLAY_*` constants in engine.ts (resource replay
 * sequence): draw.pic records `(4, num)`, add.to.pic a four-pair packet
 * starting `(5, 0)`, overlay.pic `(8, num)`. No serialized replay field is
 * added; this reads the evidence already recorded.
 */
import { createPictureSurface, type PictureSurface } from "../types.ts";
import { renderPicture } from "../picture/renderer.ts";
import type { AgiProfile } from "./profile.ts";
import type { ReplayPair } from "./persistence.ts";

const REPLAY_DRAW_PICTURE = 4;
const REPLAY_ADD_TO_PIC = 5;
const REPLAY_OVERLAY_PICTURE = 8;

/** One surface-affecting picture op extracted from host replay evidence. */
export interface PictureCompositionOp {
  readonly kind: "draw" | "overlay";
  readonly num: number;
}

/**
 * The current picture backdrop expressed as replay-derived ops. `ops` starts
 * at the most recent draw (which resets the surface) followed by overlays in
 * recorded order. `complete` requires a recorded draw anchor and intact
 * evidence. Overflow (`HOST_REPLAY_LIMIT`) drops later pairs, so later
 * draws, overlays and stamps may be missing. `staticStamps` records an
 * `add.to.pic` packet after the last draw; stamped cels are volatile object
 * pixels the replay evidence does not
 * carry enough information to reproduce.
 */
export interface PictureComposition {
  readonly ops: readonly PictureCompositionOp[];
  readonly complete: boolean;
  readonly staticStamps: boolean;
  /** VIEW dependencies baked after the last recorded draw, in numeric order. */
  readonly stampedViews: readonly number[];
  /**
   * Identity of the surface-affecting evidence at analysis time. A plan
   * prepared against one fingerprint is stale once the live evidence's
   * fingerprint differs, even if the unrelated replay prefix grew.
   */
  readonly fingerprint: string;
}

export function analyzePictureComposition(
  replay: readonly ReplayPair[],
  overflow: boolean,
): PictureComposition {
  const ops: PictureCompositionOp[] = [];
  let staticStamps = false;
  let packetsComplete = true;
  const stampedViews = new Set<number>();
  for (let i = 0; i < replay.length; i++) {
    const pair = replay[i]!;
    if (pair.kind === REPLAY_DRAW_PICTURE) {
      ops.length = 0;
      staticStamps = false;
      packetsComplete = true;
      stampedViews.clear();
      ops.push({ kind: "draw", num: pair.value & 0xffff });
    } else if (pair.kind === REPLAY_OVERLAY_PICTURE) {
      ops.push({ kind: "overlay", num: pair.value & 0xffff });
    } else if (pair.kind === REPLAY_ADD_TO_PIC) {
      staticStamps = true;
      const view = replay[i + 1];
      if (view === undefined || replay[i + 3] === undefined) packetsComplete = false;
      else stampedViews.add(view.kind);
      // The packet's next three pairs carry (view, loop), (cel, left_x) and
      // (baseline_y, packed_priority) as raw data — their kind bytes alias
      // real op kinds and must not be scanned as ops.
      i += 3;
    }
  }
  const views = [...stampedViews].sort((a, b) => a - b);
  const complete = !overflow && packetsComplete && ops[0]?.kind === "draw";
  const fingerprint =
    (overflow ? "x" : ".") +
    (complete ? "." : "?") +
    (staticStamps ? "s" : ".") +
    ops.map((op) => `${op.kind === "draw" ? "d" : "o"}${op.num}`).join(",") +
    `;v${views.join(",")}`;
  return { ops, complete, staticStamps, stampedViews: views, fingerprint };
}

/**
 * Render the composition onto a fresh surface. `resolve` reads PIC payloads
 * from the staged candidate container so unchanged resources resolve to the
 * same bytes already installed. Throws whatever `renderPicture` throws; the
 * caller wraps failures as admission refusals.
 */
export function renderComposedPicture(
  ops: readonly PictureCompositionOp[],
  resolve: (num: number) => Uint8Array,
  profile: AgiProfile,
): PictureSurface {
  const surface = createPictureSurface();
  for (const op of ops) {
    renderPicture(resolve(op.num), surface, {
      overlay: op.kind === "overlay",
      profile,
    });
  }
  return surface;
}

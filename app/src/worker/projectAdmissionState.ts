import type { Engine } from "../../../src/runtime/engine.ts";
import type { DebugBindings } from "../../../src/runtime/debugExpression.ts";
import type { PreviewUpdateOutcome, SourceBindingKind } from "./workerProtocol.ts";

/**
 * The play-preview lane granted by a `frozenTest.lane: "play-preview"`
 * boot: the worker-side authority the `previewUpdate` protocol pins. It is
 * bound to the physical run — the engine instance and run serial — not to
 * one debugger session, so it is carried across detach/re-attach and dies
 * only with the boot's run. `epoch`/`buildId`/`sources`/`bindings` name the
 * installed source authority; `updateSerial` and the bounded result ledger
 * give the update protocol its monotonic dedupe authority.
 */
export interface ProjectAdmissionState {
  /** The engine instance the lane was minted for — a fresh boot ends it. */
  readonly engine: Engine;
  /** Physical-run token minted by the lane-granting boot; requests must echo it. */
  readonly runToken: string;
  /** Source-authority epoch — bumps on every installed source/build identity. */
  epoch: number;
  /** Verified build identity of the installed source image. */
  buildId: string;
  /** Exact identity of the complete admitted document set. */
  documentId?: string | undefined;
  /** Lane update serial — bumps on committed and source-only installs. */
  updateSerial: number;
  /**
   * Highest transaction id ever admitted; a later request at or below it is
   * refused rather than fresh, and a status query for it reports
   * "unavailable" — bounded retention cannot tell an evicted outcome from
   * an id that never ran. Starts at -1 so id 0 can be a first request.
   */
  highWater: number;
  /** Installed source authority, retained even while no session is attached. */
  sources: Record<string, string>;
  /** The complete authored binding map the installed build is captured under. */
  sourceBindings: Record<string, { kind: SourceBindingKind; num: number }> | null;
  /** The expression-evaluator subview of sourceBindings. */
  bindings: DebugBindings;
  /** Bounded correlated terminal results keyed by transaction id. */
  results: Map<number, { digest: string; outcome: PreviewUpdateOutcome }>;
}

/** The lane's physical-run token: opaque, per boot, unguessable off-channel. */
export function mintPreviewRunToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let token = "";
  for (const byte of bytes) token += byte.toString(16).padStart(2, "0");
  return token;
}

export function newProjectAdmissionState(runToken: string, engine: Engine): ProjectAdmissionState {
  return {
    engine,
    runToken,
    epoch: 0,
    buildId: "",
    updateSerial: 0,
    highWater: -1,
    sources: {},
    sourceBindings: null,
    bindings: {},
    results: new Map(),
  };
}

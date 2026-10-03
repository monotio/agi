/**
 * A bounded runtime freeze hold for host surfaces that preview over a live
 * game (Studio auditions). Acquiring pauses the engine under a unique owned
 * token, then waits on the worker's own FIFO "state" query — posted after the
 * pause message — so the resolved lease is proof the captured worker applied
 * the freeze. `state.paused` is optimistic and is never consulted here.
 *
 * The worker identity is captured synchronously and compared again after the
 * pause call and the awaited reply: a swapped run refuses acquisition, and a
 * late release compares the live worker before touching pause or audio state,
 * so an old token can never unpause a replacement game. A swapped worker's
 * owners were already cleared by the lifecycle's resetPauseOwners — this
 * module never resets another owner's hold itself.
 */
export interface RuntimePauseLease {
  /** Idempotent: releases only while the captured worker is still current. */
  release(): void;
}

/** The engine hooks the lease needs; useEngine wires its private link in. */
export interface RuntimePauseHost {
  /** The live game worker's identity object, or null when no game runs. */
  getWorker(): object | null;
  /** Register a pause owner and post the pause when it is the first. */
  pause(owner: string): void;
  /** Drop a pause owner and post the resume when it was the last. */
  resume(owner: string): void;
  /**
   * The typed `link.query("state")` round-trip: every message posted to this
   * worker before it — including our pause — was applied once it resolves.
   * Resolves null when the worker answered without an engine.
   */
  readState(): Promise<unknown>;
}

export type RuntimePauseLeaseAcquire = (owner: string) => Promise<RuntimePauseLease>;

/** A mount with no running game: valid for private preview, holds nothing. */
function noRunLease(): RuntimePauseLease {
  return {
    release() {},
  };
}

/**
 * Compose the acquire operation for one engine instance. `owner` names the
 * requesting surface for diagnostics and the token prefix; the actual pause
 * owner is a fresh cryptographic token so simultaneous leases and foreign
 * owners stay independent and no caller-supplied owner can be collided with.
 */
export function createRuntimePauseLeaseAcquire(
  host: RuntimePauseHost,
  token: (owner: string) => string = (owner) => `runtime-pause:${owner}:${crypto.randomUUID()}`,
): RuntimePauseLeaseAcquire {
  return async function acquireRuntimePauseLease(owner: string): Promise<RuntimePauseLease> {
    if (typeof owner !== "string" || !owner)
      throw new Error("A runtime pause lease needs a non-empty owner name.");
    const worker = host.getWorker();
    if (worker === null) return noRunLease();
    const heldOwner = token(owner);

    let paused = false;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (!paused) return;
      // The capture still matches: drop our own owner. After a swap the
      // lifecycle already cleared every owner, and a resume here would send
      // an unpause to a worker that never saw our pause.
      if (host.getWorker() === worker) host.resume(heldOwner);
    };
    const refuse = (error: unknown): never => {
      release();
      throw error instanceof Error ? error : new Error(String(error));
    };

    try {
      host.pause(heldOwner);
      paused = true;
    } catch (error) {
      return refuse(error);
    }
    if (host.getWorker() !== worker) {
      return refuse(new Error("The running game changed while the pause was posted."));
    }
    let state: unknown;
    try {
      state = await host.readState();
    } catch (error) {
      // A swap drains pending queries with a rejection; a live worker that
      // refused still holds our pause, and release() handles both cases.
      return refuse(error);
    }
    if (host.getWorker() !== worker) {
      return refuse(new Error("The running game changed while the pause was settling."));
    }
    if (state === null || state === undefined) {
      return refuse(new Error("The running game answered the pause barrier without a state."));
    }
    return { release };
  };
}

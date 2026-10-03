/**
 * Freeze / unfreeze the interpreter. Pause is an ordinary worker message:
 * messages from one sender are delivered in order, so a pause posted before
 * a query is always applied before the query is served — at most one more
 * cycle runs first, and nobody reads state before the freeze lands. The
 * worker's `paused` reply mirrors the real state into the test hook.
 *
 * Several overlays can hold the pause at once (map, remix bubble, history
 * transport, AI settings). Each caller owns its hold: the freeze message
 * goes out when the first owner parks, and the resume only when the last
 * owner releases — nobody's pause ends while another is still open.
 */
export function createPauseHolds(deps: {
  /** Post the freeze (true) or the resume (false) to the running worker. */
  readonly post: (paused: boolean) => void;
  readonly audio: { setPaused(paused: boolean): void };
  readonly state: { paused: boolean };
}) {
  const owners = new Set<string>();

  function pauseEngine(owner = "generic"): void {
    // A throwing freeze post registers nothing; a failure after registration
    // rolls the owner back and compensates only this call's posted freeze, so
    // a partial pause can never leak an owner beside a live hold — the earlier
    // dialog's resume must still reach an empty set. Cleanup failures never
    // mask the original error.
    if (owners.size === 0) deps.post(true);
    const fresh = !owners.has(owner);
    owners.add(owner);
    try {
      deps.audio.setPaused(true);
      deps.state.paused = true;
    } catch (error) {
      // A repeat pause on an existing owner added nothing; leave that hold.
      if (fresh) owners.delete(owner);
      if (owners.size === 0) {
        try {
          deps.state.paused = false;
        } catch {
          // The registration failure stands.
        }
        try {
          deps.audio.setPaused(false);
        } catch {
          // The registration failure stands.
        }
        try {
          deps.post(false);
        } catch {
          // The registration failure stands.
        }
      }
      throw error;
    }
  }

  function resumeEngine(owner = "generic"): void {
    owners.delete(owner);
    if (owners.size === 0) {
      deps.post(false);
      deps.audio.setPaused(false);
      deps.state.paused = false;
    }
  }

  /** A replaced worker takes its freeze with it; no owner survives the swap. */
  function resetPauseOwners(): void {
    owners.clear();
  }

  return {
    pauseEngine,
    resumeEngine,
    resetPauseOwners,
    /** The owners holding the pause now, in the order they took it. */
    pauseOwners: (): string[] => [...owners],
  };
}

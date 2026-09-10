import type { Frame } from "./gameTypes.ts";
import type { ReplayDriver, ReplayObservation } from "./replay.ts";
import { runReplayBatch } from "./replayRunner.ts";

export interface ReplayDriverContext {
  readonly query: <T>(type: string, extra?: Record<string, unknown>) => Promise<T>;
  readonly sendKey: (code: number, sessionId?: number) => void;
  readonly sendDirection: (dir: number, sessionId?: number) => void;
  readonly submitPrompt: (text: string) => void;
  readonly setPromptEcho?: ((text: string) => void) | undefined;
  readonly isPromptPending: () => boolean;
  readonly pollNow: () => void;
  readonly getActiveWalkthroughSession: () => number;
  readonly getLatestFrame: () => Frame | null;
  readonly observationListeners: Set<(obs: ReplayObservation) => void>;
}

/**
 * Creates the engine replay driver attached to window.__AGI_REPLAY__.
 * Enables speedrun walkthroughs and E2E automation to advance ticks,
 * dispatch input, and wait for revision checkpoints.
 */
export function createReplayDriver(ctx: ReplayDriverContext): ReplayDriver {
  const driver: ReplayDriver = {
    get sessionId() {
      return ctx.getActiveWalkthroughSession();
    },
    latest: null,
    advance: (ticks, options) => {
      const activeSession = ctx.getActiveWalkthroughSession();
      return ctx.query<ReplayObservation>("replayAdvance", {
        ticks,
        ...(options?.sessionId !== undefined
          ? { sessionId: options.sessionId }
          : activeSession > 0
            ? { sessionId: activeSession }
            : {}),
        ...(options?.seeking !== undefined ? { seeking: options.seeking } : {}),
        ...(options?.renderFinal !== undefined ? { renderFinal: options.renderFinal } : {}),
        ...(options?.fullState !== undefined ? { fullState: options.fullState } : {}),
      });
    },
    key: (code, sessionId) => ctx.sendKey(code, sessionId),
    direction: (dir, sessionId) => ctx.sendDirection(dir, sessionId),
    answer: (text) => ctx.submitPrompt(text),
    setPromptEcho: (text) => ctx.setPromptEcho?.(text),
    promptPending: () => ctx.isPromptPending(),
    pollNow: () => {
      ctx.pollNow();
    },
    waitForRevision: (
      minRevision: number,
      opts?: { unblocked?: boolean; signal?: AbortSignal | undefined },
    ) => {
      const requireUnblocked = opts?.unblocked ?? false;
      const matches = (obs: ReplayObservation | null) =>
        obs !== null && obs.revision > minRevision && (!requireUnblocked || obs.blocked === null);
      if (matches(driver.latest)) {
        return Promise.resolve(driver.latest!);
      }
      return new Promise<ReplayObservation>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          ctx.observationListeners.delete(listener);
          opts?.signal?.removeEventListener("abort", onAbort);
          reject(new DOMException("Replay revision wait aborted", "AbortError"));
        };
        if (opts?.signal?.aborted) {
          onAbort();
          return;
        }
        opts?.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => {
          ctx.observationListeners.delete(listener);
          opts?.signal?.removeEventListener("abort", onAbort);
          reject(
            new Error(
              `Timeout waiting for revision > ${minRevision} (current: ${driver.latest?.revision})`,
            ),
          );
        }, 15_000);
        const listener = (obs: ReplayObservation) => {
          if (matches(obs)) {
            clearTimeout(timer);
            opts?.signal?.removeEventListener("abort", onAbort);
            ctx.observationListeners.delete(listener);
            resolve(obs);
          }
        };
        ctx.observationListeners.add(listener);
      });
    },
    playBatch: (actions, options) =>
      runReplayBatch(driver, actions, {
        sessionId: options?.sessionId ?? ctx.getActiveWalkthroughSession(),
        isCurrentSession: options?.isCurrentSession ?? (() => true),
        ...options,
        getLatestFrame: () => ctx.getLatestFrame(),
      }),
  };
  return driver;
}

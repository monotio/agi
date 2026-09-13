/**
 * The host half of the always-on recording: commits the worker's history
 * batches into project storage and answers each durable batch with a
 * historyAck so the worker's in-flight credit frees. A commit that fails
 * (storage blocked, quota, a missing boot) leaves the batch un-acked — the
 * worker retains it and resends, so storage trouble degrades to a stalled
 * acknowledgement, never a silently dropped tape.
 *
 * `state.historyPending` counts commits in flight — the UI's "recording has
 * unsaved work" signal.
 */
import { appendHistoryBatch } from "./historyStorage.ts";
import { gameStorageKey, type BootedGame } from "./gameTypes.ts";
import type { HistoryBatch } from "../../src/agent/history.ts";
import type { AgentLogEntry } from "./agent/agentLog.ts";

export interface HistoryControllerContext {
  readonly state: { historyPending: number };
  readonly getBootedGame: () => BootedGame | null;
  readonly getProfile: () => string | null;
  readonly logAgent: (kind: AgentLogEntry["kind"], message: string) => void;
}

export interface HistoryController {
  /** Commit a posted batch; true → the worker gets its ack. */
  handleHistoryBatch(msg: { epoch: number; batch: HistoryBatch }): Promise<boolean>;
  /** Resolves when every commit posted so far has finished (ok or not). */
  drainHistoryCommits(): Promise<void>;
}

export function useHistoryController(ctx: HistoryControllerContext): HistoryController {
  const commits = new Set<Promise<unknown>>();

  function handleHistoryBatch(msg: { epoch: number; batch: HistoryBatch }): Promise<boolean> {
    const game = ctx.getBootedGame();
    const storageKey = game ? gameStorageKey(game) : "";
    if (!storageKey) return Promise.resolve(false);
    ctx.state.historyPending++;
    const pending = appendHistoryBatch(storageKey, msg.batch, ctx.getProfile() ?? "")
      .then((committed) => {
        if (!committed && ctx.getBootedGame() === game)
          ctx.logAgent("log", `history batch ${msg.batch.batch} not yet durable`);
        return committed;
      })
      .catch((error) => {
        if (ctx.getBootedGame() === game)
          ctx.logAgent("log", `history commit failed: ${String(error)}`);
        return false;
      })
      .finally(() => {
        ctx.state.historyPending--;
        commits.delete(pending);
      });
    commits.add(pending);
    return pending;
  }

  /**
   * Wait out the commit set. Resends can add commits while draining, so the
   * loop waits until the set is actually empty, not just the first batch.
   */
  async function drainHistoryCommits(): Promise<void> {
    while (commits.size > 0) await Promise.allSettled([...commits]);
  }

  return { handleHistoryBatch, drainHistoryCommits };
}

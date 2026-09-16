/**
 * The host half of the always-on recording: commits the worker's history
 * batches into project storage and answers each durable batch with a
 * historyAck so the worker's in-flight credit frees. A commit that fails
 * (storage blocked, quota, a missing boot) leaves the batch un-acked — the
 * worker retains it and resends, so storage trouble degrades to a stalled
 * acknowledgement, never a silently dropped tape.
 *
 * Two counters report that lag: `state.historyPending` counts commits in
 * flight, and `state.historyUnsaved` counts batches the storage layer has
 * refused — the "history not saved since …" signal. Refused batches stay
 * listed until a resend commits them; a game switch clears the ledger (the
 * old worker's resends are gone with it).
 *
 * One key change is not a switch: a catalog game that becomes its remix
 * project mid-session keeps the SAME worker and tape under a new
 * `gameStorageKey`. A batch whose segment still belongs to the active
 * session nonce then moves the stored record to the new key first —
 * serialized behind pending old-key commits — so the continuing stream
 * never lands on a record that never saw its boot.
 */
import {
  appendHistoryBatch,
  moveHistoryRecord,
  renewHistoryWriter,
  HISTORY_WRITER_RENEW_MS,
} from "./historyStorage.ts";
import { gameStorageKey, type BootedGame } from "./gameTypes.ts";
import { projectId } from "../../src/gameIdentity.ts";
import type { HistoryBatch } from "../../src/agent/history.ts";
import type { AgentLogEntry } from "./agent/agentLog.ts";

export interface HistoryControllerContext {
  readonly state: {
    historyPending: number;
    historyUnsaved: { batches: number; since: number } | null;
  };
  readonly getBootedGame: () => BootedGame | null;
  readonly scheduleRenewal?: (callback: () => void, delay: number) => () => void;
  readonly getProfile: () => string | null;
  readonly logAgent: (kind: AgentLogEntry["kind"], message: string) => void;
}

export interface HistoryController {
  /** Commit a posted batch; true → the worker gets its ack. */
  handleHistoryBatch(msg: { epoch: number; batch: HistoryBatch }): Promise<boolean>;
  /** Resolves when every commit posted so far has finished (ok or not). */
  drainHistoryCommits(): Promise<void>;
  stopWriterRenewal(): void;
}

export function useHistoryController(ctx: HistoryControllerContext): HistoryController {
  const commits = new Set<Promise<unknown>>();
  /** `${segment}:${batch}` → when the commit first failed. */
  const unsaved = new Map<string, number>();
  let activeKey = "";
  /** The session nonce owning the tape under `activeKey`. */
  let activeSession = "";
  /** A storage-key relocation in flight; commits queue behind it. */
  let relocating: Promise<void> | null = null;
  let writerSegment = "";
  let writerSession = "";
  let latestBootBatch = -1;
  let cancelRenewal: (() => void) | null = null;

  function stopWriterRenewal(): void {
    cancelRenewal?.();
    cancelRenewal = null;
    unsaved.delete(`lease:${writerSegment}`);
    writerSegment = "";
    syncUnsaved();
  }

  function armRenewal(): void {
    if (cancelRenewal || !writerSegment || !ctx.scheduleRenewal) return;
    cancelRenewal = ctx.scheduleRenewal(() => {
      cancelRenewal = null;
      const segment = writerSegment;
      const key = activeKey;
      const game = ctx.getBootedGame();
      if (!game || gameStorageKey(game) !== key) return;
      const run = renewHistoryWriter(key, segment)
        .then((renewed) => {
          if (activeKey !== key || writerSegment !== segment) return;
          if (renewed) unsaved.delete(`lease:${segment}`);
          else unsaved.set(`lease:${segment}`, unsaved.get(`lease:${segment}`) ?? Date.now());
          syncUnsaved();
        })
        .catch(() => {
          if (activeKey === key && writerSegment === segment) {
            unsaved.set(`lease:${segment}`, unsaved.get(`lease:${segment}`) ?? Date.now());
            syncUnsaved();
          }
        })
        .finally(() => {
          commits.delete(run);
          armRenewal();
        });
      commits.add(run);
    }, HISTORY_WRITER_RENEW_MS);
  }

  function syncUnsaved(): void {
    ctx.state.historyUnsaved = unsaved.size
      ? { batches: unsaved.size, since: Math.min(...unsaved.values()) }
      : null;
  }

  /** A segment id's session nonce — `s<nonce>.s<serial>` → `s<nonce>`. */
  const sessionOf = (segment: string): string => {
    const dot = segment.lastIndexOf(".");
    return dot < 0 ? segment : segment.slice(0, dot);
  };

  function handleHistoryBatch(msg: { epoch: number; batch: HistoryBatch }): Promise<boolean> {
    const batchKey = `${msg.batch.segment}:${msg.batch.batch}`;
    ctx.state.historyPending++;
    const pending = (async () => {
      if (relocating !== null) await relocating;
      const game = ctx.getBootedGame();
      const storageKey = game ? gameStorageKey(game) : "";
      if (storageKey !== activeKey) {
        if (
          activeKey !== "" &&
          storageKey !== "" &&
          sessionOf(msg.batch.segment) === activeSession
        ) {
          // Same live tape, new storage identity — a mid-session remix
          // converted the game. Move the record (behind the old key's
          // pending commits, ahead of this key's) rather than let the
          // continuing stream refuse against a record that never booted.
          const from = activeKey;
          const run = moveHistoryRecord(from, storageKey).finally(() => {
            if (relocating === run) relocating = null;
          });
          relocating = run;
          await run;
          activeKey = storageKey;
        } else {
          // A replaced worker's un-acked batches can never resend — the
          // ledger they left behind belongs to the previous session, not
          // this tape.
          stopWriterRenewal();
          unsaved.clear();
          activeKey = storageKey;
          syncUnsaved();
        }
      }
      if (!storageKey || game === null) return false;
      activeSession = sessionOf(msg.batch.segment);
      if (writerSession !== activeSession) {
        stopWriterRenewal();
        writerSession = activeSession;
        latestBootBatch = -1;
      }
      if (msg.batch.boot && msg.batch.batch > latestBootBatch) {
        stopWriterRenewal();
        latestBootBatch = msg.batch.batch;
        writerSegment = msg.batch.segment;
      }
      if (msg.batch.end && writerSegment === msg.batch.segment) stopWriterRenewal();
      armRenewal();
      const project = projectId(storageKey);
      if (project === null) return false;
      return appendHistoryBatch(storageKey, msg.batch, ctx.getProfile() ?? "", {
        project,
        revision: game.revision,
      });
    })()
      .then((committed) => {
        if (committed) unsaved.delete(batchKey);
        else {
          unsaved.set(batchKey, unsaved.get(batchKey) ?? Date.now());
          if (ctx.getBootedGame() !== null)
            ctx.logAgent("log", `history batch ${msg.batch.batch} not yet durable`);
        }
        syncUnsaved();
        return committed;
      })
      .catch((error) => {
        unsaved.set(batchKey, unsaved.get(batchKey) ?? Date.now());
        syncUnsaved();
        if (ctx.getBootedGame() !== null)
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

  return { handleHistoryBatch, drainHistoryCommits, stopWriterRenewal };
}

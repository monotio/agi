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
 * progress target. A batch whose segment still belongs to the active
 * session nonce then moves the stored record to the new target first —
 * serialized behind pending old-tape commits — so the continuing stream
 * never lands on a record that never saw its boot.
 *
 * A stored tape this version cannot extend (the pre-1.0 whole-tape record,
 * or a newer release's) is not a storage hiccup: no resend can ever land.
 * The controller says so once (`state.historyBlocked`), stops counting the
 * game's batches as unsaved and answers the worker's later posts without
 * touching storage — un-acked, since nothing became durable. The game
 * itself still saves. `startNewTimeline` is the player's way on; the old
 * record keeps its bytes (historyStorage.ts, `startNewTimeline`).
 *
 * The banner's Try now (`retrySave`) nudges the worker's resend and
 * reports Saving…, then Saved once nothing is owed, or the plain reason.
 */
import { PROFILES, type ProfileId } from "../../../src/runtime/profile.ts";
import {
  appendHistoryBatch,
  moveHistoryRecord,
  readOldTimeline,
  renewHistoryWriter,
  startNewTimeline as storeNewTimeline,
  UnextendableHistoryError,
  HISTORY_WRITER_RENEW_MS,
} from "./historyStorage.ts";
import type { BootedGame } from "../project/gameTypes.ts";
import { resolveProgressTarget } from "../project/progressBinding.ts";
import type { ProgressTarget } from "../project/progressTarget.ts";
import type { HistoryBatch } from "../../../src/agent/history.ts";
import type { AgentLogEntry } from "../agent/agentLog.ts";

/** The permanent refusal's one sentence, naming which release wrote the stored tape. */
function unextendableHistoryMessage(stored: "older" | "newer"): string {
  return `Your game is saved. This session's rewind timeline can't be stored: ${stored === "older" ? "an older" : "a newer"} timeline for this game is in a format this version can't extend.`;
}

/** The stored tape cannot be extended: the banner's message, until a new timeline starts. */
export interface HistoryBlock {
  readonly message: string;
}

/** The banner's Try now: in flight, landed with nothing owed, or the plain reason it did not. */
export type HistoryRetry =
  | { readonly status: "saving" }
  | { readonly status: "saved" }
  | { readonly status: "failed"; readonly reason: string };

/** How long Try now waits for the worker's resend to settle before saying so. */
const RETRY_ANSWER_MS = 10_000;

export interface HistoryControllerContext {
  readonly state: {
    historyPending: number;
    historyUnsaved: { batches: number; since: number } | null;
    historyBlocked?: HistoryBlock | null;
    historyRetry?: HistoryRetry | null;
  };
  readonly getBootedGame: () => BootedGame | null;
  readonly scheduleRenewal?: (callback: () => void, delay: number) => () => void;
  readonly getProfile: () => string | null;
  readonly logAgent: (kind: AgentLogEntry["kind"], message: string) => void;
  /** Ask the worker to resend its oldest un-acked batch now (`historyRetry`). */
  readonly retryWorker?: () => void;
}

export interface HistoryController {
  /** Commit a posted batch; true → the worker gets its ack. */
  handleHistoryBatch(msg: {
    epoch: number;
    batch: HistoryBatch;
    profile?: ProfileId;
  }): Promise<boolean>;
  /** Resolves when every commit posted so far has finished (ok or not). */
  drainHistoryCommits(): Promise<void>;
  stopWriterRenewal(): void;
  /** Try now: resend what is owed and report the outcome in `state.historyRetry`. */
  retrySave(): Promise<void>;
  /**
   * The player confirmed a new timeline beside a tape this version cannot
   * extend: open it, lift the block and let the worker resend its tape.
   */
  startNewTimeline(): Promise<void>;
  /** The unextendable stored tape as JSON of its records verbatim, or null. */
  readOldTimeline(): Promise<string | null>;
  /**
   * The running game's project was removed (BootedGame.removed): its
   * timeline can never be stored, so nothing is owed or retried for it.
   */
  forgetRemovedGame(): void;
}

function knownProfile(id: string | null): ProfileId | undefined {
  return id !== null && Object.hasOwn(PROFILES, id) ? (id as ProfileId) : undefined;
}

export function useHistoryController(ctx: HistoryControllerContext): HistoryController {
  const commits = new Set<Promise<unknown>>();
  /** `${segment}:${batch}` → when the commit first failed. */
  const unsaved = new Map<string, number>();
  /** The physical target the running tape writes under; null until bound. */
  let activeTarget: ProgressTarget | null = null;
  /** The session nonce owning the tape under `activeTarget`. */
  let activeSession = "";
  /** A tape relocation in flight; commits queue behind it. */
  let relocating: Promise<void> | null = null;
  let writerSegment = "";
  let writerSession = "";
  let latestBootBatch = -1;
  let cancelRenewal: (() => void) | null = null;
  /** The tape locator this version cannot extend; its batches skip storage. */
  let blockedLocator: string | null = null;
  /** The session that found it: a later session reads the stored tape afresh. */
  let blockedSession = "";
  /** The pending Try now, told of every commit and renewal that settles. */
  let retryWatch: ((outcome: "committed" | "refused") => void) | null = null;
  /** Why the last commit or renewal did not land — Try now's plain reason. */
  let lastFailure = "";

  function stopWriterRenewal(): void {
    cancelRenewal?.();
    cancelRenewal = null;
    unsaved.delete(`lease:${writerSegment}`);
    writerSegment = "";
    syncUnsaved();
  }

  /** Renew the live writer's lease once; its outcome feeds the ledger and Try now. */
  function renewWriter(): Promise<void> {
    const segment = writerSegment;
    const target = activeTarget;
    const game = ctx.getBootedGame();
    // The lease renews only while the live game still resolves to the tape
    // this writer owns — a switch leaves the old tape's lease to expire.
    const live = game === null ? null : resolveProgressTarget(game);
    if (
      !segment ||
      !game ||
      game.removed ||
      target === null ||
      live?.locator !== target.locator ||
      blockedLocator === target.locator
    )
      return Promise.resolve();
    const lease = `lease:${segment}`;
    const run = renewHistoryWriter(target, segment, game.historyLifetime)
      .then((renewed) => {
        if (activeTarget?.locator !== target.locator || writerSegment !== segment) return;
        if (renewed) unsaved.delete(lease);
        else refused(lease, "the timeline's writer could not be renewed");
        syncUnsaved();
        retryWatch?.(renewed ? "committed" : "refused");
      })
      .catch((error: unknown) => {
        if (activeTarget?.locator !== target.locator || writerSegment !== segment) return;
        if (error instanceof UnextendableHistoryError) block(target.locator, error);
        else {
          refused(lease, "browser storage refused the write");
          syncUnsaved();
          retryWatch?.("refused");
        }
      })
      .finally(() => commits.delete(run));
    commits.add(run);
    return run;
  }

  function armRenewal(): void {
    if (cancelRenewal || !writerSegment || !ctx.scheduleRenewal) return;
    cancelRenewal = ctx.scheduleRenewal(() => {
      cancelRenewal = null;
      void renewWriter().finally(armRenewal);
    }, HISTORY_WRITER_RENEW_MS);
  }

  /** A commit or renewal that did not land: listed from its first failure, with why. */
  function refused(entry: string, reason: string): void {
    unsaved.set(entry, unsaved.get(entry) ?? Date.now());
    lastFailure = reason;
  }

  function syncUnsaved(): void {
    ctx.state.historyUnsaved = unsaved.size
      ? { batches: unsaved.size, since: Math.min(...unsaved.values()) }
      : null;
    // A background resend that landed answers a failed Try now too.
    if (unsaved.size === 0 && ctx.state.historyRetry?.status === "failed")
      ctx.state.historyRetry = null;
  }

  /**
   * The game's stored tape cannot be extended: said once, the unsaved
   * ledger and the lease go (no resend can land), and later batches for
   * this locator are answered without storage until a new timeline starts.
   */
  function block(locator: string, error: UnextendableHistoryError): void {
    if (blockedLocator === locator) return;
    blockedLocator = locator;
    blockedSession = activeSession;
    stopWriterRenewal();
    unsaved.clear();
    syncUnsaved();
    const message = unextendableHistoryMessage(error.stored);
    ctx.state.historyBlocked = { message };
    ctx.logAgent("log", message);
  }

  function forgetRemovedGame(): void {
    stopWriterRenewal();
    unsaved.clear();
    syncUnsaved();
    ctx.state.historyRetry = null;
  }

  function unblock(): void {
    blockedLocator = null;
    ctx.state.historyBlocked = null;
  }

  /** A segment id's session nonce — `s<nonce>.s<serial>` → `s<nonce>`. */
  const sessionOf = (segment: string): string => {
    const dot = segment.lastIndexOf(".");
    return dot < 0 ? segment : segment.slice(0, dot);
  };

  function handleHistoryBatch(msg: {
    epoch: number;
    batch: HistoryBatch;
    profile?: ProfileId;
  }): Promise<boolean> {
    const batchKey = `${msg.batch.segment}:${msg.batch.batch}`;
    ctx.state.historyPending++;
    const pending = (async (): Promise<"committed" | "refused" | "blocked"> => {
      if (relocating !== null) await relocating;
      const game = ctx.getBootedGame();
      const target = game ? resolveProgressTarget(game) : null;
      if ((target?.locator ?? null) !== (activeTarget?.locator ?? null)) {
        if (
          activeTarget !== null &&
          target !== null &&
          sessionOf(msg.batch.segment) === activeSession
        ) {
          // Same live tape, new physical address — a mid-session remix
          // converted the game. Move the record (behind the old tape's
          // pending commits, ahead of this one's) rather than let the
          // continuing stream refuse against a record that never booted.
          const from = activeTarget;
          const run = moveHistoryRecord(from, target, game?.historyLifetime).finally(() => {
            if (relocating === run) relocating = null;
          });
          relocating = run;
          await run;
          // The live game may have moved on during the move: adopt the
          // destination as the tape owner only while it still resolves there.
          const now = ctx.getBootedGame();
          if (now !== null && resolveProgressTarget(now)?.locator === target.locator)
            activeTarget = target;
        } else {
          // A replaced worker's un-acked batches can never resend — the
          // ledger they left behind belongs to the previous session, not
          // this tape.
          stopWriterRenewal();
          unsaved.clear();
          unblock();
          ctx.state.historyRetry = null;
          activeTarget = target;
          syncUnsaved();
        }
      }
      if (target === null || game === null) return "refused";
      // A removed project stores nothing: its batches are answered without
      // storage, un-acked, as a blocked tape's are.
      if (game.removed) {
        forgetRemovedGame();
        return "blocked";
      }
      // A new session of the same game asks storage again, and says it again.
      if (blockedLocator === target.locator && sessionOf(msg.batch.segment) !== blockedSession)
        unblock();
      if (blockedLocator === target.locator) return "blocked";
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
      try {
        const committed = await appendHistoryBatch(
          target,
          msg.batch,
          // The batch names the running profile; the booted one is the same
          // interpreter once the page has heard of it.
          msg.profile ?? knownProfile(ctx.getProfile()),
          game.historyLifetime,
        );
        return committed ? "committed" : "refused";
      } catch (error) {
        if (!(error instanceof UnextendableHistoryError)) throw error;
        block(target.locator, error);
        return "blocked";
      }
    })()
      .then((outcome) => {
        if (outcome === "committed") unsaved.delete(batchKey);
        else if (outcome === "refused") {
          refused(batchKey, "browser storage refused the write");
          if (ctx.getBootedGame() !== null)
            ctx.logAgent("log", `history batch ${msg.batch.batch} not yet durable`);
        }
        syncUnsaved();
        if (outcome !== "blocked") retryWatch?.(outcome);
        return outcome === "committed";
      })
      .catch((error) => {
        refused(batchKey, "browser storage refused the write");
        syncUnsaved();
        retryWatch?.("refused");
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

  /**
   * Try now: nudge the worker's resend (and renew an unsaved lease), then
   * settle `state.historyRetry` — Saved once nothing is owed, the plain
   * reason on the first refusal, or that no answer came. Each resend that
   * lands nudges the next, after its ack has reached the worker.
   */
  async function retrySave(): Promise<void> {
    if (retryWatch !== null) return;
    ctx.state.historyRetry = { status: "saving" };
    const result = await new Promise<HistoryRetry>((resolve) => {
      const timer = setTimeout(
        () => settle({ status: "failed", reason: "the game has not answered yet" }),
        RETRY_ANSWER_MS,
      );
      const settle = (retry: HistoryRetry) => {
        clearTimeout(timer);
        retryWatch = null;
        resolve(retry);
      };
      retryWatch = (outcome) => {
        if (unsaved.size === 0) settle({ status: "saved" });
        else if (outcome === "refused") settle({ status: "failed", reason: lastFailure });
        else setTimeout(() => ctx.retryWorker?.(), 0);
      };
      if (unsaved.size === 0) return settle({ status: "saved" });
      ctx.retryWorker?.();
      if (unsaved.has(`lease:${writerSegment}`)) void renewWriter();
    });
    ctx.state.historyRetry = result;
  }

  async function startNewTimeline(): Promise<void> {
    const game = ctx.getBootedGame();
    const target = game ? resolveProgressTarget(game) : null;
    const profile = knownProfile(ctx.getProfile());
    if (!game || target === null || blockedLocator !== target.locator || profile === undefined)
      return;
    await storeNewTimeline(target, profile, game.historyLifetime);
    // A game switch during the write owns its own banner: this call clears
    // the block only while the same incarnation still carries it.
    const live = ctx.getBootedGame();
    if (live === null || resolveProgressTarget(live)?.locator !== target.locator) return;
    if (blockedLocator !== target.locator) return;
    unblock();
    ctx.logAgent("log", "Started a new rewind timeline; the old one is kept as it was.");
    ctx.retryWorker?.();
  }

  function readOldGameTimeline(): Promise<string | null> {
    const game = ctx.getBootedGame();
    const target = game ? resolveProgressTarget(game) : null;
    return target === null ? Promise.resolve(null) : readOldTimeline(target.locator);
  }

  return {
    handleHistoryBatch,
    drainHistoryCommits,
    stopWriterRenewal,
    retrySave,
    startNewTimeline,
    readOldTimeline: readOldGameTimeline,
    forgetRemovedGame,
  };
}

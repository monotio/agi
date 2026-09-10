/**
 * Autosave & progress controller.
 * Manages autosave storage, background flushes, worker synchronization,
 * and game resume / start-over lifecycle.
 */
import type { AgentLogEntry } from "./agent/agentLog.ts";
import type { LlmConfig } from "./agent/llmClient.ts";
import { gameRevision, updateBootedResources } from "./gameMetadata.ts";
import {
  autosaveKey,
  parseAutosaveRecord,
  writeAutosave,
  type AutosaveGame,
  type AutosaveRecord,
} from "./gameProgress.ts";
import { getCachedGameMeta, updateAuthoredGameFiles } from "./gameStorage.ts";
import {
  findInstalledFolder,
  type BootedGame,
  type InstalledGameDescriptor,
  type ProjectId,
} from "./gameTypes.ts";
import { resolveGameHash } from "../../src/games/knownGames.ts";
import type { EngineMenuState } from "../../src/runtime/engine.ts";
import { isProgressPreview } from "./progressPreview.ts";

export const LAST_GAME_KEY = "monotio_agi.lastGame";
const RESUME_CAPTION_MS = 10_000;

export { autosaveKey, writeAutosave };
export type { AutosaveRecord, AutosaveGame };

export function autosaveMatches(game: AutosaveGame, targetKey: string): boolean {
  if (game.installed) {
    const norm = targetKey.toLowerCase();
    return (
      game.hash?.toLowerCase() === norm ||
      game.alias?.toLowerCase() === norm ||
      resolveGameHash(targetKey) === game.hash
    );
  }
  return game.projectId === targetKey;
}

/** Every storage read is a maybe: a blocked, full or corrupt store is normal. */
export function readAutosave(targetKey: string): AutosaveRecord | null {
  try {
    const direct = parseAutosaveRecord(localStorage.getItem(autosaveKey(targetKey)));
    if (direct && autosaveMatches(direct.game, targetKey)) return direct;
    const resolved = resolveGameHash(targetKey);
    if (resolved && resolved !== targetKey) {
      const byHash = parseAutosaveRecord(localStorage.getItem(autosaveKey(resolved)));
      if (byHash) return byHash;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearAutosave(targetKey: string): void {
  try {
    localStorage.removeItem(autosaveKey(targetKey));
    const resolved = resolveGameHash(targetKey);
    if (resolved && resolved !== targetKey) {
      localStorage.removeItem(autosaveKey(resolved));
    }
    if (
      localStorage.getItem(LAST_GAME_KEY) === targetKey ||
      (resolved && localStorage.getItem(LAST_GAME_KEY) === resolved)
    ) {
      localStorage.removeItem(LAST_GAME_KEY);
    }
  } catch {
    /* nothing to clear in a store we cannot reach */
  }
}

/** The storage key of the game an autosave exists for, or null. Used by the picker. */
export function lastGameKey(): string | null {
  try {
    return localStorage.getItem(LAST_GAME_KEY);
  } catch {
    return null;
  }
}

export interface AutosaveControllerContext {
  readonly state: {
    installedGames?: readonly InstalledGameDescriptor[] | null | undefined;
    resumed: boolean;
  };
  readonly getBootedGame: () => BootedGame | null;
  readonly getWorker: () => Worker | null;
  readonly onAutosaveStored?: (cycle: number) => void;
  readonly onAutosaveRestored?: (room: number, egoX: number, egoY: number) => void;
  readonly logAgent: (kind: AgentLogEntry["kind"], message: string, details?: unknown) => void;
  readonly isInstalledGame: (targetGame: string) => boolean;
  readonly bootGame: (targetFolder: string) => Promise<void>;
  readonly bootAuthoredGame: (
    prompt: string,
    config: LlmConfig,
    options?: { projectId?: ProjectId; title?: string; useCached?: boolean },
  ) => Promise<void>;
  readonly configForGame: (projectId: ProjectId, config: LlmConfig) => LlmConfig;
}

export type AutosaveFlushResult =
  | { status: "saved"; cycle: number }
  | { status: "already_durable"; cycle: number }
  | { status: "not_checkpointable"; reason: string }
  | { status: "storage_failure"; error?: unknown }
  | { status: "timeout" };

export interface AutosaveController {
  readAutosave(targetKey: string): AutosaveRecord | null;
  clearAutosave(targetKey: string): void;
  lastAutosaveRecord(): AutosaveRecord | null;
  getAutosaveWrite(): Promise<boolean>;
  flushAutosave(timeoutMs?: number): Promise<boolean>;
  flushAutosaveDetailed(timeoutMs?: number): Promise<AutosaveFlushResult>;
  handleAutosave(msg: {
    image: string;
    preview?: unknown;
    menus?: EngineMenuState;
    cycle: number;
    room: number;
    files?: Record<string, Uint8Array>;
  }): void;
  handleFlushed(msg: {
    id: number;
    taken: boolean;
    cycle?: number | undefined;
    hasEngine?: boolean | undefined;
    modal?: boolean | undefined;
    textMode?: boolean | undefined;
    pictureShown?: boolean | undefined;
  }): void;
  handleRestored(msg: {
    ok: boolean;
    room?: number;
    egoX?: number;
    egoY?: number;
    message?: string;
  }): void;
  takeResumeState(files: Record<string, Uint8Array>): Promise<{
    restoreImage: string;
    restoreMenus?: EngineMenuState;
  }>;
  resumeLastGame(config: LlmConfig): Promise<boolean>;
  resumeFromRecord(record: AutosaveRecord, config: LlmConfig): Promise<boolean>;
  startOver(targetKey: string, config: LlmConfig): Promise<void>;
  drainFlushWaiters(): void;
  reset(): void;
  resetScreen(): void;
}

export function useAutosaveController(ctx: AutosaveControllerContext): AutosaveController {
  let lastAutosave: AutosaveRecord | null = null;
  let pendingResumeRecord: AutosaveRecord | null = null;
  let autosaveWrite: Promise<boolean> = Promise.resolve(true);
  const flushWaiters = new Map<number, (saved: boolean) => void>();
  const flushDetailedWaiters = new Map<number, (res: AutosaveFlushResult) => void>();
  let lastSeenCycle = 0;
  let nextFlushQueryId = 0;
  let resumeCaptionTimer: number | null = null;

  function showResumeCaption(): void {
    ctx.state.resumed = true;
    if (resumeCaptionTimer !== null) {
      clearTimeout(resumeCaptionTimer);
    }
    resumeCaptionTimer = setTimeout(() => {
      ctx.state.resumed = false;
      resumeCaptionTimer = null;
    }, RESUME_CAPTION_MS) as unknown as number;
  }

  async function storeAutosave(msg: {
    image: string;
    preview?: unknown;
    menus?: EngineMenuState;
    cycle: number;
    room: number;
    files?: Record<string, Uint8Array>;
  }): Promise<boolean> {
    try {
      const booted = ctx.getBootedGame();
      if (!booted) return false;
      const game = booted;
      if (msg.files) {
        if (booted.installed) return false;
        if (!(await updateAuthoredGameFiles(game.projectId!, msg.files))) return false;
        if (ctx.getBootedGame() !== game) return false;
        await updateBootedResources(game, msg.files);
      }
      const record: AutosaveRecord = {
        format: "monotio.agi.autosave",
        version: 1,
        image: String(msg.image),
        ...(isProgressPreview(msg.preview) ? { preview: msg.preview } : {}),
        ...(msg.menus ? { menus: msg.menus } : {}),
        cycle: Number(msg.cycle),
        room: Number(msg.room),
        savedAt: Date.now(),
        game: {
          installed: game.installed,
          revision: game.revision,
          ...(game.installed
            ? {
                ...(game.hash ? { hash: game.hash } : {}),
                ...(game.alias ? { alias: game.alias } : {}),
              }
            : { projectId: game.projectId! }),
        },
      };
      if (ctx.getBootedGame() !== game) return false;
      const stored = writeAutosave(localStorage, record);
      if (!stored) {
        ctx.logAgent("log", "autosave failed: browser storage rejected the save record");
        return false;
      }
      try {
        const resumePointer = game.installed ? (game.hash ?? game.alias!) : game.projectId!;
        localStorage.setItem(LAST_GAME_KEY, resumePointer);
      } catch (e) {
        ctx.logAgent("log", `autosave resume pointer failed: ${String(e)}`);
      }
      ctx.onAutosaveStored?.(stored.cycle);
      lastAutosave = stored;
      return true;
    } catch (error) {
      ctx.logAgent("log", `autosave failed: ${String(error)}`);
      return false;
    }
  }

  function handleAutosave(msg: {
    image: string;
    preview?: unknown;
    menus?: EngineMenuState;
    cycle: number;
    room: number;
    files?: Record<string, Uint8Array>;
  }): void {
    const game = ctx.getBootedGame();
    autosaveWrite = autosaveWrite
      .then(() => (ctx.getBootedGame() === game ? storeAutosave(msg) : false))
      .catch(() => false);
  }

  function handleFlushed(msg: {
    id: number;
    taken: boolean;
    cycle?: number | undefined;
    hasEngine?: boolean | undefined;
    modal?: boolean | undefined;
    textMode?: boolean | undefined;
    pictureShown?: boolean | undefined;
  }): void {
    const cycle = Number(msg.cycle ?? lastSeenCycle);
    lastSeenCycle = cycle;
    const legacyResolve = flushWaiters.get(Number(msg.id));
    const detailedResolve = flushDetailedWaiters.get(Number(msg.id));

    if (msg.taken) {
      void autosaveWrite.then((saved) => {
        legacyResolve?.(saved);
        if (saved) {
          detailedResolve?.({ status: "saved", cycle });
        } else {
          detailedResolve?.({ status: "storage_failure" });
        }
      });
      return;
    }

    const lastCycle = lastAutosave?.cycle;
    const isCleanOpening = cycle === 0;
    const isUnchanged = lastCycle !== undefined && cycle <= lastCycle;

    if (isCleanOpening || isUnchanged) {
      legacyResolve?.(true);
      detailedResolve?.({ status: "already_durable", cycle });
      return;
    }

    const reason =
      !msg.pictureShown && lastAutosave === null
        ? "Game has not displayed an initial room."
        : msg.modal
          ? "A dialog or menu is open."
          : msg.textMode
            ? "Game is in text mode."
            : "Interpreter is between transitions.";
    legacyResolve?.(false);
    detailedResolve?.({ status: "not_checkpointable", reason });
  }

  function handleRestored(msg: {
    ok: boolean;
    room?: number;
    egoX?: number;
    egoY?: number;
    message?: string;
  }): void {
    if (msg.ok) {
      ctx.onAutosaveRestored?.(Number(msg.room), Number(msg.egoX), Number(msg.egoY));
      showResumeCaption();
      ctx.logAgent("log", `Resumed the autosave in room ${Number(msg.room)}.`);
    } else {
      ctx.logAgent("log", `Autosave discarded (${String(msg.message)}); starting a fresh game.`);
      const booted = ctx.getBootedGame();
      if (booted) {
        clearAutosave(booted.installed ? (booted.hash ?? booted.alias!) : booted.projectId!);
      }
    }
  }

  async function takeResumeState(
    files: Record<string, Uint8Array>,
  ): Promise<{ restoreImage: string; restoreMenus?: EngineMenuState }> {
    const record = pendingResumeRecord;
    pendingResumeRecord = null;
    if (record && record.game.revision !== (await gameRevision(files))) {
      throw new Error(
        "This checkpoint belongs to a different revision of the game. Restore its matching project, or choose Start over to begin with the current game. Your checkpoint has been kept.",
      );
    }
    return {
      restoreImage: record?.image ?? "",
      ...(record?.menus ? { restoreMenus: record.menus } : {}),
    };
  }

  function flushAutosaveDetailed(timeoutMs = 2000): Promise<AutosaveFlushResult> {
    const worker = ctx.getWorker();
    if (!worker) return Promise.resolve({ status: "already_durable", cycle: 0 });
    return new Promise<AutosaveFlushResult>((resolve) => {
      const id = ++nextFlushQueryId;
      let settled = false;
      const done = (res: AutosaveFlushResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        flushWaiters.delete(id);
        flushDetailedWaiters.delete(id);
        resolve(res);
      };
      const timer = setTimeout(() => {
        done({ status: "timeout" });
      }, timeoutMs);
      flushDetailedWaiters.set(id, done);
      worker.postMessage({ type: "flush", id });
    });
  }

  async function flushAutosave(timeoutMs = 500): Promise<boolean> {
    const res = await flushAutosaveDetailed(timeoutMs);
    return res.status === "saved" || res.status === "already_durable";
  }

  function lastAutosaveRecord(): AutosaveRecord | null {
    return lastAutosave;
  }

  function getAutosaveWrite(): Promise<boolean> {
    return autosaveWrite;
  }

  async function resumeLastGame(config: LlmConfig): Promise<boolean> {
    const key = lastGameKey();
    if (!key) return false;
    const record = readAutosave(key);
    if (!record) return false;
    const available = record.game.installed
      ? ctx.isInstalledGame(record.game.hash ?? record.game.alias ?? key)
      : Boolean(record.game.projectId && getCachedGameMeta(record.game.projectId));
    if (!available) {
      ctx.logAgent("log", `Autosave for "${key}" has no game to boot; starting fresh.`);
      clearAutosave(key);
      return false;
    }
    return resumeFromRecord(record, config);
  }

  async function resumeFromRecord(record: AutosaveRecord, config: LlmConfig): Promise<boolean> {
    if (record.game.installed) {
      const target = record.game.hash ?? record.game.alias ?? "";
      if (!ctx.isInstalledGame(target)) return false;
      pendingResumeRecord = record;
      try {
        await ctx.bootGame(findInstalledFolder(ctx.state.installedGames, target));
        return true;
      } finally {
        pendingResumeRecord = null;
      }
    }
    const projectId = record.game.projectId;
    if (!projectId || !getCachedGameMeta(projectId)) return false;
    pendingResumeRecord = record;
    try {
      await ctx.bootAuthoredGame("", ctx.configForGame(projectId, config), {
        projectId,
        useCached: true,
      });
      return true;
    } finally {
      pendingResumeRecord = null;
    }
  }

  async function startOver(targetKey: string, config: LlmConfig): Promise<void> {
    const record = readAutosave(targetKey);
    clearAutosave(targetKey);
    pendingResumeRecord = null;
    ctx.state.resumed = false;
    if (resumeCaptionTimer !== null) {
      clearTimeout(resumeCaptionTimer);
      resumeCaptionTimer = null;
    }
    if (!record) {
      ctx.logAgent("log", `startOver: no autosave found for "${targetKey}"; continuing`);
    }
    if (record?.game.installed ?? ctx.isInstalledGame(targetKey)) {
      await ctx.bootGame(findInstalledFolder(ctx.state.installedGames, targetKey));
    } else if (getCachedGameMeta(targetKey)) {
      await ctx.bootAuthoredGame("", ctx.configForGame(targetKey, config), {
        projectId: targetKey,
        useCached: true,
      });
    }
  }

  function drainFlushWaiters(): void {
    for (const done of flushWaiters.values()) done(false);
    for (const done of flushDetailedWaiters.values()) done({ status: "timeout" });
    flushWaiters.clear();
    flushDetailedWaiters.clear();
  }

  function resetScreen(): void {
    lastAutosave = null;
    ctx.state.resumed = false;
    if (resumeCaptionTimer !== null) {
      clearTimeout(resumeCaptionTimer);
      resumeCaptionTimer = null;
    }
  }

  function reset(): void {
    resetScreen();
    pendingResumeRecord = null;
  }

  return {
    readAutosave,
    clearAutosave,
    lastAutosaveRecord,
    getAutosaveWrite,
    flushAutosave,
    flushAutosaveDetailed,
    handleAutosave,
    handleFlushed,
    handleRestored,
    takeResumeState,
    resumeLastGame,
    resumeFromRecord,
    startOver,
    drainFlushWaiters,
    reset,
    resetScreen,
  };
}

import type { LibraryMetadata } from "./gameMetadata.ts";
import type { ScreenObjectState } from "../../src/runtime/engine.ts";

/** Canonical identifier for an authored browser workspace / mutable user project. */
export type ProjectId = string;

export interface CachedGameMeta {
  library?: LibraryMetadata | undefined;
  projectId: ProjectId;
  templateId?: string | undefined;
  generation?: number | undefined;
  title: string;
  authoredAt: string;
  provider: string;
  model: string;
  sessionId?: string | undefined;
  imported?: boolean | undefined;
  roomGeneration?: boolean | undefined;
}

export interface CachedGameData extends CachedGameMeta {
  files: Record<string, Uint8Array>;
  words: [string, number][];
  transcript?: unknown[] | undefined;
  authoringState?: Record<string, unknown> | undefined;
  conversationHistory?: { provider: string; model: string; transcript: unknown[] }[] | undefined;
}

export interface BootedGame {
  readonly installed: boolean;
  readonly title: string;
  revision: string;
  files: Record<string, Uint8Array>;
  words: [string, number][];
  readonly hash?: string | undefined;
  readonly alias?: string | undefined;
  readonly folder?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  authoredGame?: CachedGameData | undefined;
}

export interface InstalledGameDescriptor {
  readonly hash: string;
  readonly alias: string;
  readonly title: string;
  readonly author?: string | undefined;
  readonly walkthroughLabel?: string | undefined;
  readonly wordsSha256?: string | undefined;
  readonly objectSha256?: string | undefined;
  readonly folder?: string | undefined;
}

export interface CurrentGame {
  readonly installed: boolean;
  readonly title: string;
  readonly revision: string;
  readonly hash?: string | undefined;
  readonly alias?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly folder?: string | undefined;
}

/**
 * One storage identity for a game's progress: installed editions scope by
 * folder (two folders can share a WORDS.TOK hash), authored projects by id.
 * Save slots, autosaves and the last-game pointer must all resolve to this.
 */
export function gameStorageKey(game: {
  installed: boolean;
  folder?: string | null | undefined;
  hash?: string | null | undefined;
  alias?: string | null | undefined;
  projectId?: string | null | undefined;
}): string {
  return game.installed ? (game.folder ?? game.hash ?? game.alias ?? "") : (game.projectId ?? "");
}

export function findInstalledFolder(
  installedGames: readonly (string | InstalledGameDescriptor)[] | null | undefined,
  aliasOrHash: string,
): string {
  const norm = aliasOrHash.toLowerCase();
  const match = (installedGames ?? []).find((g) => {
    if (typeof g === "string") return g.toLowerCase() === norm;
    return (
      g.hash.toLowerCase() === norm ||
      g.alias.toLowerCase() === norm ||
      g.folder?.toLowerCase() === norm ||
      g.wordsSha256?.toLowerCase() === norm
    );
  });
  return typeof match === "string" ? match : (match?.folder ?? aliasOrHash);
}

export interface Frame {
  visual: Uint8Array;
  priority: Uint8Array;
  /** 40x25 [char, attr] text cells. */
  text: Uint8Array;
  /** Text row where picture row 0 is presented. */
  picRow: number;
  /** Interpreter cycle this frame completed, when the worker reports it. */
  cycle?: number;
  /** Container patch revision at capture; part of the frame's identity. */
  patchGeneration?: number;
  /**
   * Per-pixel owning screen object (num + 1, 0 = background); present only
   * while the worker's ownership debug channel is armed.
   */
  ownership?: Uint16Array;
  /** Live screen-object table; present only while the objects channel is armed. */
  objects?: ScreenObjectState[];
  /**
   * Picture-only visual + priority (no screen objects); present only while the
   * picture debug channel is armed — the exploded view layers this as the wall.
   */
  picVisual?: Uint8Array;
  picPriority?: Uint8Array;
}

/** Decodes 40x25 [char, attr] text buffer into 25 display rows. */
export function decodeTextRows(text: Uint8Array): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 25; r++) {
    let line = "";
    for (let c = 0; c < 40; c++) {
      const ch = text[(r * 40 + c) * 2]!;
      line += ch === 0 ? " " : ch >= 0x80 ? "#" : String.fromCharCode(ch);
    }
    rows.push(line);
  }
  return rows;
}

import type { LibraryMetadata } from "./gameMetadata.ts";

/** Canonical identifier for an authored browser workspace / mutable user project. */
export type ProjectId = string;

export interface CachedGameMeta {
  library?: LibraryMetadata | undefined;
  projectId: ProjectId;
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
  readonly revision: string;
  files: Record<string, Uint8Array>;
  words: [string, number][];
  readonly hash?: string | undefined;
  readonly alias?: string | undefined;
  readonly folder?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  authoredGame?: CachedGameData | undefined;
}

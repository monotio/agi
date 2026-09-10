import type { LibraryMetadata } from "./gameMetadata.ts";

export interface CachedGameMeta {
  library?: LibraryMetadata | undefined;
  gameId: string;
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

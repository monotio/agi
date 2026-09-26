/**
 * The shelf's one "Details" dialog: a card's ⋯ menu fills it and the shelf
 * shows it, so reading details never changes a card's height.
 */
import { ref } from "vue";
import type { CachedGameMeta } from "../gameStorage.ts";
import type { GameCatalogEntry } from "../gameCatalog.ts";

export interface CardDetails {
  title: string;
  description?: string | undefined;
  rows: readonly (readonly [term: string, value: string])[];
  testId?: string | undefined;
}

export const shownDetails = ref<CardDetails>();

export function showDetails(details: CardDetails): void {
  shownDetails.value = details;
}

function rows(entries: [string, string | undefined][]): [string, string][] {
  return entries.filter((entry): entry is [string, string] => Boolean(entry[1]));
}

export function libraryDetails(game: CachedGameMeta): CardDetails {
  const library = game.library;
  return {
    title: game.title,
    description: library?.description,
    rows: rows([
      ["By", library?.author],
      ["License", library?.license],
      ["Version", library?.catalog?.version],
    ]),
    testId: `game-details-${game.projectId}`,
  };
}

export function catalogDetails(entry: GameCatalogEntry): CardDetails {
  return {
    title: entry.title,
    description: entry.description,
    rows: rows([
      ["By", entry.author],
      ["License", entry.license],
      ["Version", entry.version],
    ]),
  };
}

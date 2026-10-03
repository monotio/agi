/**
 * The shelf's one "Details" dialog: a card's ⋯ menu fills it and the shelf
 * shows it, so reading details never changes a card's height.
 */
import { ref } from "vue";
import type { CachedGameMeta } from "../project/gameStorage.ts";
import type { GameCatalogEntry } from "../library/gameCatalog.ts";
import type { ProjectId } from "../project/gameTypes.ts";

/**
 * Which earlier sources the dialog's Earlier progress section shows:
 * `candidates` scopes the listing to a saved game's own earlier spellings
 * (read context, never an ownership claim), `capture` reads one exact
 * removal-capture record, and `all` lists every source this browser holds.
 */
export type EarlierDetailsContext =
  | { readonly kind: "candidates"; readonly candidates: readonly string[] }
  | { readonly kind: "capture"; readonly recoveryId: string }
  | { readonly kind: "all" };

export interface CardDetails {
  title: string;
  description?: string | undefined;
  rows: readonly (readonly [term: string, value: string])[];
  testId?: string | undefined;
  /**
   * A stored game's details are live: the dialog re-reads this project from
   * the library so the Interpreter and Opening rows reflect a check or a
   * profile change that just finished. Catalog entries have no live copy.
   */
  projectId?: ProjectId | undefined;
  /** When set, the dialog carries an Earlier progress section for this context. */
  earlier?: EarlierDetailsContext | undefined;
  /** The control that opened the dialog; it takes focus back on close. */
  returnFocus?: HTMLElement | undefined;
}

export const shownDetails = ref<CardDetails>();

export function showDetails(details: CardDetails): void {
  shownDetails.value = details;
}

function rows(entries: [string, string | undefined][]): [string, string][] {
  return entries.filter((entry): entry is [string, string] => Boolean(entry[1]));
}

export function libraryDetails(
  game: CachedGameMeta,
  options?: { returnFocus?: HTMLElement | undefined },
): CardDetails {
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
    projectId: game.projectId,
    // The saved game's own storage spelling as a read candidate — context
    // only, never an ownership claim.
    earlier: { kind: "candidates", candidates: [game.projectId] },
    returnFocus: options?.returnFocus,
  };
}

/**
 * The Library footer's all-sources view: the one Details dialog listing every
 * earlier source this browser holds.
 */
export function earlierProgressDetails(options?: {
  returnFocus?: HTMLElement | undefined;
}): CardDetails {
  return {
    title: "Earlier progress",
    rows: [],
    testId: "earlier-progress-details",
    earlier: { kind: "all" },
    returnFocus: options?.returnFocus,
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

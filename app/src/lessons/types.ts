/**
 * Studio lessons: Help guide topics that open a Studio on one resource of the
 * current game, with a "Try this" card and an optional challenge the app
 * checks after a Keep. A lesson set belongs to one catalog game; its content
 * lives beside the game, and the app registers it by catalog id
 * (registry.ts). A challenge's badge is per-viewer app state, never game
 * score (lessonStorage.ts).
 */
import type { AgiProfile } from "../../../src/runtime/profile.ts";

export type LessonTarget =
  | { readonly studio: "room"; readonly picture: number }
  | { readonly studio: "sprite"; readonly view: number };

export interface LessonVerifyInput {
  readonly kind: "picture" | "view";
  readonly num: number;
  /** The resource's bytes when the studio opened. */
  readonly before: Uint8Array;
  /** The bytes just kept. */
  readonly after: Uint8Array;
  /** The annotated picture source the studio opened on, when trusted. */
  readonly beforeSource?: string;
  /** The annotated picture source just kept. */
  readonly afterSource?: string;
  readonly profile: AgiProfile;
}

export interface StudioLesson {
  /** Stable: badges are stored under it, e.g. "ad-gallery-recipe". */
  readonly id: string;
  readonly title: string;
  /** One line for the Help guide. */
  readonly teaser: string;
  /** The "Try this" card: 2-4 short steps. */
  readonly steps: readonly string[];
  readonly open: LessonTarget;
  readonly challenge?: {
    readonly prompt: string;
    verify(input: LessonVerifyInput): { readonly ok: boolean; readonly hint?: string };
  };
}

export interface LessonSet {
  /** The catalog entry the lessons belong to, e.g. "adventure-department". */
  readonly catalogId: string;
  /** The Help guide section title, e.g. "Adventure Department: under the hood". */
  readonly title: string;
  readonly lessons: readonly StudioLesson[];
}

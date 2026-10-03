/**
 * What an explainer says (UiExplain.vue): a name of one or two words, one
 * short sentence, and where Help says more. Registries of these live beside
 * the surfaces that use them (app/src/studio/studioTerms.ts); the component
 * itself knows nothing of any one surface.
 */

import { shallowRef } from "vue";

/** A Help guide section and topic (helpContent.ts). */
export interface HelpTarget {
  readonly section: string;
  readonly topic: string;
}

export interface Explainer {
  /** The thing's name, one or two words: the popover's heading. */
  readonly name: string;
  /** One or two short sentences, at most 140 characters. */
  readonly says: string;
  /** Original AGI terminology shown on hover. */
  readonly technical?: string;
  /** Where "Learn more" opens the Help guide. */
  readonly help: HelpTarget;
}

/**
 * Set to 0 on an element, every explainer inside it (UiExplain.vue) keeps its
 * invisible target to its dot, so a measure of what overflows counts only
 * what shows.
 */
export const TARGET_PROPERTY = "--explain-target";

/** The one explainer open on the page: opening another closes this one. */
export const openExplainer = shallowRef<symbol | null>(null);

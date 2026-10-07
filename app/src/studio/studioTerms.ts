/**
 * The Studios' explainers (UiExplain.vue): every term a label carries an ⓘ
 * for, its name, its one-sentence explanation and the Help topic "Learn
 * more" opens. A label names the thing in one or two words; the sentence
 * says what it is or does, and the Help topic has the page. Labels say
 * "Depth", "walk lines" and "steps"; the sentences keep AGI's own words
 * (priority, drawing command) where a modder would search for them.
 * app/test/studio-terms.test.ts holds every entry to the copy rules and
 * checks that every Help topic exists.
 */

import { VOCABULARY } from "../../../src/vocabulary.ts";
import type { Explainer, HelpTarget } from "../ui/explain.ts";
import { keyLabel } from "../ui/keyLabel.ts";

const topic = (id: string): HelpTarget => ({ section: "creating", topic: id });

export const STUDIO_TERMS = {
  "lens-lock-depth": {
    name: "Priority locked",
    says: "The Visual lens paints what players see. Moving an item carries its priority along.",
    help: topic("studio-locks"),
  },
  "lens-lock-art": {
    name: "Visual locked",
    says: "The Priority lens paints only priority: distance, walls, water, triggers and gates. Moving a whole item takes its visual along.",
    help: topic("studio-locks"),
  },
  "item-lock": {
    name: VOCABULARY.lock.label,
    says: VOCABULARY.lock.help,
    technical: VOCABULARY.lock.technical,
    help: topic("studio-locks"),
  },
  depth: {
    name: VOCABULARY.depth.label,
    says: VOCABULARY.depth.help,
    technical: VOCABULARY.depth.technical,
    help: topic("studio-depth"),
  },
  bands: {
    name: VOCABULARY.depthBand.label,
    says: VOCABULARY.depthBand.help,
    technical: VOCABULARY.depthBand.technical,
    help: topic("studio-depth"),
  },
  "walk-lines": {
    name: "Walls, water, triggers, gates",
    says: VOCABULARY.walk.help,
    technical: VOCABULARY.walk.technical,
    help: topic("studio-walk"),
  },
  order: {
    name: VOCABULARY.drawOrder.label,
    says: VOCABULARY.drawOrder.help,
    technical: VOCABULARY.drawOrder.technical,
    help: topic("studio-order"),
  },
  step: {
    name: VOCABULARY.step.label,
    says: VOCABULARY.step.help,
    technical: VOCABULARY.step.technical,
    help: topic("studio-order"),
  },
  "insert-at": {
    name: "Drawing here",
    says: "New shapes draw at the marker; shapes after it paint over them.",
    help: topic("studio-order"),
  },
  loose: {
    name: "Loose steps",
    says: `Steps waiting to form an item. Select them and press ${keyLabel("Mod+G")} to make one.`,
    help: topic("studio-order"),
  },
  group: {
    name: VOCABULARY.group.label,
    says: VOCABULARY.group.help,
    technical: VOCABULARY.group.technical,
    help: topic("studio-select"),
  },
  ungroup: {
    name: VOCABULARY.ungroup.label,
    says: VOCABULARY.ungroup.help,
    technical: VOCABULARY.ungroup.technical,
    help: topic("studio-select"),
  },
  fill: {
    name: "Fill",
    says: "On white, the bucket fills the area. On a colour, it recolours the shape that painted it, everywhere that shape painted.",
    help: topic("studio-fill"),
  },
  stipple: {
    name: VOCABULARY.brush.label,
    says: VOCABULARY.brush.help,
    technical: VOCABULARY.brush.technical,
    help: topic("studio-tools"),
  },
  ghost: {
    name: VOCABULARY.standIn.label,
    says: VOCABULARY.standIn.help,
    technical: VOCABULARY.standIn.technical,
    help: topic("studio-ghost"),
  },
  feet: {
    name: VOCABULARY.feet.label,
    says: VOCABULARY.feet.help,
    technical: VOCABULARY.feet.technical,
    help: topic("sprites-feet"),
  },
  "floor-estimate": {
    name: "Floor (estimate)",
    says: "A guess from the hero's size and the walk lines; a test walk shows where the game really goes.",
    help: topic("studio-walk"),
  },
  "game-state": {
    name: "Use my game state",
    says: "The test walk starts with the flags and variables of your game as it stands now.",
    help: topic("studio-walk"),
  },
  "door-planned": {
    name: "Planned",
    says: "The plan names this exit. Add a way to reach it in the room's LOGIC.",
    help: topic("studio-walk"),
  },
  "door-script": {
    name: "In LOGIC",
    says: "This exit is written in the room's LOGIC. Edit the LOGIC or tell the agent to change it.",
    help: topic("studio-walk"),
  },
  follows: {
    name: "Follows",
    says: "Drag the door's round handle onto an item. The door moves with it.",
    help: topic("studio-walk"),
  },
  rebuilt: {
    name: "Rebuilt",
    says: "These steps come from the game's bytes. Your first edit starts saving their source.",
    help: topic("studio-source"),
  },
  issues: {
    name: "Issues",
    says: "Some notes in the picture text are unreadable; the picture itself is fine.",
    help: topic("studio-source"),
  },
  "view-only": {
    name: "View only",
    says: "Reload the game to edit this part.",
    help: topic("studio-keep"),
  },
  keep: {
    name: VOCABULARY.saved.label,
    says: VOCABULARY.saved.help,
    technical: VOCABULARY.saved.technical,
    help: topic("studio-keep"),
  },
  loops: {
    name: VOCABULARY.loop.label,
    says: VOCABULARY.loop.help,
    technical: VOCABULARY.loop.technical,
    help: topic("sprites-loops"),
  },
  mirror: {
    name: VOCABULARY.mirrorLoop.label,
    says: VOCABULARY.mirrorLoop.help,
    technical: VOCABULARY.mirrorLoop.technical,
    help: topic("sprites-mirror"),
  },
  transparent: {
    name: VOCABULARY.transparentColour.label,
    says: VOCABULARY.transparentColour.help,
    technical: VOCABULARY.transparentColour.technical,
    help: topic("sprites-transparent"),
  },
  backdrop: {
    name: VOCABULARY.background.label,
    says: VOCABULARY.background.help,
    technical: VOCABULARY.background.technical,
    help: topic("sprites-transparent"),
  },
  onion: {
    name: VOCABULARY.onionSkin.label,
    says: VOCABULARY.onionSkin.help,
    technical: VOCABULARY.onionSkin.technical,
    help: topic("sprites-loops"),
  },
  "mirror-bit": {
    name: VOCABULARY.mirrorLoop.label,
    says: VOCABULARY.mirrorLoop.help,
    technical: VOCABULARY.mirrorLoop.technical,
    help: topic("sprites-mirror"),
  },
  "shared-view": {
    name: "Shared character",
    says: "Editing this VIEW changes it in every room that uses it.",
    help: topic("sprites-loops"),
  },
  "recolour-scope": {
    name: "Recolour",
    says: "Swaps one colour for another in this cel, this loop or the whole character.",
    help: topic("sprites-tools"),
  },
  shift: {
    name: "Shift",
    says: "Pixels wrap around the edges; shifting up or down moves the feet.",
    help: topic("sprites-tools"),
  },
} as const satisfies Record<string, Explainer>;

export type StudioTerm = keyof typeof STUDIO_TERMS;

/** An explainer's props for `<UiExplain v-bind="explain('depth')" />`. */
export function explain(term: StudioTerm): Explainer & { readonly term: StudioTerm } {
  return { term, ...STUDIO_TERMS[term] };
}

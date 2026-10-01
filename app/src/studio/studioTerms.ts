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

import type { Explainer, HelpTarget } from "../ui/explain.ts";
import { keyLabel } from "../ui/keyLabel.ts";

const topic = (id: string): HelpTarget => ({ section: "creating", topic: id });

export const STUDIO_TERMS = {
  "lens-lock-depth": {
    name: "Depth & walk lines",
    says: "The Art lens paints only what the player sees. Depth and walk lines stay as they are. Moving a whole item takes its lines along.",
    help: topic("studio-locks"),
  },
  "lens-lock-art": {
    name: "Art locked",
    says: "The Depth lens paints only depth. The art stays as it is. Moving a whole item takes its art along.",
    help: topic("studio-locks"),
  },
  "lens-lock-walk": {
    name: "Walk lens locks",
    says: "The Walk lens draws walk lines 0–3 only. Art and depth stay as they are. Moving a whole item takes them along.",
    help: topic("studio-locks"),
  },
  "item-lock": {
    name: "Locked item",
    says: "A locked item keeps its place and colours until you unlock it.",
    help: topic("studio-locks"),
  },
  depth: {
    name: "Depth",
    says: "What stands in front. Lower on the screen is nearer.",
    help: topic("studio-depth"),
  },
  bands: {
    name: "Depth band",
    says: "Each row of the screen has a depth. A character's depth comes from the row its feet are on.",
    help: topic("studio-depth"),
  },
  "walk-lines": {
    name: "Walk",
    says: "Where characters can go.",
    help: topic("studio-walk"),
  },
  order: {
    name: "Draw order",
    says: "The order a picture draws its items. Later items cover earlier ones.",
    help: topic("studio-order"),
  },
  step: {
    name: "Step",
    says: "One drawing command. A picture draws its steps in order.",
    help: topic("studio-order"),
  },
  "insert-at": {
    name: "Where new shapes go",
    says: "New shapes go here in the draw order; later steps paint over them.",
    help: topic("studio-order"),
  },
  loose: {
    name: "Loose steps",
    says: `Steps that belong to no item yet. Select them and press ${keyLabel("Mod+G")} to make one.`,
    help: topic("studio-order"),
  },
  group: {
    name: "Group",
    says: "Group joins neighbouring items into one item. Ungroup splits it into the parts it was made from.",
    help: topic("studio-select"),
  },
  ungroup: {
    name: "Ungroup",
    says: "Group joins neighbouring items into one item. Ungroup splits it into the parts it was made from.",
    help: topic("studio-select"),
  },
  fill: {
    name: "Fill",
    says: "An AGI fill spreads over white only, so it has to come before the colour under it.",
    help: topic("studio-fill"),
  },
  stipple: {
    name: "Speckled",
    says: "Paints with a round or square pen; Speckled scatters dots.",
    help: topic("studio-tools"),
  },
  ghost: {
    name: "Stand-in",
    says: "A still figure you place in the room to see what hides it and where it can walk.",
    help: topic("studio-ghost"),
  },
  feet: {
    name: "Feet",
    says: "The game places a character by its feet, the bottom row of its cel.",
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
    says: "The world plan names this exit. Add a way to reach it in the room's script.",
    help: topic("studio-walk"),
  },
  "door-script": {
    name: "In script",
    says: "This exit is written in the room's LOGIC. Edit its LOGIC or tell the agent what to change.",
    help: topic("studio-walk"),
  },
  follows: {
    name: "Follows",
    says: "Drag the door's round handle onto an item. The door moves with it.",
    help: topic("studio-walk"),
  },
  "ask-scope": {
    name: "Ask",
    says: "The AI changes only the selected items and only the unlocked planes; you accept or reject it.",
    help: topic("studio-ask"),
  },
  "ask-cels": {
    name: "Ask",
    says: "The AI changes only the selected cel or loop and keeps the other loops; you accept or reject it.",
    help: topic("sprites-ask"),
  },
  rebuilt: {
    name: "Rebuilt",
    says: "These steps come from the game's bytes. Your first edit saves their source.",
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
    name: "Keep",
    says: "Keep saves your changes into the game; undo still works afterwards.",
    help: topic("studio-keep"),
  },
  loops: {
    name: "Loops",
    says: "One direction a VIEW faces, like walking left.",
    help: topic("sprites-loops"),
  },
  mirror: {
    name: "Mirror loop",
    says: "Shows another loop flipped. Edit both changes the pair; editing one gives it its own cels.",
    help: topic("sprites-mirror"),
  },
  transparent: {
    name: "Transparent colour",
    says: "Pixels in this colour show the room behind the character.",
    help: topic("sprites-transparent"),
  },
  backdrop: {
    name: "Background",
    says: "The colour behind the cel while you draw. The game ignores it.",
    help: topic("sprites-transparent"),
  },
  onion: {
    name: "Onion skin",
    says: "Shows the cels before and after this one faintly, to line up the animation.",
    help: topic("sprites-loops"),
  },
  "mirror-bit": {
    name: "Mirror bit",
    says: "A flag in the VIEW file that tells the game to draw this loop flipped.",
    help: topic("sprites-mirror"),
  },
  "shared-view": {
    name: "Shared character",
    says: "Changes to this VIEW show in every room that uses it.",
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

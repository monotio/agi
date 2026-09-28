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
    name: "Depth locked",
    says: "The Art lens keeps depth as it is, so a change here moves only what the player sees.",
    help: topic("studio-locks"),
  },
  "lens-lock-art": {
    name: "Art locked",
    says: "The Depth lens keeps the art as it is, so a change here moves only what stands in front.",
    help: topic("studio-locks"),
  },
  "lens-lock-walk": {
    name: "Walk lens locks",
    says: "The Walk lens keeps art and depth as they are and draws walk lines 0–3 only.",
    help: topic("studio-locks"),
  },
  "item-lock": {
    name: "Locked item",
    says: "A locked item keeps its place and colours until you unlock it.",
    help: topic("studio-locks"),
  },
  depth: {
    name: "Depth",
    says: "Depth says what stands in front: a bigger number is nearer the player. AGI calls this priority.",
    help: topic("studio-depth"),
  },
  bands: {
    name: "Bands",
    says: "Bands are the depth values the screen gives by height: lower on the screen means nearer.",
    help: topic("studio-depth"),
  },
  "walk-lines": {
    name: "Walk lines",
    says: "Values 0–3 steer the hero: 0 blocks, 1 blocks until a flag, 2 signals the script, 3 is water.",
    help: topic("studio-walk"),
  },
  order: {
    name: "Draw order",
    says: "The picture paints itself top to bottom of this list, so a later item covers an earlier one.",
    help: topic("studio-order"),
  },
  step: {
    name: "Step",
    says: "Each step is one AGI drawing command, the way the game itself draws the picture.",
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
    says: "Group joins neighbours in the draw order into one item and keeps every pixel as it is.",
    help: topic("studio-select"),
  },
  ungroup: {
    name: "Ungroup",
    says: "Ungroup splits an item back into the parts it was grouped from, or into its drawing elements.",
    help: topic("studio-select"),
  },
  fill: {
    name: "Fill",
    says: "An AGI fill spreads over white only, so it has to come before the colour under it.",
    help: topic("studio-fill"),
  },
  stipple: {
    name: "Stipple",
    says: "Stipple paints a dotted pattern, the way AGI brushes do; Pattern picks which dots.",
    help: topic("studio-tools"),
  },
  ghost: {
    name: "Ghost",
    says: "A still figure from the game's views, dropped where you like, to see what hides it.",
    help: topic("studio-ghost"),
  },
  feet: {
    name: "Feet",
    says: "The game places a character by its feet, the bottom row of the cel, and reads depth there.",
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
    says: "This exit is written in the room's script; edit it as text or ask the AI.",
    help: topic("studio-walk"),
  },
  follows: {
    name: "Follows",
    says: "Drag the door's round handle onto art, and the door moves with it when you Keep.",
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
    says: "Studio rebuilt these steps from the game's bytes; your first Keep makes them the source.",
    help: topic("studio-source"),
  },
  issues: {
    name: "Issues",
    says: "Some notes in the picture text are unreadable; the picture itself is fine.",
    help: topic("studio-source"),
  },
  "view-only": {
    name: "View only",
    says: "Edits wait right now: a Keep is running, or the game needs a reload first.",
    help: topic("studio-keep"),
  },
  keep: {
    name: "Keep",
    says: "Keep saves your changes into the game; undo still works afterwards.",
    help: topic("studio-keep"),
  },
  loops: {
    name: "Loops",
    says: "A loop is one facing of the character; its cels are the frames of that walk or wave.",
    help: topic("sprites-loops"),
  },
  mirror: {
    name: "Mirror loop",
    says: "A mirror loop shows its partner flipped. Edit both changes the pair; edit one and it becomes its own copy.",
    help: topic("sprites-mirror"),
  },
  transparent: {
    name: "Transparent colour",
    says: "Pixels in this colour show the room behind the character. The eraser paints it.",
    help: topic("sprites-transparent"),
  },
  backdrop: {
    name: "Backdrop",
    says: "What you see behind transparent pixels while drawing; the game shows the room instead.",
    help: topic("sprites-transparent"),
  },
  onion: {
    name: "Onion",
    says: "Onion skin shows the cels before and after this one, tinted, so a motion lines up.",
    help: topic("sprites-loops"),
  },
  "mirror-bit": {
    name: "Mirror bit",
    says: "A flag in the VIEW file that tells the game to draw this loop flipped.",
    help: topic("sprites-mirror"),
  },
  "shared-view": {
    name: "Shared character",
    says: "Keep changes this character in every room that uses it.",
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

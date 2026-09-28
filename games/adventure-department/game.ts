import type { OpenedGame } from "../../app/src/archive/gameZip.ts";
import { serializeGameTests } from "../../src/agent/gameTestFormat.ts";
import { TUTORIAL_GAME_TESTS } from "./tests.ts";
import { createAuthoringState, resourceCacheHint } from "../../src/agent/authoringState.ts";
import { buildSound } from "../../src/agent/tools.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { buildView, type BuildViewInput } from "../../src/view/view.ts";
import { CHARACTER_VIEWS } from "./characterViews.ts";
import { LEVER_VIEW } from "./leverView.ts";
import { TUTORIAL_PICTURES } from "./sceneArt.ts";
import { SIGNAL_VIEW } from "./signalView.ts";
import { TUTORIAL_SOUND_IDS, TUTORIAL_SOUND_SOURCES } from "./sounds.ts";

/** Word groups: synonyms share a number. Group 0 is ignored: GO EAST, LOOK AT THE ROBOT. */
const WORD_GROUPS: readonly (readonly [number, readonly string[]])[] = [
  [
    0,
    [
      "go",
      "walk",
      "run",
      "the",
      "a",
      "an",
      "to",
      "at",
      "please",
      "now",
      "on",
      "in",
      "into",
      "with",
      "around",
      "my",
      "your",
      "this",
      "that",
      "some",
      "of",
      "how",
      "do",
    ],
  ],
  [100, ["look", "examine", "inspect", "read", "x", "see", "check", "study"]],
  [101, ["help", "instructions", "hint", "commands"]],
  [102, ["east", "e", "right"]],
  [103, ["west", "w", "left"]],
  [104, ["paint", "color", "colour", "draw"]],
  [
    105,
    [
      "mural",
      "picture",
      "art",
      "frame",
      "painting",
      "scene",
      "canvas",
      "landscape",
      "sketch",
      "sun",
    ],
  ],
  [106, ["pull", "flip", "use", "push", "press", "yank", "tug", "move", "shift"]],
  [107, ["lever", "switch", "handle"]],
  [108, ["show", "view", "display"]],
  [109, ["priority", "priorities", "depth", "layer", "layers"]],
  [110, ["fix", "adjust", "repair", "mend", "give", "set"]],
  [111, ["robot", "machine", "bot"]],
  [112, ["clerk", "ferret", "felix"]],
  [113, ["room", "here", "place"]],
  [114, ["logic", "rule", "rules", "condition"]],
  [115, ["sprite", "sprites", "object"]],
  [116, ["gallery"]],
  [117, ["lab", "laboratory"]],
  [118, ["archive", "archives"]],
  [119, ["fast"]],
  [120, ["normal"]],
  [121, ["slow"]],
  [122, ["speed"]],
  [123, ["talk", "speak", "ask", "hello", "hi", "say", "chat", "greet"]],
  [124, ["counter", "desk"]],
  [125, ["north", "n", "south", "s", "up", "down"]],
  [126, ["door", "doorway", "exit", "wall", "walls"]],
  [127, ["take", "get", "grab", "steal"]],
  [128, ["lamp", "light", "lights", "signal", "spotlight"]],
  [129, ["bench", "tools", "kit", "cart", "cabinet", "brushes", "brush", "pots"]],
  [130, ["code"]],
  [131, ["open", "close"]],
  [132, ["kick", "hit", "punch", "break", "smash"]],
  [133, ["jump", "dance", "sing"]],
  [134, ["eat", "drink", "lick"]],
  [135, ["climb"]],
  [136, ["bust", "statue", "sculpture", "head", "marble", "plinth"]],
  [137, ["plaque", "label", "sign"]],
  [138, ["wave", "waving"]],
  [139, ["wake", "activate", "start", "turn"]],
  [140, ["console", "computer", "screen", "monitor", "terminal", "editor", "bay"]],
  [141, ["film", "strip", "flipbook", "poster", "reel"]],
  [142, ["ledger", "stand", "lectern", "tag"]],
  [143, ["bell"]],
  [144, ["ring"]],
  [
    145,
    [
      "shelves",
      "shelf",
      "bookcase",
      "books",
      "book",
      "drawers",
      "catalog",
      "files",
      "records",
      "cards",
    ],
  ],
  [146, ["inventory", "i", "items", "pockets"]],
  [147, ["score", "points"]],
  [148, ["me", "self", "myself", "apprentice"]],
  [149, ["wait", "sleep", "rest", "sit"]],
  [150, ["smell", "sniff"]],
  [151, ["touch", "feel"]],
  [152, ["thank", "thanks"]],
  [153, ["rope", "velvet"]],
  [154, ["paintings", "portrait", "seascape", "boat", "flower"]],
  [155, ["chart"]],
  [156, ["globe", "world"]],
  [157, ["map", "plan"]],
  [158, ["clock", "time"]],
  [159, ["floor", "ground", "carpet", "tiles", "rug"]],
  [160, ["hug", "cuddle", "pat", "pet"]],
  [161, ["exhibit", "exhibits"]],
];

export const TUTORIAL_WORDS: [string, number][] = WORD_GROUPS.flatMap(([id, words]) =>
  words.map((word): [string, number] => [word, id]),
);

const WORD_MAP = new Map(TUTORIAL_WORDS);

/** A hint-row message, padded so a shorter one fully covers a longer one. */
function hint(text: string): string {
  if (text.length > 39) throw new Error(`hint row too long: ${text}`);
  return text.padEnd(39);
}

/** The line each repair ends with: where to see how it works. */
const STUDIO_LINE: Readonly<Record<number, string>> = {
  1: "Curious how it works? Switch to CREATE and open this room in Studio.",
  2: "Curious how it works? Switch to CREATE and open the robot in Sprite Studio.",
  3: "Curious how it works? Switch to CREATE, open this room in Studio and try the Depth lens.",
};

/**
 * Printed by whichever room completes the third repair. It names no app
 * controls, so the tutorial stays true as the interface around it evolves.
 */
const GRADUATION_MESSAGE =
  "All three exhibits work. You have graduated! You now know the three secrets of every AGI game: PICTURE recipes, VIEW flipbooks and PRIORITY numbers, all run by LOGIC rules. The AI writes the very same things. Make your own adventure from the main menu!";

const GRADUATED_HINT = hint("All fixed! Now make your own adventure.");

export const TUTORIAL_LOGIC_SOURCES: Readonly<Record<number, string>> = {
  0: String.raw`
#message 1 "Only EAST and WEST lead anywhere in this building."
#message 2 "No need to open anything: the doorways are always open. Walk through them, or type EAST or WEST."
#message 3 "You're the new apprentice at the Adventure Department. Your job: fix all three exhibits."
#message 4 "You carry a pencil stub, a museum badge and a lot of curiosity. This adventure needs no items."
#message 5 "Score: %v3 of 30. Each repaired exhibit is worth 10 points."
#message 6 "Violence never fixed an exhibit. Well, almost never."
#message 7 "You do a little dance. Nobody is watching. Probably."
#message 8 "Rule one of every museum: no snacks near the exhibits."
#message 9 "Climbing the exhibits is frowned upon. Also, you would fall off."
#message 10 "Nothing happens. %s1"
#message 11 "I don't know the word \"%w1\". %s1"
#message 12 "I don't know the word \"%w2\". %s1"
#message 13 "I don't know the word \"%w3\". %s1"
#message 14 "I don't know one of those words. %s1"
#message 15 "You rest a moment. Sadly, the exhibits don't fix themselves."
#message 16 "It smells of old paint and new ideas."
#message 17 "You're welcome! Now, back to work."
#message 18 "Ow. The robot is solid tin. Your toe is not."
#message 19 "Just type what to do, in a word or two. %s1"
#message 20 "You hug the sleeping robot. Cold tin. The WAKE lever might help."
#message 21 "You hug the robot. He beeps happily and keeps waving."
#message 22 "A hug never fixed an exhibit, but it's a kind thought."
#message 23 "Three exhibits need fixing: the mural in the Picture Gallery, the robot in the Sprite Lab and Felix in the Priority Archive. %s1"
#message 24 "All three exhibits work: the mural, the robot and Felix. You fixed every one!"
#message 25 "Each exhibit has its own fix. %s1"

// Boot once, then dispatch the current room every interpreter cycle.
if (!isset(f200)) {
  set(f200);
  assignn(v7, 30);
  assignn(v10, 1);
  assignn(v60, 0);
  assignn(v61, 0);
  assignn(v63, 0);
  script.size(100);
  status.line.on();
  new.room(1);
}
if (said("fast") || said("fast", "speed")) {
  assignn(v60, 1); assignn(v51, 1); step.time(o0, v51); assignn(v63, 0);
}
if (said("normal") || said("normal", "speed")) {
  assignn(v60, 0); assignn(v61, 0); assignn(v51, 1); step.time(o0, v51); assignn(v63, 0);
}
if (said("slow") || said("slow", "speed")) {
  assignn(v60, 2); assignn(v51, 2); step.time(o0, v51); assignn(v63, 0);
}
if (said("north") || said("south")) { print(1); }
if (said("door") || said("exit") || said("open", "door") || said("open", "exit") || said("open")) { print(2); }
if (said("look", "me")) { print(3); }
if (said("inventory") || said("look", "inventory")) { print(4); }
if (said("score") || said("look", "score")) { print(5); }
if (equaln(v0, 2) && said("kick", "robot")) { print(18); }
if (equaln(v0, 2) && said("hug", "robot")) {
  if (isset(f31)) { print(21); } else { print(20); }
}
if (said("hug") || (equaln(v9, 0) && said("hug", "*"))) { print(22); }
if (said("kick") || (equaln(v9, 0) && said("kick", "*"))) { print(6); }
if (said("jump") || (equaln(v9, 0) && said("jump", "*"))) { print(7); }
if (said("eat") || (equaln(v9, 0) && said("eat", "*"))) { print(8); }
if (said("climb") || (equaln(v9, 0) && said("climb", "*"))) { print(9); }
if (said("wait") || (equaln(v9, 0) && said("wait", "*"))) { print(15); }
if (said("smell") || (equaln(v9, 0) && said("smell", "*"))) { print(16); }
if (said("thank") || (equaln(v9, 0) && said("thank", "*"))) { print(17); }
// HOW DO I PAINT: how and do are ignored, and I is INVENTORY's word.
if (equaln(v9, 0) && said("inventory", "...")) { print(19); }
// The hint row's "Fix 3 exhibits", answered in every room.
if (said("look", "exhibit")) {
  if (isset(f33)) { print(24); } else { print(23); }
}
if (said("fix", "exhibit")) {
  if (isset(f33)) { print(24); } else { print(25); }
}
call.v(v0);
// Whatever the room did not handle gets a Sierra-style reply naming the
// unknown word and the room's next step (s1, which each room keeps current).
if (isset(f2) && !isset(f4)) {
  if (equaln(v9, 0)) { print(10); }
  if (equaln(v9, 1)) { print(11); }
  if (equaln(v9, 2)) { print(12); }
  if (equaln(v9, 3)) { print(13); }
  if (greatern(v9, 3)) { print(14); }
}
if (isset(f5)) {
  assignn(v61, 0); assignn(v63, 0);
  if (equaln(v60, 2)) { assignn(v51, 2); } else { assignn(v51, 1); }
  step.time(o0, v51);
  get.posn(o0, v56, v57);
}
get.posn(o0, v54, v55);
if (equaln(v6, 0)) {
  stop.cycling(o0); assignn(v63, 0);
}
if (!equaln(v6, 0) && (!equalv(v54, v56) || !equalv(v55, v57))) {
  start.cycling(o0); assignn(v63, 0);
  if (equaln(v60, 0)) {
    increment(v61);
    if (equaln(v61, 5)) { assignn(v61, 0); }
    if (equaln(v61, 0) || equaln(v61, 2)) { assignn(v51, 1); } else { assignn(v51, 2); }
  }
  if (equaln(v60, 1)) { assignn(v51, 1); }
  if (equaln(v60, 2)) { assignn(v51, 2); }
  step.time(o0, v51);
}
if (!equaln(v6, 0) && equalv(v54, v56) && equalv(v55, v57)) {
  if (lessn(v63, 2)) { increment(v63); }
  if (equaln(v63, 2)) { stop.cycling(o0); }
}
assignv(v56, v54); assignv(v57, v55);
return;
`,
  1: String.raw`
#message 1 "ADVENTURE DEPARTMENT: PICTURE GALLERY"
#message 2 "The Picture Gallery. A golden frame hangs behind a velvet rope, but its painting is gone: only a pencil sketch is left. Walk up to the rope and type PAINT MURAL."
#message 3 "Useful commands here: LOOK, LOOK MURAL, PAINT MURAL, LOOK CODE, EAST. Arrow keys walk. FAST and SLOW change your speed."
#message 4 "You paint a sun, mountains and a river. The computer keeps no photo of it, only a recipe: draw a line here, pour paint there. That recipe is a PICTURE, made of vector commands. Exhibit one repaired!\n\n${STUDIO_LINE[1]}"
#message 5 "The mural glows with its new landscape. Every line and every splash of colour came from the recipe. Type LOOK CODE to see the rule that painted it."
#message 6 "${hint("Fix 3 exhibits. HELP. Try PAINT MURAL.")}"
#message 7 "${hint("Mural fixed! Next exhibit: go EAST.")}"
#message 8 "${GRADUATION_MESSAGE}"
#message 9 "This is ROOM 1. A room is one numbered place: its PICTURE paints the backdrop, and its LOGIC holds the rules. Walking EAST just runs new.room(2)."
#message 10 "Only a marble bust lives that way, and it isn't moving. The Sprite Lab is EAST."
#message 11 "The rule behind PAINT MURAL, in real AGI logic:\n\nif (said(\"paint\",\"mural\")) {\noverlay.pic(4);\nset(f30);\n}\n\nWhen you say this, do that. Every AGI puzzle is a rule like this one."
#message 12 "You're too far away. Walk up to the frame, then PAINT MURAL."
#message 13 "You clear your throat. The paintings say nothing, which is typical of paintings. Felix the clerk works two rooms EAST."
#message 14 "A restoration cart with three pots of paint: red, yellow and blue. Painters here work from recipes, not from photos."
#message 15 "Art stays on the walls. Stealing it is a very different kind of game."
#message 16 "You see nothing special about that."
#message 17 "Try PAINT MURAL or HELP."
#message 18 "The next exhibit is EAST."
#message 19 "HELP lists what works here."
#message 20 "${GRADUATED_HINT}"
#message 21 "A marble bust of the Department's first adventurer. The nose fell off years ago. Nobody knows where it went."
#message 22 "The plaque reads: LANDSCAPE. Painting missing, recipe included."
#message 23 "The plaque reads: LANDSCAPE. Painted by you, one command at a time."
#message 24 "A velvet rope keeps visitors from touching the art. You may still paint it: you're staff."
#message 25 "Three small paintings: a portrait, a flower and a boat. Each one is a recipe of lines and fills, like every AGI picture."
#message 26 "A brass picture light, so every brushstroke shows."
#message 27 "The doorway EAST leads to the Sprite Lab. You can see its blue walls from here."
#message 28 "Paintings are fixed with paint around here. Try PAINT MURAL."
#message 29 "The mural is already finished. Stand back and admire it."
#message 30 "The canvas is blank and a little dusty."
#message 31 "The paint is already dry. Recipes dry fast."
#message 32 "Only the mural needs paint. Try PAINT MURAL."
#message 33 "Cool grey stone. It hums faintly with vector commands."

if (isset(f5)) {
  assignn(v50, 1);
  load.pic(v50); draw.pic(v50); show.pic();
  set.horizon(112);
  load.view(0); animate.obj(o0); set.view(o0, 0); start.motion(o0);
  load.sound(1); load.sound(2);
  assignn(v51, 1); step.time(o0, v51);
  assignn(v52, 6); cycle.time(o0, v52);
  if (equaln(v1, 2)) { position(o0, 132, 151); } else { position(o0, 18, 151); }
  draw(o0); stop.cycling(o0);
  get.posn(o0, v56, v57);
  accept.input();
  if (!isset(f36)) { set(f36); sound(1, f37); }
  if (isset(f30)) { assignn(v50, 4); load.pic(v50); overlay.pic(v50); show.pic(); }
}
display(1, 1, 1);
if (!isset(f30)) { display(2, 1, 6); set.string(s1, m17); }
if (isset(f30) && !isset(f33)) { display(2, 1, 7); set.string(s1, m18); }
if (isset(f33)) { display(2, 1, 20); set.string(s1, m19); }
if (said("help")) { print(3); }
if (said("look", "room") || said("look", "logic")) { print(9); }
if (said("look", "code")) { print(11); }
if (said("look", "bench")) { print(14); }
if (said("look", "bust")) { print(21); }
if (said("look", "plaque")) {
  if (isset(f30)) { print(23); } else { print(22); }
}
if (said("look", "rope")) { print(24); }
if (said("look", "paintings")) { print(25); }
if (said("look", "lamp")) { print(26); }
if (said("look", "door")) { print(27); }
if (said("look", "floor")) { print(33); }
if (said("look") || said("look", "gallery") || said("look", "mural")) {
  if (isset(f30)) { print(5); } else { print(2); }
}
if ((equaln(v9, 0) && said("look", "*"))) { print(16); }
if (said("touch", "mural")) {
  if (isset(f30)) { print(31); } else { print(30); }
}
if (said("fix", "mural")) {
  if (isset(f30)) { print(29); } else { print(28); }
}
if (said("talk") || (equaln(v9, 0) && said("talk", "*"))) { print(13); }
if (said("take") || (equaln(v9, 0) && said("take", "*"))) { print(15); }
if (said("paint", "mural") || said("paint")) {
  if (posn(o0, 45, 112, 110, 167)) {
    if (!isset(f30)) {
      set(f30); addn(v3, 10);
      assignn(v50, 4); load.pic(v50); overlay.pic(v50); show.pic();
      sound(2, f37);
      print(4);
      if (isset(f31) && isset(f32)) { set(f33); print(8); }
    } else { print(29); }
  } else { print(12); }
}
if ((equaln(v9, 0) && said("paint", "*"))) { print(32); }
if (said("west")) { print(10); }
if (said("east")) { new.room(2); }
if (equaln(v2, 2)) { new.room(2); }
return;
`,
  2: String.raw`
#message 1 "ADVENTURE DEPARTMENT: SPRITE LAB"
#message 2 "The Sprite Lab. A tin robot sleeps in its charging bay. The robot is a flipbook: a few small drawings shown one after another. That flipbook is a VIEW. Walk to the WAKE lever and try PULL LEVER."
#message 3 "The lever swings over with a CLUNK, and the robot wakes up waving! Both are VIEWS: the lever plays its drawings once, the robot loops his. A condition checks the repair flag, so the lever stays put when you come back. Exhibit two repaired!\n\n${STUDIO_LINE[2]}"
#message 4 "The lever is already down. The robot waves anyway."
#message 5 "LOGIC selects the view, the loop and the cel to show. A loop is one row of drawings, and a cel is one drawing in it."
#message 6 "Useful commands here: LOOK ROBOT, LOOK LEVER, TALK ROBOT, PULL LEVER, LOOK CODE, WEST, EAST. Arrow keys walk."
#message 7 "${hint("Exhibit 2 of 3. HELP. Try PULL LEVER.")}"
#message 8 "${GRADUATION_MESSAGE}"
#message 9 "A tin robot, fast asleep in its charging bay. Zzz. The lever on the wall says WAKE."
#message 10 "The robot waves at you. Walk past him and he turns: his left-facing loop starts as a MIRROR of his right-facing one, and a mirror costs no extra drawings."
#message 11 "A big red lever on a steel plate. The label says WAKE. Try PULL LEVER."
#message 12 "The lever points the other way now. A flag keeps it there, even if you leave and come back."
#message 13 "The robot snores in little beeps. It's switched off."
#message 14 "BEEP BOOP. The robot says thank you, in robot."
#message 15 "You're too far away. Walk over to the lever, then PULL LEVER."
#message 16 "The rule behind PULL LEVER, in real AGI logic:\n\nif (said(\"pull\",\"lever\")) {\nset.view(o1, 2);\nend.of.loop(o2, f34);\n}\n\nset.view gives the robot a new flipbook; end.of.loop plays the lever's once."
#message 17 "You see nothing special about that."
#message 18 "The lab equipment is bolted down, mostly because of apprentices."
#message 19 "Try PULL LEVER or HELP."
#message 20 "The next exhibit is EAST."
#message 21 "The mural still waits WEST."
#message 22 "HELP lists what works here."
#message 23 "${hint("Robot awake! Next exhibit: go EAST.")}"
#message 24 "${hint("Robot awake! The mural waits WEST.")}"
#message 25 "${GRADUATED_HINT}"
#message 26 "The charging bay's sprite editor. Its screen shows the robot drawn big, one square pixel at a time."
#message 27 "A film strip of the robot's wave: four drawings in a row. Show them fast and he moves. That's all animation is."
#message 28 "You wave. The robot doesn't wave back. It's switched off."
#message 29 "You wave. The robot waves back! Same four drawings, over and over."
#message 30 "There's no button on the robot. The lever that says WAKE looks promising. Try PULL LEVER."
#message 31 "It's awake. Very awake."
#message 32 "The robot doesn't want to be pulled. The lever does."
#message 33 "The robot isn't broken, just asleep. Try PULL LEVER."
#message 34 "Nothing to fix: the robot works beautifully."
#message 35 "Doorways lead WEST to the red gallery and EAST to the green archive."
#message 36 "Black and white tiles, like a giant sheet of graph paper."

if (isset(f5)) {
  assignn(v50, 2);
  load.pic(v50); draw.pic(v50); show.pic();
  set.horizon(112);
  load.view(0); load.view(1); load.view(2); load.view(4);
  load.sound(3);
  animate.obj(o0); set.view(o0, 0); start.motion(o0);
  assignn(v51, 1); step.time(o0, v51);
  assignn(v52, 6); cycle.time(o0, v52);
  if (equaln(v1, 3)) { position(o0, 132, 151); } else { position(o0, 18, 151); }
  draw(o0); stop.cycling(o0);
  get.posn(o0, v56, v57);
  animate.obj(o1);
  if (isset(f31)) { set.view(o1, 2); } else { set.view(o1, 1); }
  assignn(v53, 10); cycle.time(o1, v53);
  position(o1, 98, 108); ignore.horizon(o1); ignore.objs(o1); stop.motion(o1); draw(o1);
  if (isset(f31)) { start.cycling(o1); } else { stop.cycling(o1); }
  reset(f34);
  animate.obj(o2); set.view(o2, 4); position(o2, 29, 105);
  ignore.horizon(o2); ignore.objs(o2); stop.motion(o2); set.priority(o2, 15);
  assignn(v58, 4); cycle.time(o2, v58);
  if (isset(f31)) { set.cel(o2, 3); } else { set.cel(o2, 0); }
  draw(o2); stop.cycling(o2);
  accept.input();
}
// Awake, the robot turns to face the apprentice: loop 1 faces left.
if (isset(f31)) {
  if (lessn(v54, 100)) { set.loop(o1, 1); } else { set.loop(o1, 0); }
}
display(1, 1, 1);
if (!isset(f31)) { display(2, 1, 7); set.string(s1, m19); }
if (isset(f31) && !isset(f33)) {
  if (!isset(f32)) { display(2, 1, 23); set.string(s1, m20); }
  if (isset(f32)) { display(2, 1, 24); set.string(s1, m21); }
}
if (isset(f33)) { display(2, 1, 25); set.string(s1, m22); }
if (said("help")) { print(6); }
if (said("look", "robot")) {
  if (isset(f31)) { print(10); } else { print(9); }
}
if (said("look", "lever") || said("look", "plaque")) {
  if (isset(f31)) { print(12); } else { print(11); }
}
if (said("look", "code")) { print(16); }
if (said("look", "logic") || said("look", "sprite")) { print(5); }
if (said("look", "console")) { print(26); }
if (said("look", "film")) { print(27); }
if (said("look", "door")) { print(35); }
if (said("look", "floor")) { print(36); }
if (said("look") || said("look", "room") || said("look", "lab")) { print(2); }
if ((equaln(v9, 0) && said("look", "*"))) { print(17); }
if (said("talk") || (equaln(v9, 0) && said("talk", "*"))) {
  if (isset(f31)) { print(14); } else { print(13); }
}
if (said("wave") || (equaln(v9, 0) && said("wave", "*"))) {
  if (isset(f31)) { print(29); } else { print(28); }
}
if (said("wake") || said("wake", "robot")) {
  if (isset(f31)) { print(31); } else { print(30); }
}
if (said("fix", "robot")) {
  if (isset(f31)) { print(34); } else { print(33); }
}
if (said("take") || (equaln(v9, 0) && said("take", "*"))) { print(18); }
if (said("pull", "robot")) { print(32); }
if (said("pull", "lever") || said("pull")) {
  if (posn(o0, 26, 112, 56, 167)) {
    if (!isset(f31)) {
      set(f31); addn(v3, 10); set.view(o1, 2); start.cycling(o1);
      sound(3, f37);
      end.of.loop(o2, f34);
    } else { print(4); }
  } else { print(15); }
}
if (isset(f34)) {
  reset(f34); print(3);
  if (isset(f30) && isset(f32)) { set(f33); print(8); }
}
if (said("west")) { new.room(1); }
if (said("east")) { new.room(3); }
if (equaln(v2, 4)) { new.room(1); }
if (equaln(v2, 2)) { new.room(3); }
return;
`,
  3: String.raw`
#message 1 "ADVENTURE DEPARTMENT: PRIORITY ARCHIVE"
#message 2 "The Priority Archive. Felix the ferret clerk floats in FRONT of his counter. That's wrong! Every spot on the screen has a secret depth number, called PRIORITY. Type SHOW PRIORITY to see them."
#message 3 "Counter:11. Felix:15. Higher is closer."
#message 4 "You change Felix from priority 15 to 10. The counter keeps 11, so now it is closer: it hides his tummy, and his head peeks over the top. Exhibit three repaired!\n\n${STUDIO_LINE[3]}"
#message 5 "Felix stands behind his counter at last. The counter's 11 is closer than Felix's 10, so the counter covers him."
#message 6 "Useful commands here: LOOK FELIX, TALK FELIX, LOOK COUNTER, SHOW PRIORITY, FIX PRIORITY, LOOK CODE, WEST."
#message 7 "${GRADUATION_MESSAGE}"
#message 8 "${hint("Exhibit 3 of 3. HELP. SHOW PRIORITY.")}"
#message 9 "Counter:11. Felix:10. Lower is farther."
#message 10 "The east wall ends the archive. Only the globe lives over there. Go WEST for the Sprite Lab."
#message 11 "Felix squeaks: \"I'm floating in front of my own counter! My priority is wrong. Please FIX PRIORITY.\""
#message 12 "Felix squeaks: \"Perfect! Now I can sort the archive again. Thank you!\""
#message 13 "A long oak counter. On the hidden depth screen its pixels say 11. Anything with a lower number goes behind it."
#message 14 "The rule behind FIX PRIORITY, in real AGI logic:\n\nif (said(\"fix\",\"priority\")) {\nset.priority(o1, 10);\n}\n\nNumbers decide who is in front. Bigger is closer."
#message 15 "Felix the clerk, a ferret in a green eyeshade. His priority is 15, the closest there is, so he floats in front of everything."
#message 16 "A little lamp on the counter. Red means the archive is still broken."
#message 17 "The lamp glows green. The archive is repaired."
#message 18 "You see nothing special about that."
#message 19 "Felix would rather you didn't. Everything here is filed exactly where it belongs."
#message 20 "Felix, busy behind his counter. Priority 10: one step behind the counter's 11."
#message 21 "A tall ledger stand with a paper tag on it: DEPTH PENDING. It has no depth number of its own yet, so if you walk behind it you float in front! Fixing that is a job for the Room Studio."
#message 22 "The depth chart: every priority from 4 (far away, at the top) to 15 (right in front). SHOW PRIORITY paints the room in these colours."
#message 23 "A globe of a world where every adventure is still waiting to be written."
#message 24 "A map of the Adventure Department: the red gallery, the blue lab and the green archive. You are here."
#message 25 "The clock says it's time to fix some priorities."
#message 26 "Shelves of ledgers and drawers of index cards. Felix knows where every one of them is filed."
#message 27 "DING! Felix jumps. \"I'm right here, you know.\""
#message 28 "Felix isn't heavy, just in the wrong layer. Try FIX PRIORITY."
#message 29 "The doorway WEST leads back to the Sprite Lab."
#message 30 "Try SHOW PRIORITY or HELP."
#message 31 "The other exhibits are WEST."
#message 32 "HELP lists what works here."
#message 33 "${hint("Felix fixed! The others wait WEST.")}"
#message 34 "${GRADUATED_HINT}"
#message 35 "Felix's priority is fixed already. He's exactly where he belongs."
#message 36 "A thick red carpet. It muffles footsteps, and Felix likes it quiet."
#message 37 "Wait: you're BEHIND the ledger stand, yet you float in front of it! The tag on it says DEPTH PENDING. Nobody has given the stand a depth number yet."
#message 38 "The stand's depth isn't a typed fix. It's a Room Studio job: LOOK STAND explains."
#message 39 "You're too far away. Walk up to Felix's counter, then FIX PRIORITY."

if (isset(f5)) {
  assignn(v50, 3); load.pic(v50); draw.pic(v50); show.pic();
  set.horizon(112);
  load.view(0); load.view(3); load.view(5);
  load.sound(2);
  animate.obj(o0); set.view(o0, 0); start.motion(o0);
  assignn(v51, 1); step.time(o0, v51);
  assignn(v52, 6); cycle.time(o0, v52);
  position(o0, 18, 151); draw(o0); stop.cycling(o0);
  get.posn(o0, v56, v57);
  animate.obj(o1); set.view(o1, 3); position(o1, 77, 100); ignore.horizon(o1); ignore.objs(o1); stop.motion(o1); stop.cycling(o1);
  set.cel(o1, 0); reset(f35); random(70, 140, v59);
  if (isset(f32)) { set.priority(o1, 10); } else { set.priority(o1, 15); }
  draw(o1);
  animate.obj(o2); set.view(o2, 5); position(o2, 110, 74);
  ignore.horizon(o2); ignore.objs(o2); stop.motion(o2); set.priority(o2, 15);
  if (isset(f32)) { set.cel(o2, 1); } else { set.cel(o2, 0); }
  draw(o2); stop.cycling(o2);
  accept.input();
}
if (!isset(f5)) {
  if (isset(f35)) {
    decrement(v59);
    if (equaln(v59, 0)) { set.cel(o1, 0); reset(f35); random(70, 140, v59); }
  } else {
    decrement(v59);
    if (equaln(v59, 0)) { set.cel(o1, 1); set(f35); random(2, 4, v59); }
  }
}
// The ledger stand has no depth yet (the Room Studio lesson): say so the first time the apprentice walks behind it.
if (!isset(f38) && posn(o0, 33, 112, 49, 120)) { set(f38); print(37); }
display(1, 1, 1);
if (!isset(f32)) { display(2, 1, 8); set.string(s1, m30); }
if (isset(f32) && !isset(f33)) { display(2, 1, 33); set.string(s1, m31); }
if (isset(f33)) { display(2, 1, 34); set.string(s1, m32); }
if (said("help")) { print(6); }
if (said("look", "code")) { print(14); }
if (said("look", "counter")) { print(13); }
if (said("look", "clerk")) {
  if (isset(f32)) { print(20); } else { print(15); }
}
if (said("look", "lamp")) {
  if (isset(f32)) { print(17); } else { print(16); }
}
if (said("look", "ledger")) { print(21); }
if (said("look", "chart")) { print(22); }
if (said("look", "globe")) { print(23); }
if (said("look", "map")) { print(24); }
if (said("look", "clock")) { print(25); }
if (said("look", "shelves")) { print(26); }
if (said("look", "door")) { print(29); }
if (said("look", "floor")) { print(36); }
if (said("look") || said("look", "room") || said("look", "archive") || said("look", "priority")) {
  if (isset(f32)) { print(5); } else { print(2); }
}
if ((equaln(v9, 0) && said("look", "*"))) { print(18); }
if (said("talk") || (equaln(v9, 0) && said("talk", "*"))) {
  if (isset(f32)) { print(12); } else { print(11); }
}
if (said("ring", "bell") || said("ring") || said("use", "bell")) { print(27); }
if (said("fix", "ledger") || said("fix", "ledger", "priority")) { print(38); }
if (said("fix", "clerk") || said("pull", "clerk")) {
  if (isset(f32)) { print(35); } else { print(28); }
}
if (said("take") || (equaln(v9, 0) && said("take", "*"))) { print(19); }
if (said("show", "priority")) {
  if (isset(f32)) { display(23, 0, 9); } else { display(23, 0, 3); }
  show.pri.screen();
  clear.lines(23, 23, 0);
}
if (said("fix", "priority") || said("fix", "clerk", "priority")) {
  if (isset(f32)) { print(35); } else {
    // Like the mural and the lever, the repair is made up close: at the counter.
    if (posn(o0, 50, 112, 125, 167)) {
      set(f32); addn(v3, 10); set.priority(o1, 10); set.cel(o2, 1);
      sound(2, f37);
      print(4);
      if (isset(f30) && isset(f31)) { set(f33); print(7); }
    } else { print(39); }
  }
}
if (said("west")) { new.room(2); }
if (said("east")) { print(10); }
if (equaln(v2, 4)) { new.room(2); }
return;
`,
};

/** The three rooms and the mural overlay, as annotated Room Studio sources. */
export const TUTORIAL_PICTURE_SOURCES: Readonly<Record<number, string>> = TUTORIAL_PICTURES;

export const TUTORIAL_VIEW_SOURCES: Readonly<Record<number, BuildViewInput>> = {
  ...CHARACTER_VIEWS,
  4: LEVER_VIEW,
  5: SIGNAL_VIEW,
};

export interface TutorialGame extends OpenedGame {
  title: string;
  roomGeneration: false;
  metadata: { description: string; author: string; license: string };
}

export function buildTutorial(): TutorialGame {
  const container = createContainer();
  for (const [num, source] of Object.entries(TUTORIAL_LOGIC_SOURCES)) {
    container.putResource(
      "logic",
      Number(num),
      assembleLogic(source, { dictionary: WORD_MAP }).payload,
    );
  }
  for (const [num, source] of Object.entries(TUTORIAL_PICTURE_SOURCES)) {
    container.putResource("picture", Number(num), compilePictureSource(source).bytes);
  }
  for (const [num, source] of Object.entries(TUTORIAL_VIEW_SOURCES)) {
    container.putResource("view", Number(num), buildView(source));
  }
  for (const [num, source] of Object.entries(TUTORIAL_SOUND_SOURCES)) {
    container.putResource("sound", Number(num), buildSound(source.tracks));
  }
  container.putFile("WORDS.TOK", buildWordsTok(TUTORIAL_WORDS.map(([word, id]) => ({ word, id }))));
  // Empty OBJECT table: encrypted AGI 2.936 bytes for [table size 0, max object 255].
  container.putFile("OBJECT", Uint8Array.of(0x41, 0x76, 0x96));
  container.putFile("TESTS.JSON", serializeGameTests(TUTORIAL_GAME_TESTS));

  const authoring = createAuthoringState();
  authoring.bindings = {
    picture_repaired: { kind: "flag", num: 30 },
    sprite_repaired: { kind: "flag", num: 31 },
    priority_repaired: { kind: "flag", num: 32 },
    tutorial_complete: { kind: "flag", num: 33 },
    intro_played: { kind: "flag", num: 36 },
    sound_finished: { kind: "flag", num: 37 },
    stand_tag_seen: { kind: "flag", num: 38 },
    walking_speed: { kind: "variable", num: 60 },
    intro_sound: { kind: "sound", num: TUTORIAL_SOUND_IDS.intro },
    point_sound: { kind: "sound", num: TUTORIAL_SOUND_IDS.point },
    lever_sound: { kind: "sound", num: TUTORIAL_SOUND_IDS.lever },
  };
  const introPayload = container.getResource("sound", TUTORIAL_SOUND_IDS.intro);
  const introTempo = TUTORIAL_SOUND_SOURCES[TUTORIAL_SOUND_IDS.intro]!.tempo;
  if (introPayload === null || introTempo === null) {
    throw new Error("Tutorial intro sound source is incomplete.");
  }
  authoring.music = {
    [String(TUTORIAL_SOUND_IDS.intro)]: {
      revision: resourceCacheHint(introPayload),
      tempo: introTempo,
    },
  };
  authoring.world.rooms = {
    "1": { title: "Picture Gallery", description: "Repair a vector mural.", exits: { east: 2 } },
    "2": {
      title: "Sprite Lab",
      description: "Wake a sprite with conditional logic.",
      exits: { west: 1, east: 3 },
    },
    "3": {
      title: "Priority Archive",
      description: "Put foreground occlusion back in order.",
      exits: { west: 2 },
    },
  };
  authoring.world.facts = {
    controls:
      "Arrow keys move the apprentice; FAST, NORMAL, and SLOW set walking speed; short VERB NOUN commands solve exhibits.",
    safety: "Every room remains reachable and no action kills or traps the player.",
  };
  authoring.world.quests = {
    repairs: {
      description: "Repair the picture, sprite, and priority exhibits.",
      requires: [],
      completedFlag: "tutorial_complete",
    },
  };

  return {
    files: Object.fromEntries([...container.files].map(([name, bytes]) => [name, bytes.slice()])),
    words: TUTORIAL_WORDS.map(([word, id]) => [word, id]),
    title: "Adventure Department",
    roomGeneration: false,
    metadata: {
      description: "Learn pictures, sprites and priority in a three-room tutorial.",
      author: "Monotio",
      license: "MIT",
    },
    project: {
      provider: "stub",
      model: "offline-tutorial",
      transcript: [],
      authoringState: {
        authoring,
        sources: {
          logics: Object.entries(TUTORIAL_LOGIC_SOURCES).map(([num, source]) => [
            Number(num),
            source,
          ]),
          pictures: Object.entries(TUTORIAL_PICTURE_SOURCES).map(([num, source]) => [
            Number(num),
            source,
          ]),
          views: Object.entries(TUTORIAL_VIEW_SOURCES).map(([num, source]) => [
            Number(num),
            source,
          ]),
          sounds: Object.entries(TUTORIAL_SOUND_SOURCES).map(([num, source]) => [
            Number(num),
            source.tracks,
          ]),
        },
      },
    },
  };
}

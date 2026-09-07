import type { OpenedGame } from "../../app/src/gameZip.ts";
import { serializeGameTests } from "../../src/agent/gameTests.ts";
import { TUTORIAL_GAME_TESTS } from "./tests.ts";
import { createAuthoringState, resourceRevision } from "../../src/agent/authoringState.ts";
import { buildSound } from "../../src/agent/tools.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { buildView, type BuildViewInput } from "../../src/view/view.ts";
import { CHARACTER_VIEWS } from "./characterViews.ts";
import { LEVER_VIEW } from "./leverView.ts";
import { ORIGINAL_SCENE_PICTURES } from "./sceneArt.ts";
import { SIGNAL_VIEW } from "./signalView.ts";
import { TUTORIAL_SOUND_IDS, TUTORIAL_SOUND_SOURCES } from "./sounds.ts";

export const TUTORIAL_WORDS: [string, number][] = [
  // Group 0 is the ignored group: GO EAST, PLEASE LOOK and THE LEVER all parse.
  ["go", 0],
  ["walk", 0],
  ["run", 0],
  ["the", 0],
  ["a", 0],
  ["an", 0],
  ["to", 0],
  ["at", 0],
  ["please", 0],
  ["now", 0],
  ["look", 100],
  ["examine", 100],
  ["inspect", 100],
  ["read", 100],
  ["x", 100],
  ["help", 101],
  ["instructions", 101],
  ["hint", 101],
  ["commands", 101],
  ["east", 102],
  ["e", 102],
  ["west", 103],
  ["w", 103],
  ["paint", 104],
  ["color", 104],
  ["colour", 104],
  ["draw", 104],
  ["mural", 105],
  ["picture", 105],
  ["art", 105],
  ["frame", 105],
  ["painting", 105],
  ["scene", 105],
  ["pull", 106],
  ["flip", 106],
  ["use", 106],
  ["push", 106],
  ["press", 106],
  ["lever", 107],
  ["switch", 107],
  ["handle", 107],
  ["show", 108],
  ["view", 108],
  ["priority", 109],
  ["priorities", 109],
  ["depth", 109],
  ["fix", 110],
  ["adjust", 110],
  ["repair", 110],
  ["robot", 111],
  ["machine", 111],
  ["clerk", 112],
  ["ferret", 112],
  ["felix", 112],
  ["room", 113],
  ["here", 113],
  ["place", 113],
  ["logic", 114],
  ["rule", 114],
  ["rules", 114],
  ["condition", 114],
  ["sprite", 115],
  ["object", 115],
  ["gallery", 116],
  ["lab", 117],
  ["laboratory", 117],
  ["archive", 118],
  ["fast", 119],
  ["normal", 120],
  ["slow", 121],
  ["speed", 122],
  ["talk", 123],
  ["speak", 123],
  ["ask", 123],
  ["hello", 123],
  ["hi", 123],
  ["say", 123],
  ["counter", 124],
  ["desk", 124],
  ["shelf", 124],
  ["north", 125],
  ["n", 125],
  ["south", 125],
  ["s", 125],
  ["up", 125],
  ["down", 125],
  ["door", 126],
  ["exit", 126],
  ["wall", 126],
  ["take", 127],
  ["get", 127],
  ["open", 127],
  ["close", 127],
  ["kick", 127],
  ["hit", 127],
  ["jump", 127],
  ["dance", 127],
  ["sing", 127],
  ["eat", 127],
  ["climb", 127],
  ["lamp", 128],
  ["light", 128],
  ["signal", 128],
  ["bench", 129],
  ["tools", 129],
  ["kit", 129],
  ["cabinet", 129],
  ["code", 130],
];

const WORD_MAP = new Map(TUTORIAL_WORDS);

/**
 * Printed by whichever room completes the third repair. It names no app
 * controls, so the tutorial stays true as the interface around it evolves.
 */
const GRADUATION_MESSAGE =
  "All three exhibits work. You have graduated! Felix has his counter back. You now know the three secrets of every AGI game: PICTURE recipes, VIEW flipbooks and PRIORITY numbers, all run by LOGIC rules. The AI writes the very same things. Make your own adventure from the main menu!";

export const TUTORIAL_LOGIC_SOURCES: Readonly<Record<number, string>> = {
  0: String.raw`
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
if (said("north") || said("south")) {
  print("Only EAST and WEST lead anywhere in this building.");
}
if (said("door") || said("exit") || said("open", "door") || said("open", "exit")) {
  print("There is no door here. The exhibits connect EAST and WEST.");
}
call.v(v0);
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
#message 2 "An empty frame hangs on the gallery wall. The scene is missing! Walk in front of the frame and type PAINT MURAL. The Sprite Lab is EAST."
#message 3 "Useful commands here: LOOK, LOOK MURAL, PAINT MURAL, LOOK CODE, EAST. Arrows walk. FAST or SLOW changes your speed."
#message 4 "You paint a sun, mountains and a river. The computer keeps no photo, only a recipe: draw a line here, pour colour there. That recipe is a PICTURE, stored as tiny vector commands. Exhibit one repaired!"
#message 5 "The mural shows the finished landscape. Type LOOK CODE to see the rule that painted it."
#message 6 "Nothing happens. In the gallery, try PAINT MURAL or HELP."
#message 7 "Fix 3 exhibits. HELP. Try PAINT MURAL."
#message 8 "${GRADUATION_MESSAGE}"
#message 9 "A ROOM is one numbered place. Its PICTURE paints the backdrop and its LOGIC holds the rules. Going EAST is just new.room(2). A flag remembers your repair when you return."
#message 10 "The west wall is solid oak. The Sprite Lab is east."
#message 11 "The rule behind PAINT MURAL, in real AGI logic:  if (said(\"paint\", \"mural\")) { overlay.pic(4); set(f30); }  When you say this, do that. Every puzzle in every AGI game is a rule like it."
#message 12 "You are too far away. Walk in front of the frame, then PAINT MURAL."
#message 13 "You clear your throat. The frame says nothing. Felix the clerk works two rooms EAST."
#message 14 "I do not know that word. In the gallery, try PAINT MURAL or HELP."
#message 15 "A sturdy restoration bench with three cabinets. The tools are for painting, not for taking."
#message 16 "That is not how a museum works. Try PAINT MURAL, LOOK or HELP."
#message 17 "You see nothing special about that."

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
display(1, 1, 1); display(2, 1, 7);
if (said("help")) { print(3); }
if (said("look", "room") || said("look", "logic")) { print(9); }
if (said("look", "code")) { print(11); }
if (said("look", "bench")) { print(15); }
if (said("look") || said("look", "gallery") || said("look", "mural")) {
  if (isset(f30)) { print(5); } else { print(2); }
}
if (said("look", "*")) { print(17); }
if (said("talk") || said("talk", "*")) { print(13); }
if (said("take") || said("take", "*")) { print(16); }
if (said("paint", "mural") || said("paint")) {
  if (posn(o0, 45, 112, 110, 167)) {
    if (!isset(f30)) {
      set(f30); addn(v3, 10);
      assignn(v50, 4); load.pic(v50); overlay.pic(v50); show.pic();
      sound(2, f37);
      print(4);
      if (isset(f31) && isset(f32)) { set(f33); print(8); }
    } else { print(5); }
  } else { print(12); }
}
if (said("west")) { print(10); }
if (said("east")) { new.room(2); }
if (equaln(v2, 2)) { new.room(2); }
if (isset(f2) && !isset(f4)) {
  if (equaln(v9, 0)) { print(6); } else { print(14); }
}
return;
`,
  2: String.raw`
#message 1 "ADVENTURE DEPARTMENT: SPRITE LAB"
#message 2 "A tin robot stands beside a big lever. The robot is a flipbook: a few tiny drawings shown one after another. That flipbook is a VIEW. Logic selects the view, loop and cel to show. Walk to the lever and try PULL LEVER."
#message 3 "The lever clunks down and the robot waves! Both are VIEWS: the lever plays its drawings once, the robot repeats his. A condition checks the repair flag, so the lever stays down when you come back. Exhibit two repaired!"
#message 4 "The robot is already awake. It waves again."
#message 5 "Nothing happens. In the lab, try PULL LEVER, LOOK ROBOT or HELP."
#message 6 "Useful commands here: LOOK ROBOT, LOOK LEVER, TALK ROBOT, PULL LEVER, WEST, EAST. Arrows walk."
#message 7 "Exhibit two: HELP. Try PULL LEVER."
#message 8 "${GRADUATION_MESSAGE}"
#message 9 "A friendly tin robot. Its arm is frozen mid-wave. The lever beside it is labelled WAKE."
#message 10 "The robot waves and waves. Its drawings play in a loop, like a flipbook that never ends."
#message 11 "A big red lever, pointing up. Try PULL LEVER."
#message 12 "The lever points down. A flag keeps it there, even if you leave and come back."
#message 13 "The robot is not responding."
#message 14 "BEEP. The robot says thank you, in robot."
#message 15 "You are too far away. Walk over to the lever, then PULL LEVER."
#message 16 "I do not know that word. In the lab, try PULL LEVER or HELP."
#message 17 "You see nothing special about that."
#message 18 "The lab is for looking and pulling, not for that. Try PULL LEVER or HELP."

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
display(1, 1, 1); display(2, 1, 7);
if (said("help")) { print(6); }
if (said("look", "robot")) {
  if (isset(f31)) { print(10); } else { print(9); }
}
if (said("look", "lever")) {
  if (isset(f31)) { print(12); } else { print(11); }
}
if (said("look") || said("look", "room") || said("look", "lab") || said("look", "sprite") || said("look", "logic") || said("look", "code")) { print(2); }
if (said("look", "*")) { print(17); }
if (said("talk") || said("talk", "*")) {
  if (isset(f31)) { print(14); } else { print(13); }
}
if (said("take") || said("take", "*")) { print(18); }
if (said("pull", "lever") || said("pull")) {
  if (posn(o0, 8, 112, 52, 167)) {
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
if (isset(f2) && !isset(f4)) {
  if (equaln(v9, 0)) { print(5); } else { print(16); }
}
return;
`,
  3: String.raw`
#message 1 "ADVENTURE DEPARTMENT: PRIORITY ARCHIVE"
#message 2 "Felix the ferret clerk floats in front of his counter. Every spot on the floor has a secret number that says how far away it is. That number is PRIORITY. Type SHOW PRIORITY to see them all."
#message 3 "Counter:11. Felix:15. Higher is closer."
#message 4 "You change Felix from priority 15 to 10. The counter keeps 11, so it is closer now: it hides his tummy while his head shows above it. Exhibit three repaired!"
#message 5 "Felix stands behind his counter at last. Counter 11 is closer than Felix 10, so the counter covers him."
#message 6 "Useful commands here: LOOK FELIX, TALK FELIX, LOOK COUNTER, SHOW PRIORITY, FIX PRIORITY, WEST."
#message 7 "${GRADUATION_MESSAGE}"
#message 8 "Exhibit three: HELP. Try SHOW PRIORITY."
#message 9 "Counter:11. Felix:10. Lower is farther."
#message 10 "The east wall ends the archive. Return west to the Sprite Lab."
#message 11 "Felix squeaks: I keep floating in front of my counter! Please FIX PRIORITY."
#message 12 "Felix squeaks: Perfect! Now I can sort the archive again. Thank you!"
#message 13 "A long oak counter. Its floor pixels carry priority 11. The lamp above it turns green when the archive is repaired."
#message 14 "Nothing happens. In the archive, try SHOW PRIORITY, FIX PRIORITY or HELP."
#message 15 "I do not know that word. In the archive, try SHOW PRIORITY or HELP."
#message 16 "A small lamp above the counter. Red means the archive is still broken."
#message 17 "The lamp glows green. The archive is repaired."
#message 18 "You see nothing special about that."
#message 19 "Felix would rather you did not. Try SHOW PRIORITY or HELP."

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
display(1, 1, 1); display(2, 1, 8);
if (said("help")) { print(6); }
if (said("look", "counter")) { print(13); }
if (said("look", "lamp")) {
  if (isset(f32)) { print(17); } else { print(16); }
}
if (said("look") || said("look", "room") || said("look", "archive") || said("look", "priority") || said("look", "clerk")) {
  if (isset(f32)) { print(5); } else { print(2); }
}
if (said("look", "*")) { print(18); }
if (said("talk") || said("talk", "*")) {
  if (isset(f32)) { print(12); } else { print(11); }
}
if (said("take") || said("take", "*")) { print(19); }
if (said("show", "priority")) {
  if (isset(f32)) { display(23, 0, 9); } else { display(23, 0, 3); }
  show.pri.screen();
  clear.lines(23, 23, 0);
}
if (said("fix", "priority")) {
  if (!isset(f32)) {
    set(f32); addn(v3, 10); set.priority(o1, 10); set.cel(o2, 1);
    sound(2, f37);
    print(4);
    if (isset(f30) && isset(f31)) { set(f33); print(7); }
  } else { print(5); }
}
if (said("west")) { new.room(2); }
if (said("east")) { print(10); }
if (equaln(v2, 4)) { new.room(2); }
if (isset(f2) && !isset(f4)) {
  if (equaln(v9, 0)) { print(14); } else { print(15); }
}
return;
`,
};

/** Emit explicit native AGI vector rows; useful for solid regions over existing colors. */
function horizontalStrokes(color: number, x1: number, x2: number, y1: number, y2: number): string {
  return [
    `vis ${color}`,
    ...Array.from({ length: y2 - y1 + 1 }, (_, row) => `line ${x1},${y1 + row} ${x2},${y1 + row}`),
  ].join("\n");
}

/** Shared scene contract: flat floor, visible side passages, separate collision/depth. */
function roomPicture(room: number): string {
  const west = room !== 1;
  const east = room !== 3;
  const [westBase, eastBase] = room === 1 ? [132, 128] : room === 2 ? [119, 119] : [124, 128];
  const detail = [ORIGINAL_SCENE_PICTURES[room]!.replace(/\nend\s*$/, "")];
  for (const [x0, x1, open, base] of [
    [0, 7, west, westBase],
    [152, 159, east, eastBase],
  ] as const) {
    // Carry each native side wall to its visible base. At exits the blue floor
    // then runs cleanly through the screen edge; terminal walls continue down.
    detail.push(horizontalStrokes(6, x0, x1, 94, open ? base : 167));
    if (open) {
      detail.push(horizontalStrokes(1, x0, x1, base + 1, 167));
    }
  }
  detail.push("vis off", "pri 0", "line 0,112 159,112");
  // Side walls recede in perspective: their visible base is lower than the
  // rear-wall horizon. Trace those contacts, not just one horizontal line.
  if (room === 1) detail.push("line 8,132 35,112", "line 140,112 151,128");
  if (room === 2) detail.push("line 8,119 26,112", "line 134,112 151,119");
  if (room === 3) detail.push("line 8,124 25,112", "line 134,112 151,128");
  for (const [x0, x1, open, base] of [
    [0, 7, west, westBase],
    [152, 159, east, eastBase],
  ] as const) {
    for (let y = 113; y <= (open ? base : 167); y++) {
      detail.push(`line ${x0},${y} ${x1},${y}`);
    }
  }
  if (room === 3) {
    // Depth follows the actual visible counter. No horizontal floor bands:
    // an ego in front at baseline123 has priority11 and is fully visible.
    detail.push(
      "pri 11",
      "rect 56,85 118,121",
      "fill 57,86",
      "pri 0",
      "line 56,112 56,122 118,122 118,112",
    );
  }
  detail.push("end");
  return detail.join("\n");
}

export const TUTORIAL_PICTURE_SOURCES: Readonly<Record<number, string>> = {
  1: roomPicture(1),
  2: roomPicture(2),
  3: roomPicture(3),
  4: `
# A small hand-authored vector landscape replaces only the blank canvas.
pri off
${horizontalStrokes(15, 57, 98, 35, 72)}
vis 9
rect 57,35 98,72
vis 14
polygon 64,39 66,37 68,39 68,42 66,44 64,42
vis 2
polygon 57,60 67,47 77,59 86,46 98,61 98,72 57,72
vis 7
polygon 64,51 67,47 70,51 67,50
polygon 83,50 86,46 89,50 86,49
vis 11
polygon 82,58 85,58 83,64 91,72 80,72 77,66
vis 6
line 60,68 60,57
vis 2
polygon 57,61 60,53 63,61
fill 66,61 94,66 59,60 61,60
vis 11
fill 81,67
vis 14
fill 66,40
vis 9
fill 58,36
end
`,
};

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
      revision: resourceRevision(introPayload),
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

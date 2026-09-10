/**
 * Synthetic AGI cartridge and route for zero-skip offline CI verification.
 * Zero external runtime dependencies, authentic AGI 2.936 bytecode.
 */
import { createContainer } from "../container/container.ts";
import { assembleLogic } from "../logic/assembler.ts";
import { buildWordsTok } from "../logic/words.ts";
import { compilePictureSource } from "../picture/source.ts";
import { buildView } from "../view/view.ts";
import { buildSound, buildObjectFile } from "../agent/tools.ts";

export const SYNTHETIC_WORDS: [string, number][] = [
  ["go", 0],
  ["the", 0],
  ["look", 100],
  ["east", 101],
  ["west", 102],
  ["help", 103],
  ["answer", 104],
  ["test", 105],
];

export const SYNTHETIC_WORDS_HASH =
  "d00cc5981820a66d3a56c802f8d747a73fe153d394a80463accf313947623fa1";

export const SYNTHETIC_OBJECT_HASH =
  "f58e6871c43d8639afca350562544a1f040dc94475c545ca069f4e69635d6425";

export interface SyntheticGamePayload {
  files: Record<string, Uint8Array>;
  words: [string, number][];
  title: string;
  roomGeneration: boolean;
  metadata: {
    description: string;
    author: string;
    license: string;
  };
}

export function buildSyntheticGame(): SyntheticGamePayload {
  const dict = new Map(SYNTHETIC_WORDS);
  const wordsTok = buildWordsTok(SYNTHETIC_WORDS.map(([word, id]) => ({ word, id })));
  const objects = buildObjectFile([{ name: "key", startingRoom: 1 }]);
  const sound1 = buildSound([
    {
      notes: [
        { note: "A4", duration: 4 },
        { note: "rest", duration: 1 },
      ],
    },
  ]);

  const cel = {
    width: 4,
    height: 4,
    pixels: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  };
  const view0 = buildView({
    loops: [{ cels: [cel, cel] }, { cels: [cel, cel] }, { cels: [cel, cel] }, { cels: [cel, cel] }],
  });
  const view1 = buildView({ loops: [{ cels: [cel] }] });
  const pic1 = compilePictureSource("vis 1\nrect 0,0 159,167\n").bytes;
  const pic2 = compilePictureSource("vis 2\nrect 0,0 159,167\n").bytes;

  const log0 = assembleLogic(
    `
hold.key();
if (!isset(f200)) {
  set(f200);
  assignn(v0, 1);
  new.room.v(v0);
}
call.v(v0);
return;
`,
    { dictionary: dict },
  ).payload;

  const log1 = assembleLogic(
    `
#message 1 "Welcome to Room 1"
#message 2 "Looking at Room 1"
if (isset(f5)) {
  load.pic(v0);
  draw.pic(v0);
  show.pic();
  load.view(0);
  set.view(o0, 0);
  animate.obj(o0);
  if (equaln(v1, 2)) {
    position(o0, 140, 130);
  } else {
    position(o0, 20, 130);
  }
  draw(o0);
  load.view(1);
  set.view(o1, 1);
  animate.obj(o1);
  position(o1, 80, 130);
  ignore.objs(o1);
  draw(o1);
  stop.cycling(o1);
  load.sound(1);
  sound(1, f30);
  accept.input();
  display(2, 5, 1);
}
if (said("look")) {
  print(2);
}
if (said("east") || posn(o0, 150, 110, 159, 150)) {
  new.room(2);
}
if (equaln(v2, 2)) {
  new.room(2);
}
return;
`,
    { dictionary: dict },
  ).payload;

  const log2 = assembleLogic(
    `
#message 1 "Enter code: "
#message 2 "Prompt completed"
if (isset(f5)) {
  load.pic(v0);
  draw.pic(v0);
  show.pic();
  load.view(0);
  set.view(o0, 0);
  animate.obj(o0);
  position(o0, 20, 130);
  draw(o0);
  accept.input();
  display(2, 5, 1);
}
if (said("west") || posn(o0, 0, 110, 10, 150)) {
  new.room(1);
}
if (equaln(v2, 4)) {
  new.room(1);
}
if (said("answer")) {
  get.num(1, v60);
  addn(v3, 50);
  set(f32);
  print(2);
}
return;
`,
    { dictionary: dict },
  ).payload;

  const container = createContainer();
  container.putFile("WORDS.TOK", wordsTok);
  container.putFile("OBJECT", objects);
  container.putResource("logic", 0, log0);
  container.putResource("logic", 1, log1);
  container.putResource("logic", 2, log2);
  container.putResource("picture", 1, pic1);
  container.putResource("picture", 2, pic2);
  container.putResource("view", 0, view0);
  container.putResource("view", 1, view1);
  container.putResource("sound", 1, sound1);

  return {
    files: Object.fromEntries([...container.files].map(([name, bytes]) => [name, bytes.slice()])),
    words: SYNTHETIC_WORDS.map(([word, id]) => [word, id]),
    title: "Synthetic Test Chamber",
    roomGeneration: false,
    metadata: {
      description: "Autonomous verification fixture for simulation, replay, and playback.",
      author: "Monotio",
      license: "MIT",
    },
  };
}

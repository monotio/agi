/**
 * Deterministic provider-free project factory for new local projects.
 *
 * Three AGI 2.936 templates with editable sources:
 * Starter has one illustrated room, a walking hero and shared menus/saving.
 * Boilerplate has the shared boot/death resources and an empty black room.
 * Blank has empty resource directories, WORDS and OBJECT. It cannot boot:
 * the app must open its workspace empty state until LOGIC 0 is authored.
 * Call isPlayableProject before starting the engine. Fresh project/storage
 * identities are assigned by the caller, never here.
 *
 * Everything returned is detached: `files()` hands out fresh buffer copies,
 * and recompiling a supplied source with the supplied profile, dictionary
 * and bindings reproduces the stored resource byte for byte.
 */

import { createContainer, openContainer } from "../container/container.ts";
import { buildWordsTok, type WordEntry } from "../logic/words.ts";
import { compilePictureSource } from "../picture/source.ts";
import { PROFILES, type AgiProfile, type ProfileId } from "../runtime/profile.ts";
import { buildSound } from "../sound/build.ts";
import { createSoundDocument } from "../sound/document.ts";
import { applySoundPreset } from "../sound/presets.ts";
import { compileSoundDocumentSource, type SoundSourceBody } from "../sound/source.ts";
import { buildView, type BuildViewInput } from "../view/view.ts";
import { compileViewSource } from "../view/viewSource.ts";
import {
  BASE_TEMPLATE_DEATH_LOGIC_SOURCE,
  BASE_TEMPLATE_DEATH_TRACKS,
  BASE_TEMPLATE_LOGIC0_SOURCE,
  TEMPLATE_DEATH_LOGIC,
  TEMPLATE_DEATH_SOUND,
} from "./baseTemplate.ts";
import { buildObjectFile } from "./inventory.ts";
import { compileProjectLogic } from "./projectLogic.ts";
import { computeResourceRevision } from "./resourceRevision.ts";

export type StarterKind = "starter" | "boilerplate" | "blank";

type StarterBindingKind = "logic" | "picture" | "view" | "sound" | "flag" | "variable";

interface StarterBinding {
  readonly kind: StarterBindingKind;
  readonly num: number;
  /** Template-supplied: folds under Built-in in Game state. */
  readonly builtin?: boolean;
}

export interface StarterProject {
  readonly kind: StarterKind;
  readonly profileId: ProfileId;
  /** Deterministic seed provenance: stable template identity, not project identity. */
  readonly seed: {
    readonly templateId: string;
    readonly templateRevision: number;
    /** Released-format resource revision of the detached files. */
    readonly digest: string;
  };
  /** Authored, editable definitions beside the compiled bytes. */
  readonly sources: {
    readonly logics: ReadonlyMap<number, string>;
    readonly pictures: ReadonlyMap<number, string>;
    readonly views: ReadonlyMap<number, BuildViewInput>;
    readonly words: ReadonlyMap<string, number>;
    readonly objects: readonly { readonly name: string; readonly startingRoom: number }[];
    readonly sounds: ReadonlyMap<number, SoundSourceBody>;
  };
  /** Actual names allocated by the seed; ordinary uses, never reserved ownership. */
  readonly bindings: Readonly<Record<string, StarterBinding>>;
  /** Fresh native game files on every call; mutating them changes nothing stored. */
  files(): ReadonlyMap<string, Uint8Array>;
}

const STARTER_PROFILE_ID: ProfileId = "2.936";
const STARTER_PROFILE: AgiProfile = PROFILES[STARTER_PROFILE_ID]!;
/** Bump the revision of each template whose contents change. */
const STARTER_TEMPLATE_REVISION: Record<StarterKind, number> = {
  starter: 6,
  boilerplate: 3,
  blank: 2,
};

/** VIEW 0 is the hero. */
const STARTER_EGO_VIEW = 0;
/** The starter listen-cue SOUND number and its completion flag. */
const STARTER_CHIME_SOUND = 1;
const STARTER_CHIME_FLAG = 204;

// ---------- boilerplate ----------

const BOILERPLATE_ROOM1_SOURCE = `// Show the first room and let the player type commands.
if (isset(f5)) {
  assignn(v50, first_pic);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  accept.input();
  print("Your game starts here.");
}
return;
`;

const BOILERPLATE_PIC1_SOURCE = `# Fill the empty room with black.
vis 0
fill 0,0
end
`;

const BOILERPLATE_BINDINGS: Record<string, StarterBinding> = {
  boot_logic: { kind: "logic", num: 0, builtin: true },
  first_room: { kind: "logic", num: 1, builtin: true },
  first_pic: { kind: "picture", num: 1, builtin: true },
  death_logic: { kind: "logic", num: TEMPLATE_DEATH_LOGIC, builtin: true },
  death_sound: { kind: "sound", num: TEMPLATE_DEATH_SOUND, builtin: true },
  dead: { kind: "flag", num: 202, builtin: true },
  death_done: { kind: "flag", num: 201, builtin: true },
  death_choice: { kind: "flag", num: 203, builtin: true },
  death_cursor: { kind: "variable", num: 250, builtin: true },
};

// ---------- starter ----------

const STARTER_ROOM1_SOURCE = `// On room entry, draw the clearing and place the hero.
if (isset(f5)) {
  assignn(v50, clearing_pic);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  set.horizon(74);
  animate.obj(o0);
  load.view(ego_view);
  set.view(o0, ego_view);
  set.loop(o0, 2);
  position(o0, 80, 140);
  draw(o0);
  player.control();
  accept.input();
}
// Stand on cel 0 when still; show walking poses while moving.
if (equaln(v6, 0)) {
  stop.cycling(o0);
  set.cel(o0, 0);
} else {
  start.cycling(o0);
}
// Reply to the commands the player types.
if (said("look")) { print("You stand in a sunny clearing. A path leads past a grey cottage and a big leafy tree."); }
if (said("look", "cottage")) { print("The grey cottage has a red roof, green shutters and a red door."); }
if (said("look", "tree")) { print("A big leafy tree spreads its branches above a sturdy trunk."); }
if (said("open", "door")) { print("The cottage door is locked. Perhaps you will add a key."); }
if (said("help")) { print("Type a command and press ENTER. The arrow keys walk. ESC opens the menu; F1 shows this help."); }
// Play a short birdsong and describe it.
if (said("listen")) {
  load.sound(chime_sound);
  sound(chime_sound, chime_done);
  print("A meadowlark answers from the trees.");
}
if (said("die")) { print("The ground gives way under you. It was lava all along."); call(death_logic); }
return;
`;

const STARTER_PIC1_SOURCE = `# Meadow: a cottage, a tree and a path under a sunny sky.
# Draw and fill each object first, then the land and sky around it:
# a fill only floods white, so the objects' outlines hold it back.
# @item sun "Sun" art
vis 14
polygon 152,14 151,18 148,21 146,21 143,18 142,14 142,10 143,6 146,3 148,3 151,6 152,10
fill 147,12
# @end
# @item cottage "Cottage" mixed
pri 9
vis 8
rect 18,41 22,52
fill 20,45
vis 0
line 17,40 23,40
vis 6
rect 9,74 15,81
rect 29,74 35,81
rect 19,71 25,96
vis 11
fill 12,77 32,77
vis 4
fill 22,84
vis 6
line 12,75 12,80
line 10,77 14,77
line 32,75 32,80
line 30,77 34,77
vis 2
line 8,74 8,81
line 16,74 16,81
line 28,74 28,81
line 36,74 36,81
vis 14
line 23,84
vis 7
rect 6,67 38,96
fill 8,70
vis 8
line 8,82 16,82
line 28,82 36,82
line 7,68 37,68
line 6,96 38,96
line 18,97 26,97
pri 8
vis 6
polygon 43,78 48,76 48,83 43,85
vis 11
fill 45,80
vis 8
line 38,67 45,48 52,60 52,90 38,96
fill 46,70
vis 0
line 38,96 52,90
vis 6
line 45,77 45,84
pri 9
vis 4
line 11,48 7,57 3,67 38,67 45,48 52,60
line 46,48 53,61
vis 12
line 11,48 17,48
line 23,48 45,48
vis 4
fill 30,58
vis 8
line 9,54 41,54
line 7,60 39,60
vis 2
pen 2
plot 3,95 5,93 7,95 35,95 37,93 39,95 41,94
pri 8
plot 51,89 53,87 55,89
pri off
vis 6
polygon 20,98 26,98 36,106 56,115 72,120 68,132 50,121 30,109
fill 25,100
# @end
# @item tree "Tree" mixed
pri 10
vis 2
polygon 135,31 137,32 139,32 141,34 142,36 143,39 144,42 147,42 151,43 153,46 154,47 156,52 155,58 153,63 155,70 153,74 150,78 147,79 144,79 142,78 139,77 138,76 136,74 135,74 134,75 132,77 130,79 128,80 126,80 123,79 120,77 118,74 117,69 116,63 114,58 115,52 117,47 119,46 121,45 124,44 124,39 126,36 127,34 129,32 131,32 133,31
fill 135,60
vis 10
line 132,33 137,34 141,36 143,40 143,43
line 133,34 137,35 140,37 142,41
line 146,44 150,45 153,47 154,51 154,54
line 146,45 149,46 152,48 154,52
line 121,47 124,48 127,50 129,54 129,57
line 125,62 129,62 132,65 134,69 134,71
line 143,61 148,61 151,64 153,68 153,70
vis 6
line 132,77 132,100 130,105 128,107 142,107 140,105 138,100 138,76
fill 135,90
pri off
# @end
# @item path "Path" art
vis 6
polygon 58,167 67,140 71,118 73,100 75,86 77,74 79,74 81,86 85,100 91,118 97,140 102,167
fill 80,150
# @end
# @item meadow "Meadow" art
vis 10
line 0,74 5,74
line 53,74 118,74
line 153,74 159,74
fill 20,140 130,140 60,90
# @end
# @item hills "Hills" art
vis 2
line 0,59 6,58 7,57
line 53,62 60,55 70,54 80,56 90,59 98,58 106,61 117,69
fill 2,68 60,66
# @end
# @item sky "Sky" art
vis 9
polygon 26,22 28,18 32,17 35,13 40,11 45,13 48,16 52,16 55,19 54,22
vis 11
line 0,46 17,46
line 23,46 119,46
line 153,46 159,46
fill 60,50 158,60 4,50
vis 9
fill 80,10
# @end
# @item flowers "Flowers" art
pen 0
vis 13
plot 14,104 17,106 12,108 112,96 115,98 140,130 143,128 141,133 30,150 34,152
vis 14
plot 16,108 113,99 145,131 32,148 52,120 54,122 124,152 127,150
vis 2
plot 14,105 17,107 12,109 112,97 115,99 140,131 143,129 141,134 30,151 34,153 16,109 113,100 145,132 32,149 52,121 54,123 124,153 127,151
# @end
# @item horizon "Horizon" walk
vis off
pri 0
line 0,74 159,74
# @end
# @item cottage-wall "Cottage wall" walk
line 0,97 40,97 54,91 54,75
# @end
# @item tree-base "Tree base" walk
rect 125,103 143,107
# @end
end
`;

/** Hero loops: right, left (mirrored), toward and away; cel 0 stands still. */
export const STARTER_EGO_VIEW_SOURCE = `description "The hero: four walking directions."
view
cel stand_r 7 24 5
..000..
.00000.
.00000.
.000CC.
.00C0C.
.00CCC.
..0CC..
...CC..
..333..
..3333.
..3333.
..3333.
..3C33.
..3C33.
..1C11.
..111..
..111..
..111..
..111..
..111..
..111..
..111..
..111..
..0000.
endcel
cel stride_r copy stand_r
row 11 ..C33C.
row 12 .C333C.
row 13 ..333..
row 14 ..111..
row 15 ..111..
row 16 ..111..
row 17 .11.11.
row 18 .11.11.
row 19 .11.11.
row 20 11...11
row 21 11...11
row 22 11...11
row 23 00...00
endcel
cel pass_r copy stand_r
row 12 ..3333.
row 13 ..3C33.
row 14 ..1C11.
row 19 .1111..
row 20 .1.11..
row 21 .0.11..
row 22 ...11..
row 23 ..000..
endcel
cel stand_f 7 24 5
..000..
.00000.
.00000.
.0CCC0.
.C0C0C.
.CCCCC.
..C4C..
...C...
.33333.
.33333.
.C333C.
.C333C.
.C333C.
.C111C.
..111..
..111..
..1.1..
..1.1..
..1.1..
..1.1..
..1.1..
..1.1..
..1.1..
.00.00.
endcel
cel step_f copy stand_f
row 12 .C333C.
row 13 .C111..
row 21 .00.1..
row 22 ....1..
row 23 ....00.
endcel
cel step2_f copy stand_f
row 12 .C333C.
row 13 ..111C.
row 21 ..1.00.
row 22 ..1....
row 23 .00....
endcel
cel stand_b copy stand_f
row 3 .00000.
row 4 .00000.
row 5 .00000.
row 6 ..000..
endcel
cel step_b copy step_f
row 3 .00000.
row 4 .00000.
row 5 .00000.
row 6 ..000..
endcel
cel step2_b copy step2_f
row 3 .00000.
row 4 .00000.
row 5 .00000.
row 6 ..000..
endcel
loop 0 stand_r stride_r pass_r stride_r
loop 1 mirror 0
loop 2 stand_f step_f stand_f step2_f
loop 3 stand_b step_b stand_b step2_b
endview
`;

/**
 * Words for the room commands, with common synonyms and ignored filler words.
 */
const STARTER_WORD_ENTRIES: readonly WordEntry[] = [
  { word: "a", id: 0 },
  { word: "an", id: 0 },
  { word: "at", id: 0 },
  { word: "the", id: 0 },
  { word: "examine", id: 100 },
  { word: "l", id: 100 },
  { word: "look", id: 100 },
  { word: "x", id: 100 },
  { word: "help", id: 101 },
  { word: "hint", id: 101 },
  { word: "die", id: 102 },
  { word: "hear", id: 103 },
  { word: "listen", id: 103 },
  { word: "cottage", id: 104 },
  { word: "tree", id: 105 },
  { word: "open", id: 106 },
  { word: "door", id: 107 },
];

const STARTER_BINDINGS: Record<string, StarterBinding> = {
  ...BOILERPLATE_BINDINGS,
  clearing_pic: { kind: "picture", num: 1, builtin: true },
  ego_view: { kind: "view", num: STARTER_EGO_VIEW, builtin: true },
  chime_sound: { kind: "sound", num: STARTER_CHIME_SOUND, builtin: true },
  chime_done: { kind: "flag", num: STARTER_CHIME_FLAG, builtin: true },
};

/**
 * SOUND 1's editable source: the shared "discovery" cue preset stored as a
 * tagged `agi.sound-document` envelope, so the project opens it in the sound
 * editor with stable event ids — the same original cue the preset offers.
 */
function starterChimeSource(): SoundSourceBody {
  return applySoundPreset(
    createSoundDocument({ profileId: STARTER_PROFILE_ID }),
    "discovery",
  ).serialize();
}

function compileAuthored(
  source: string,
  bindings: Readonly<Record<string, StarterBinding>>,
  dictionary: ReadonlyMap<string, number>,
): Uint8Array {
  return compileProjectLogic(source, {
    profile: STARTER_PROFILE,
    dictionary,
    bindings,
  }).assembly.payload;
}

/**
 * Build a complete detached initial project snapshot for `kind`.
 * Deterministic for identical inputs: the same call always yields the same
 * files, sources, bindings and seed digest, and never the same buffers.
 */
export function createStarterProject(kind: StarterKind): StarterProject {
  if (kind !== "starter" && kind !== "boilerplate" && kind !== "blank") {
    throw new Error(`Unknown starter project kind: ${String(kind)}`);
  }
  const profile = STARTER_PROFILE;
  const bindings = Object.fromEntries(
    Object.entries(
      kind === "starter" ? STARTER_BINDINGS : kind === "boilerplate" ? BOILERPLATE_BINDINGS : {},
    ).map(([name, binding]) => [name, { ...binding }]),
  );
  const wordEntries = kind === "starter" ? STARTER_WORD_ENTRIES : [];
  const dictionary = new Map<string, number>(wordEntries.map((e) => [e.word, e.id]));
  const objects: { name: string; startingRoom: number }[] = [];

  const logics = new Map<number, string>();
  const pictures = new Map<number, string>();
  const views = new Map<number, BuildViewInput>();
  const sounds = new Map<number, SoundSourceBody>();

  if (kind !== "blank") {
    logics.set(0, BASE_TEMPLATE_LOGIC0_SOURCE);
    if (kind === "starter") {
      logics.set(1, STARTER_ROOM1_SOURCE);
      pictures.set(1, STARTER_PIC1_SOURCE);
      views.set(STARTER_EGO_VIEW, compileViewSource(STARTER_EGO_VIEW_SOURCE));
      sounds.set(STARTER_CHIME_SOUND, starterChimeSource());
    } else {
      logics.set(1, BOILERPLATE_ROOM1_SOURCE);
      pictures.set(1, BOILERPLATE_PIC1_SOURCE);
    }
    logics.set(TEMPLATE_DEATH_LOGIC, BASE_TEMPLATE_DEATH_LOGIC_SOURCE);
    sounds.set(
      TEMPLATE_DEATH_SOUND,
      BASE_TEMPLATE_DEATH_TRACKS.map((track) => ({
        notes: track.notes.map((note) => ({ ...note })),
      })),
    );
  }

  const container = createContainer();
  container.putFile("WORDS.TOK", buildWordsTok(wordEntries));
  container.putFile("OBJECT", buildObjectFile(objects, profile));
  for (const [num, source] of logics) {
    container.putResource("logic", num, compileAuthored(source, bindings, dictionary));
  }
  for (const [num, source] of pictures) {
    container.putResource("picture", num, compilePictureSource(source, { profile }).bytes);
  }
  for (const [num, input] of views) {
    container.putResource("view", num, buildView(input, profile));
  }
  for (const [num, body] of sounds) {
    container.putResource(
      "sound",
      num,
      Array.isArray(body) ? buildSound(body) : compileSoundDocumentSource(body, profile.id),
    );
  }

  const stored = new Map(
    [...container.files].map(([name, bytes]) => [name, new Uint8Array(bytes)]),
  );
  const seed = Object.freeze({
    templateId: `agihere.${kind}`,
    templateRevision: STARTER_TEMPLATE_REVISION[kind],
    digest: computeResourceRevision(Object.fromEntries(stored)),
  });
  return Object.freeze({
    kind,
    profileId: STARTER_PROFILE_ID,
    seed,
    sources: { logics, pictures, views, words: dictionary, objects, sounds },
    bindings,
    files(): ReadonlyMap<string, Uint8Array> {
      return new Map([...stored].map(([name, bytes]) => [name, new Uint8Array(bytes)]));
    },
  });
}

/** LOGIC 0 is the boot entry point. Blank projects open in the workspace empty state. */
export function isPlayableProject(files: ReadonlyMap<string, Uint8Array>): boolean {
  return openContainer(files).getResource("logic", 0) !== null;
}

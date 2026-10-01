/**
 * Deterministic provider-free project factory for new local projects.
 *
 * `createStarterProject("blank")` returns the smallest editable game: a
 * minimal boot LOGIC 0, one room drawing an empty picture, an empty OBJECT
 * table and a valid empty WORDS.TOK — no actor, menu, death or story.
 * `createStarterProject("starter")` returns the complete playable seed: the
 * shared boot/menu boilerplate, the shared death LOGIC 255 and SOUND 255,
 * a room with a simple original picture, an original four-direction
 * animated ego, and a small editable SOUND 1 cue answering listen. Both
 * target AGI 2.936 and carry authored sources, real
 * named bindings and deterministic seed provenance; fresh project/storage
 * identities are assigned by the caller, never here.
 *
 * Everything returned is detached: `files()` hands out fresh buffer copies,
 * and recompiling a supplied source with the supplied profile, dictionary
 * and bindings reproduces the stored resource byte for byte.
 */

import { createContainer } from "../container/container.ts";
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

export type StarterKind = "blank" | "starter";

type StarterBindingKind = "logic" | "picture" | "view" | "sound" | "flag" | "variable";

interface StarterBinding {
  readonly kind: StarterBindingKind;
  readonly num: number;
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
/**
 * Explicit revision per seed kind: bump the one whose contents change.
 * Revision 2 of the starter adds the meadowlark LISTEN answer and its
 * editable SOUND 1 cue; existing projects are never migrated.
 */
const STARTER_TEMPLATE_REVISION: Record<StarterKind, number> = { blank: 1, starter: 2 };

/** The starter ego VIEW number. */
const STARTER_EGO_VIEW = 1;
/** The starter listen-cue SOUND number and its completion flag. */
const STARTER_CHIME_SOUND = 1;
const STARTER_CHIME_FLAG = 204;

// ---------- blank ----------

const BLANK_LOGIC0_SOURCE = `// Logic 0 runs every interpreter cycle. The f200 block is the first-cycle
// boot: it enters room 1. Every cycle after that calls the current room's
// logic; v0 always holds the current room number.
if (!isset(f200)) {
  set(f200);
  configure.screen(1, 22, 0);
  status.line.on();
  set(f9);
  assignn(v0, 1);
  new.room.v(v0);
}
call.v(v0);
return;
`;

const BLANK_ROOM1_SOURCE = `// Room 1 — an empty room showing an empty picture. The f5 block runs once
// on room entry; everything below it runs every cycle.
if (isset(f5)) {
  assignn(v50, first_pic);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  accept.input();
}
return;
`;

const BLANK_PIC1_SOURCE = `# An empty picture — draw on it or replace it.
end
`;

const BLANK_BINDINGS: Record<string, StarterBinding> = {
  boot_logic: { kind: "logic", num: 0 },
  first_room: { kind: "logic", num: 1 },
  first_pic: { kind: "picture", num: 1 },
};

// ---------- starter ----------

const STARTER_ROOM1_SOURCE = `// Room 1 — a sunny clearing. The f5 block runs once on room entry: draw
// the picture, place ego, then hand control to the player. Everything below
// runs every cycle: each said() answers one parser command, and when none
// matched (f4 still clear) logic 0 prints its generic fallback.
#message 1 "You stand in a sunny clearing. A worn path leads north into the trees."
#message 2 "Type a command and press ENTER. The arrow keys walk. ESC opens the menu; F1 shows this help."
#message 3 "The ground gives way under you. It was lava all along."
#message 4 "A meadowlark answers from the trees."
if (isset(f5)) {
  assignn(v50, clearing_pic);
  load.pic(v50);
  draw.pic(v50);
  show.pic();
  set.horizon(54);
  animate.obj(o0);
  load.view(ego_view);
  set.view(o0, ego_view);
  set.loop(o0, 2);
  position(o0, 80, 140);
  draw(o0);
  player.control();
  accept.input();
}
if (said("look")) { print(m1); }
if (said("help")) { print(m2); }
// Playing a cue is load.sound plus sound(n, flag): the flag sets when the
// cue finishes. chime_sound is a small editable cue — a resource like any
// other, with its source on record. It starts before the print window opens.
if (said("listen")) {
  load.sound(chime_sound);
  sound(chime_sound, chime_done);
  print(m4);
}
if (said("die")) { print(m3); call(death_logic); }
return;
`;

const STARTER_PIC1_SOURCE = `# A sunny clearing. Draw and fill each shape before the surrounding grass.
vis 6
polygon 28,56 34,56 34,88 28,88
fill 31,72
vis 10
polygon 16,44 22,32 42,32 48,44 48,56 16,56
fill 32,44
vis 14
polygon 130,12 139,12 143,17 143,22 139,27 130,27 126,22 126,17
fill 135,18
vis 6
polygon 70,53 82,53 116,167 40,167
fill 76,110
vis 2
line 0,52 15,52
line 49,52 159,52
fill 5,150
fill 140,150
vis 9
fill 5,20
end
`;

/**
 * The starter ego: an original four-direction walker in VIEW source. Loops
 * are 0 right, 1 left (mirrored), 2 front, 3 back; each loop alternates a
 * standing cel with two distinct stride poses.
 */
export const STARTER_EGO_VIEW_SOURCE = `description "The hero: four walking directions."
view
cel stand_r 8 30 5
..0000..
.000000.
.000666.
.000660.
.000666.
..0666..
...666..
..11111.
.111111.
.111116.
.111116.
.111116.
.111116.
.111116.
.111116.
.111116.
.111111.
.000000.
.888888.
.888888.
.888888.
.888888.
.888.88.
.888.88.
.888.88.
.888.88.
.888.88.
.888.88.
.000.00.
.000.00.
endcel
cel stride_a 10 30 5
...0000...
..000000..
..000666..
..000660..
..000666..
...0666...
....666...
...11111..
..111111..
..1111166.
..1111166.
..1111166.
..1111166.
..1111166.
..1111166.
..111111..
..111111..
..000000..
..888888..
..888888..
..888888..
..88.888..
.88...888.
.88....88.
88.....88.
88......88
88......88
88......88
00......00
00......00
endcel
cel stride_b 10 30 5
...0000...
..000000..
..000666..
..000660..
..000666..
...0666...
....666...
...11111..
..111111..
.6611111..
.6611111..
.6611111..
.6611111..
.6611111..
.6611111..
..111111..
..111111..
..000000..
..888888..
..888888..
..888888..
..888888..
.88..888..
88...888..
88...88...
88...88...
88...00...
88........
00........
00........
endcel
cel stand_f 8 30 5
..0000..
.000000.
.066660.
.066660.
.066660.
..6666..
..6666..
.111111.
61111116
61111116
61111116
61111116
61111116
61111116
61111116
61111116
.111111.
.000000.
.888888.
.888888.
.888888.
.88..88.
.88..88.
.88..88.
.88..88.
.88..88.
.88..88.
.88..88.
.00..00.
.00..00.
endcel
cel front_a 8 30 5
..0000..
.000000.
.066660.
.066660.
.066660.
..6666..
..6666..
.111111.
61111116
61111116
61111116
61111116
61111116
.1111116
.1111116
.1111116
.111111.
.000000.
.888888.
.888888.
.888888.
.88..88.
.88..88.
.88..88.
.88...8.
.88...8.
.88...8.
.88.....
.00...0.
.00.....
endcel
cel front_b 8 30 5
..0000..
.000000.
.066660.
.066660.
.066660.
..6666..
..6666..
.111111.
61111116
61111116
61111116
61111116
61111116
6111111.
6111111.
6111111.
.111111.
.000000.
.888888.
.888888.
.888888.
.88..88.
.88..88.
.88..88.
.8...88.
.8...88.
.8...88.
.....88.
.0...00.
.....00.
endcel
cel stand_b copy stand_f
row 2 .000000.
row 3 .000000.
row 4 .000000.
endcel
cel back_a copy front_a
row 2 .000000.
row 3 .000000.
row 4 .000000.
endcel
cel back_b copy front_b
row 2 .000000.
row 3 .000000.
row 4 .000000.
endcel
loop 0 stand_r stride_a stand_r stride_b
loop 1 mirror 0
loop 2 stand_f front_a stand_f front_b
loop 3 stand_b back_a stand_b back_b
endview
`;

/**
 * The starter dictionary: one verb group each for look, help, listen and
 * the authored death command, plus the ordinary ignored filler words.
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
];

const STARTER_BINDINGS: Record<string, StarterBinding> = {
  boot_logic: { kind: "logic", num: 0 },
  first_room: { kind: "logic", num: 1 },
  clearing_pic: { kind: "picture", num: 1 },
  ego_view: { kind: "view", num: STARTER_EGO_VIEW },
  chime_sound: { kind: "sound", num: STARTER_CHIME_SOUND },
  chime_done: { kind: "flag", num: STARTER_CHIME_FLAG },
  death_logic: { kind: "logic", num: TEMPLATE_DEATH_LOGIC },
  death_sound: { kind: "sound", num: TEMPLATE_DEATH_SOUND },
  dead: { kind: "flag", num: 202 },
  death_done: { kind: "flag", num: 201 },
  death_choice: { kind: "flag", num: 203 },
  death_cursor: { kind: "variable", num: 250 },
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
  if (kind !== "blank" && kind !== "starter") {
    throw new Error(`Unknown starter project kind: ${String(kind)}`);
  }
  const profile = STARTER_PROFILE;
  const bindings = Object.fromEntries(
    Object.entries(kind === "starter" ? STARTER_BINDINGS : BLANK_BINDINGS).map(
      ([name, binding]) => [name, { ...binding }],
    ),
  );
  const wordEntries = kind === "starter" ? STARTER_WORD_ENTRIES : [];
  const dictionary = new Map<string, number>(wordEntries.map((e) => [e.word, e.id]));
  const objects: { name: string; startingRoom: number }[] = [];

  const logics = new Map<number, string>();
  const pictures = new Map<number, string>();
  const views = new Map<number, BuildViewInput>();
  const sounds = new Map<number, SoundSourceBody>();

  if (kind === "blank") {
    logics.set(0, BLANK_LOGIC0_SOURCE);
    logics.set(1, BLANK_ROOM1_SOURCE);
    pictures.set(1, BLANK_PIC1_SOURCE);
  } else {
    logics.set(0, BASE_TEMPLATE_LOGIC0_SOURCE);
    logics.set(1, STARTER_ROOM1_SOURCE);
    logics.set(TEMPLATE_DEATH_LOGIC, BASE_TEMPLATE_DEATH_LOGIC_SOURCE);
    pictures.set(1, STARTER_PIC1_SOURCE);
    views.set(STARTER_EGO_VIEW, compileViewSource(STARTER_EGO_VIEW_SOURCE));
    sounds.set(STARTER_CHIME_SOUND, starterChimeSource());
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

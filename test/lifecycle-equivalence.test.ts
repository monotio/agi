import { describe, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openContainer } from "../src/container/container.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import type { Engine, TraceRecord } from "../src/runtime/engine.ts";
import { AGI_KEY } from "../src/runtime/keys.ts";
import { decodeSave } from "../src/runtime/persistence.ts";
import { INTERPRETER_FILES, detectProfile, detectVersionString } from "../src/runtime/profile.ts";
import { rngDraw } from "../src/runtime/rng.ts";
import { findFixture, fixtureSkip, scanFixtures, type DiscoveredFixture } from "./fixtures.ts";
import type { GameFixture } from "./game-fixture.ts";
import { manualCheck } from "./speedrun/kq4.ts";
import { ageQuiz } from "./speedrun/lsl1.ts";
import { Manhunter, opening as mh1Opening } from "./speedrun/mh1.ts";
import { Mh2, opening as mh2Opening } from "./speedrun/mh2.ts";
import { Speedrun } from "./speedrun/runner.ts";

/**
 * Player-visible rule: after a restart or restore the game offers the same
 * menu, keys and controls as before.
 *
 * Every installed edition boots cold and plays a fixed input script to a
 * stable playable point. Restart: the game's own restart key with the
 * confirmation accepted, the same script again, and a snapshot compared with
 * the cold one. Restore: the game's own save key at that point, a walk and a
 * sound toggle, then the game's own restore key; the state the restore hands
 * back to the game's logic is compared with the state the game saved, and
 * the settled screen and menu with those after the save.
 *
 * Every difference is listed below, either as original behavior with its
 * docs/fidelity.md evidence or as a pending engine defect.
 */

type Phase = "restart" | "restore";
type Snapshot = Record<string, string>;

interface Edition {
  readonly label: string;
  /** Catalog alias or WORDS.TOK hash, for the driver's per-game checks. */
  readonly game: string;
  readonly fixture: () => DiscoveredFixture | null;
  readonly skip: () => false | string;
  /** Inputs from a cold boot, or from an accepted restart, to the stable playable point. */
  readonly reach: (run: Speedrun) => void;
  readonly restartKey?: number;
  /** Set when the game has no restart.game action: what it does instead. */
  readonly noRestart?: string;
  /** null: the game has no save action. */
  readonly saveKey?: number | null;
  readonly restoreKey?: number;
  /**
   * Pending engine defect: the game's restore never reaches a saved image.
   * The test fails once it does, so the fix removes the entry.
   */
  readonly restoreBlocked?: string;
  /** No checked route: a cold boot that does not reach the point skips the edition. */
  readonly unrouted?: boolean;
}

const ENTER_ONLY = [AGI_KEY.ENTER] as const;

/**
 * Advance until `goal` and an idle screen hold for two seconds, pressing the
 * nudge keys in turn every half second while the goal is not met: Enter
 * through title screens, Space where a title asks for it.
 */
function settle(
  run: Speedrun,
  goal: () => boolean,
  label: string,
  { max = 12000, nudge = ENTER_ONLY }: { max?: number; nudge?: readonly number[] } = {},
): void {
  const e = run.engine;
  let stable = 0;
  let pressed = 0;
  for (let t = 0; stable < 120; t++) {
    if (t >= max) assert.fail(`${label} within ${max} ticks: ${JSON.stringify(run.state())}`);
    const ready = goal() && e.modalKind === null && !e.continuationPending;
    stable = ready ? stable + 1 : 0;
    if (!ready && t % 30 === 29) run.key(nudge[pressed++ % nudge.length]!);
    run.advance();
  }
}

const parserControl = (run: Speedrun) => () =>
  run.engine.inputEnabled && run.engine.movementControlEnabled;

const playable = (run: Speedrun) => settle(run, parserControl(run), "the first playable room");

const inRoom =
  (run: Speedrun, room: number, also: () => boolean = () => true) =>
  () =>
    run.engine.vars[0] === room && also();

function catalogued(
  alias: string,
  {
    unplayable,
    ...edition
  }: Omit<Edition, "label" | "game" | "fixture" | "skip"> & {
    /** Why no route reaches a playable point yet, for an installed edition. */
    unplayable?: string;
  },
): Edition {
  return {
    label: alias,
    game: alias,
    fixture: () => findFixture(alias),
    skip: () => fixtureSkip(alias, [], { checkVolumes: "shipped" }) || (unplayable ?? false),
    ...edition,
  };
}

const EDITIONS: Edition[] = [
  // PC
  catalogued("kq1", { reach: playable }),
  catalogued("kq2", { reach: playable }),
  catalogued("kq3", { reach: playable }),
  catalogued("kq4", {
    // The cold boot asks the manual question; logic 0 answers f6 with the beach.
    reach: (run) => {
      run.until(
        () => run.engine.flags[224] !== 0 || run.engine.vars[0] === 25,
        600,
        "the manual question or the beach",
      );
      if (run.engine.flags[224] !== 0) manualCheck(run);
      settle(run, inRoom(run, 25, parserControl(run)), "Rosella on the beach");
    },
  }),
  catalogued("sq1", { reach: playable }),
  catalogued("sq2", { reach: playable }),
  catalogued("pq1", { reach: playable }),
  catalogued("lsl1", {
    // The cold boot asks the age quiz; logic 0 answers f6 with Lefty's.
    reach: (run) => {
      run.until(() => run.engine.vars[0] !== 0, 60, "the first room");
      if (run.engine.vars[0] === 1) ageQuiz(run);
      settle(run, inRoom(run, 11, parserControl(run)), "outside Lefty's");
    },
  }),
  catalogued("gr1", { reach: playable }),
  catalogued("bc", { reach: (run) => settle(run, inRoom(run, 8), "the opening room") }),
  catalogued("ddp", {
    reach: (run) => settle(run, inRoom(run, 3), "the level gate"),
    restartKey: AGI_KEY.F3,
    saveKey: null,
  }),
  catalogued("mumg", {
    noRestart: "Begin a brand new game asks yes or no and enters room 0; no restart.game runs",
    reach: (run) =>
      settle(
        run,
        inRoom(run, 32, () => run.engine.flags[115] === 0 && run.engine.flags[117] === 0),
        "the arrival room",
        { nudge: [AGI_KEY.SPACE, AGI_KEY.ENTER] },
      ),
  }),
  catalogued("mh1", { reach: (run) => mh1Opening(new Manhunter(run)) }),
  catalogued("mh2", { reach: (run) => mh2Opening(new Mh2(run)) }),
  // Amiga
  catalogued("sq1-amiga", { reach: playable }),
  catalogued("kq2-amiga", { reach: playable }),
  catalogued("sq2-amiga", { reach: playable }),
  catalogued("pq1-amiga", { reach: playable }),
  catalogued("goldrush-amiga", {
    unplayable:
      "the claim-jumper's manual question comes before the game maps any key, F9 and F5 " +
      "included, and no route answers it yet",
    reach: playable,
  }),
  catalogued("mh2-amiga", { reach: (run) => mh2Opening(new Mh2(run)) }),
  // Apple IIgs
  catalogued("sq2-iigs", {
    reach: playable,
    restoreBlocked:
      "the restore selector lists no IIgs save: unexplained. It looks for the game signature " +
      "at the start of block 1, where the IIgs image holds its 0x38-byte globals, so it shows " +
      '"No saved games for this game."',
  }),
];

// Installed editions outside the catalog (other interpreter builds) play the
// generic opening. They have no checked route, so a cold boot that never
// reaches a playable point skips the edition; everything after it is checked.
for (const fixture of scanFixtures().all) {
  if (fixture.known || !fixture.wordsSha256) continue;
  const version = detectVersionString(interpreterFiles(fixture));
  if (version === null) continue;
  EDITIONS.push({
    label: `uncatalogued ${version} edition (WORDS.TOK ${fixture.wordsSha256.slice(0, 12)})`,
    game: fixture.wordsSha256,
    fixture: () => fixture,
    skip: () => fixtureSkip(fixture.folder, [], { checkVolumes: "shipped" }),
    reach: playable,
    unrouted: true,
  });
}

/** The files that carry a PC interpreter's version string. */
function interpreterFiles(fixture: DiscoveredFixture): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const actual of fixture.files.values())
    if (INTERPRETER_FILES.includes(actual.toUpperCase()) || /\.com$/i.test(actual))
      files.set(actual, new Uint8Array(readFileSync(join(fixture.dir, actual))));
  return files;
}

/** Every file of the installation, so detection sees PC, Amiga and IIgs interpreters alike. */
function installation(fixture: DiscoveredFixture): GameFixture {
  const files = new Map<string, Uint8Array>();
  let dict = new Map<string, number>();
  for (const actual of fixture.files.values()) {
    const path = join(fixture.dir, actual);
    if (!statSync(path).isFile()) continue;
    const bytes = new Uint8Array(readFileSync(path));
    files.set(actual, bytes);
    if (actual.toLowerCase() === "words.tok")
      dict = new Map(parseWordsTok(bytes).map((entry) => [entry.word, entry.id]));
  }
  return { files, container: openContainer(files), dict };
}

/**
 * The executed logic of one run, from boot or from an accepted restart: each
 * instruction as (logic, pc, opcode, first operand, test result), packed in
 * one number, and the rooms entered.
 */
interface RunTrace {
  readonly steps: number[];
  readonly rooms: number[];
}

interface Session {
  readonly run: Speedrun;
  readonly runs: RunTrace[];
  readonly storage: { image: Uint8Array | null; reads: number };
  readonly hooks: {
    /** Called inside the game's save.game, with the state it writes. */
    saved: ((engine: Engine) => void) | null;
    /** Called at the first instruction the game's logic runs after a restore. */
    restored: ((engine: Engine) => void) | null;
  };
}

function pack(record: TraceRecord): number {
  const result = record.result === undefined ? 0 : record.result ? 1 : 2;
  return (
    (((record.logic * 65536 + record.pc) * 256 + record.op) * 256 + (record.args[0] ?? 0)) * 4 +
    result
  );
}

function unpack(step: number) {
  const result = step % 4;
  let rest = (step - result) / 4;
  const arg = rest % 256;
  rest = (rest - arg) / 256;
  const op = rest % 256;
  rest = (rest - op) / 256;
  return { logic: Math.floor(rest / 65536), pc: rest % 65536, op, arg, result };
}

/**
 * The original keeps its random stream across an accepted restart
 * (docs/fidelity.md "Original save and restart audit"). The test reseeds its
 * host source at the restart instead, so both runs draw the same numbers and
 * the same script reaches the same point; the stream itself is not a field
 * the snapshot compares.
 */
function boot(edition: Edition): Session {
  const fixture = installation(edition.fixture()!);
  const storage: Session["storage"] = { image: null, reads: 0 };
  const hooks: Session["hooks"] = { saved: null, restored: null };
  const runs: RunTrace[] = [{ steps: [], rooms: [] }];
  let engine: Engine | null = null;
  let random = 1;
  let randomRun = 0;
  const run = new Speedrun(edition.game, 1, {
    fixture,
    profile: detectProfile(fixture.files),
    host: {
      // The game's own save.game and restore.game run the engine's selector
      // over one stored slot; Enter picks it and the description is fixed.
      listSaveGames: () => (storage.image ? [{ slot: 1, bytes: storage.image }] : []),
      promptSaveDescription: () => "lifecycle",
      saveGame: (bytes) => {
        storage.image = bytes.slice();
        hooks.saved?.(engine!);
      },
      restoreGame: () => {
        storage.reads++;
        return storage.image;
      },
      // Name prompts (SQ1, SQ2, MUMG) take the same name in every run.
      promptString: () => "PLAYER",
      randomByte: () => {
        if (engine!.runResetSerial !== randomRun) {
          randomRun = engine!.runResetSerial;
          random = 1;
        }
        const draw = rngDraw(random, () => 1);
        random = draw.state;
        return draw.byte;
      },
    },
  });
  engine = run.engine;
  randomRun = engine.runResetSerial;
  let tracedRun = engine.runResetSerial;
  let tracedReads = 0;
  engine.setTraceListener((record) => {
    if (engine.runResetSerial !== tracedRun) {
      tracedRun = engine.runResetSerial;
      runs.push({ steps: [], rooms: [] });
    }
    if (storage.reads !== tracedReads) {
      tracedReads = storage.reads;
      hooks.restored?.(engine);
    }
    runs.at(-1)!.steps.push(pack(record));
  });
  engine.setRoomTransitionListener((_from, to) => runs.at(-1)!.rooms.push(to));
  return { run, runs, storage, hooks };
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** Replay-state fields that belong to the host's recording rather than to the game. */
const HOST_ONLY = new Set([
  "continuation",
  "inputQueue",
  "patchGeneration",
  "clockRemainderMs",
  "menu",
  "menuFinalized",
  "menuHeading",
  "menuRequested",
]);

/**
 * What the player can see and use, read through the engine's own captures:
 * the authentic save image (variables, flags, strings, key map, display and
 * input state, objects, inventory, replay and resume records), the host
 * recording state, the menu, the controls, the screen text and the picture.
 */
function snapshot(engine: Engine, { boundary = false } = {}): Snapshot {
  const out: Snapshot = {};
  const put = (key: string, value: unknown) => {
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  };
  const save = decodeSave(engine.serialize(), engine.profile);
  save.vars.forEach((value, n) => put(`v${n}`, value));
  save.flags.forEach((value, n) => put(`f${n}`, value));
  save.strings.forEach((value, n) => put(`s${n}`, value));
  for (const key of [
    "timerTicks",
    "horizon",
    "blockLeft",
    "blockTop",
    "blockRight",
    "blockBottom",
    "blockEnabled",
    "directionCoupling",
    "lastPicture",
    "replayCapacity",
    "replayActive",
    "replayCheckpoint",
    "textFg",
    "textBg",
    "textAttr",
    "inputEnabled",
    "inputRow",
    "promptChar",
    "statusEnabled",
    "statusRow",
    "displayBaseRow",
    "displayBottomRow",
    "menuGate",
    "releaseGate",
  ] as const)
    put(`save.${key}`, save[key]);
  put("save.signature", Array.from(save.signature));
  put(
    "save.keyMap",
    save.keyMap.filter((entry) => entry.rawKey !== 0 || entry.status !== 0),
  );
  save.objects.forEach((record, n) => put(`object${n}`, record));
  put("save.inventory", hash(save.inventory));
  put("save.replay", save.replay.slice(0, save.replayActive));
  put("save.logicResume", save.logicResume);
  put("controllers", Array.from(engine.controllers));
  put(
    "objectPriority",
    engine.screenObjects.map((o) => o.priority),
  );

  put("menu", engine.readMenuState());
  put("controls", engine.readControls());
  put("textMode", engine.textModeActive);
  put("displayBase", engine.displayBase);
  put("statusBar", engine.statusBarText());
  put("inputEdit", engine.inputEdit);
  put("movementControl", engine.movementControlEnabled);
  put("maxDrawnObjects", engine.maxDrawnObjects);
  put("picture.visual", hash(engine.surface.visual));
  put("picture.priority", hash(engine.surface.priority));
  // Inside a logic pass (the save and restore boundaries) the save selector
  // is still open, the screen text is the old room's and the host recording
  // has no checkpoint; the settled comparison covers all three.
  if (boundary) return out;
  put("modal", engine.modalKind);
  for (let row = 0; row < 25; row++) put(`text${row}`, engine.textRow(row));
  const replay = engine.captureReplayState() as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(replay))
    if (!HOST_ONLY.has(key)) put(`host.${key}`, value);
  return out;
}

/**
 * Interpreter-owned configuration: what the interpreter keeps or resets, and
 * the game sets up once. These must agree at the same point whatever route
 * the game's own logic took to reach it.
 */
const SESSION =
  /^(menu|menuProbe|controls|save\.keyMap|s\d+|save\.signature|save\.(horizon|block\w+|directionCoupling|replayCapacity|text\w+|inputEnabled|inputRow|promptChar|status\w+|display\w+|menuGate|releaseGate)|v(0|20|22|24|26)|f(9|11)|modal|textMode|displayBase|statusBar|inputEdit|movementControl|maxDrawnObjects|host\.(priorityBase|priorityTableRebuilt|pcDisplay|monitorType|amigaRegion|inputWidthCap|gameSignature))$/;

/** The snapshot, then whether the menu opens (opening and closing it changes state). */
function probed(run: Speedrun): Snapshot {
  const taken = snapshot(run.engine);
  return { ...taken, menuProbe: menuProbe(run) };
}

/** Open the game's menu the way a player does, report what opened, and close it again. */
function menuProbe(run: Speedrun): string {
  const e = run.engine;
  if (e.profile.nativeMenu === "intuition") {
    if (!e.nativeMenuOpen(0, 0, true)) return "no menu opens";
    const kind = e.modalKind;
    e.nativeMenuCancel();
    return kind === "menu" ? "menu opens" : `${kind} opens`;
  }
  // Escape opens the menu in the PC editions; SQ2 IIgs maps it to its pause window.
  const open = () => e.modalKind;
  run.key(AGI_KEY.ESCAPE);
  for (let t = 0; t < 120 && open() === null; t++) run.advance();
  const opened = open();
  const bar = e.textRow(0).trimEnd();
  if (opened !== null) {
    run.key(AGI_KEY.ESCAPE);
    for (let t = 0; t < 120 && open() !== null; t++) run.advance();
    if (open() !== null) run.dismiss();
  }
  if (opened === "menu") return `menu opens: ${bar}`;
  return opened === null ? "no menu opens" : `${opened} opens`;
}

interface Difference {
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

function differences(before: Snapshot, after: Snapshot): Difference[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys
    .filter((key) => before[key] !== after[key])
    .map((field) => ({ field, before: before[field] ?? "-", after: after[field] ?? "-" }));
}

/** What a comparison knows besides the two snapshots. */
interface Context {
  readonly phase: Phase;
  readonly edition: string;
  readonly profile: string;
  /** Restart: where the restarted run's logic first departed from the cold run's. */
  readonly departure: string | null;
  /** Restore: the state inside the game's save.game, as the image holds it. */
  readonly saved: Snapshot | null;
  /** Restart: the restarted run's snapshot at the playable point. */
  readonly after?: Snapshot;
}

/** The restarted run first departed from the cold one at the game's own test of f6. */
const departsAtF6 = (context: Context) =>
  /op 0x7\(6\) false -> true$/.test(context.departure ?? "");

/**
 * Object-record keys that differ between two serialized records. The Amiga
 * and IIgs records also carry their raw bytes; a changed byte reads as
 * `raw[offset]`.
 */
function recordKeys(difference: Difference): string[] {
  const before = JSON.parse(difference.before) as Record<string, unknown>;
  const after = JSON.parse(difference.after) as Record<string, unknown>;
  return Object.keys(after).flatMap((key) => {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) return [];
    if (key !== "raw") return [key];
    const a = before[key] as Record<string, number>;
    const b = after[key] as Record<string, number>;
    return Object.keys(b)
      .filter((offset) => a[offset] !== b[offset])
      .map((offset) => `raw[0x${Number(offset).toString(16)}]`);
  });
}

/**
 * A difference the original interpreter produces as well. `cite` names the
 * docs/fidelity.md entry whose evidence shows it.
 */
interface Allowed {
  readonly phase: Phase;
  readonly field: RegExp;
  readonly when?: (context: Context, difference: Difference) => boolean;
  readonly why: string;
  readonly cite: string;
}

/**
 * The two JSON values agree except for menu item enabled words that went
 * from false to true: `headings[].items[]` in the menu, `menuItems[]` in the
 * controls. Heading words never change.
 */
function onlyItemsEnabled(difference: Difference): boolean {
  const same = (a: unknown, b: unknown, inItems: boolean): boolean => {
    if (Array.isArray(a) && Array.isArray(b))
      return a.length === b.length && a.every((value, n) => same(value, b[n], inItems));
    if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
      const x = a as Record<string, unknown>;
      const y = b as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])];
      return keys.every((key) =>
        inItems && key === "enabled" && x[key] === false && y[key] === true
          ? true
          : same(x[key], y[key], key === "items" || key === "menuItems"),
      );
    }
    return a === b;
  };
  return same(JSON.parse(difference.before), JSON.parse(difference.after), false);
}

const ALLOWED: readonly Allowed[] = [
  ...(["restart", "restore"] as const).map((phase) => ({
    phase,
    field: /^(menu|controls)$/,
    when: (_context: Context, difference: Difference) => onlyItemsEnabled(difference),
    why:
      "The accepted restart and the successful restore both enable every menu item; the game " +
      "disables items again itself.",
    cite: 'docs/fidelity.md "Original menu across restart and restore"',
  })),
  {
    phase: "restart",
    field: /^menuProbe$/,
    when: (context, difference) =>
      departsAtF6(context) &&
      context.after?.["f14"] === "0" &&
      difference.after === "no menu opens",
    why:
      "The strip survives the restart, but on Amiga 2.176..2.333 it opens only while f14 is " +
      "set, and ResetAll clears f14 with the other flags. A game that sets f14 only on its cold " +
      "route (MH2) has no strip after a restart in the original either.",
    cite: 'docs/fidelity.md "Original native menu dispatch"',
  },
  {
    phase: "restart",
    field: /^(save\.timerTicks|v1[1-6])$/,
    when: departsAtF6,
    why: "Restart zeroes the timer; the shorter route reaches the point at another time.",
    cite: 'docs/fidelity.md "Persistence verdicts" (F-persistence-04)',
  },
  {
    phase: "restart",
    field: /./,
    when: (context, difference) => departsAtF6(context) && !SESSION.test(difference.field),
    why:
      "An accepted restart sets f6. The game's logic tests it and takes another route to the " +
      "same point, skipping its title, intro or one-time setup, so the variables, flags, object " +
      "records, resource replay pairs and cached views it writes on the way differ. The test " +
      "requires the first instruction where the runs part to be that f6 test, and holds the " +
      "interpreter-owned SESSION fields equal whatever the route.",
    cite: 'docs/fidelity.md "Original save and restart audit"',
  },
  {
    phase: "restore",
    field: /^f12$/,
    when: (_context, difference) => difference.before === "0" && difference.after === "1",
    why: "A successful restore sets f12 before logic 0 runs again.",
    cite: 'docs/fidelity.md "Persistence verdicts" (F-persistence-03)',
  },
  {
    phase: "restore",
    field: /^controllers$/,
    when: (_context, difference) =>
      (JSON.parse(difference.after) as number[]).every((value) => value === 0),
    why: "The restore tail runs ClearControl: the save key's controller is clear afterwards.",
    cite: 'docs/fidelity.md "Persistence verdicts" (F-persistence-03)',
  },
  {
    phase: "restore",
    field: /^save\.logicResume$/,
    when: (_context, difference) => {
      const before = (JSON.parse(difference.before) as { logic: number }[]).map((r) => r.logic);
      const after = (JSON.parse(difference.after) as { logic: number }[]).map((r) => r.logic);
      return after[0] === 0 && after.every((logic) => before.includes(logic));
    },
    why:
      "Reconstruction keeps the global logic at the head of the cache, truncates the rest and " +
      "loads only the logics the replay pairs name; the room's own logic loads again when logic " +
      "0 calls it.",
    cite: 'docs/fidelity.md "Startup and reconstruction execution"',
  },
  {
    phase: "restore",
    field: /./,
    when: (context, difference) =>
      context.saved !== null && context.saved[difference.field] === difference.after,
    why:
      "The game changed the field after save.game in the pass that saved (MH1 and MH2 put the " +
      "prompt character back); a successful restore abandons the pass that called " +
      "restore.game, so the saved value stays.",
    cite: 'docs/fidelity.md "Startup and reconstruction execution"',
  },
];

/**
 * A difference with no original evidence: an engine defect awaiting its fix.
 * Each entry names the editions that show it, and the test fails once it no
 * longer occurs, so the fix removes the entry.
 */
interface Pending {
  readonly phase: Phase;
  readonly field: RegExp;
  readonly when?: (difference: Difference) => boolean;
  readonly editions: readonly string[];
  readonly bug: string;
}

const MENU_EDITIONS = [
  "kq1",
  "kq2",
  "kq3",
  "kq4",
  "sq1",
  "sq2",
  "pq1",
  "lsl1",
  "gr1",
  "bc",
  "ddp",
  "mh1",
  "mh2",
  "sq1-amiga",
  "kq2-amiga",
  "sq2-amiga",
  "pq1-amiga",
  "mh2-amiga",
  "sq2-iigs",
];

const UNCATALOGUED_2089 = "uncatalogued 2.089 edition (WORDS.TOK 775bfe3c9f51)";

const PENDING: readonly Pending[] = [
  {
    phase: "restore",
    field: /^objectPriority$/,
    when: (difference) => {
      const before = JSON.parse(difference.before) as number[];
      const after = JSON.parse(difference.after) as number[];
      return after.every((value, n) => value === before[n] || value === 0);
    },
    editions: [
      "kq1",
      "kq2",
      "kq3",
      "kq4",
      "sq1",
      "sq2",
      "pq1",
      "lsl1",
      "gr1",
      "bc",
      "mumg",
      "sq1-amiga",
      "kq2-amiga",
      "sq2-amiga",
      "pq1-amiga",
      UNCATALOGUED_2089,
    ],
    bug:
      "save.game writes 0 as the priority of an object without a fixed priority, where the " +
      'original copies the raw record (docs/fidelity.md "PC state and objects"); after a ' +
      "restore such an object reports priority 0 until it moves: unexplained.",
  },
  {
    phase: "restore",
    field: /^object\d+$/,
    // The Amiga record holds the two counts as words at 0x12 and 0x1a.
    when: (difference) =>
      recordKeys(difference).every((key) =>
        /^(loopCount|celCount|raw\[0x(12|13|1a|1b)\])$/.test(key),
      ),
    editions: [
      "kq2",
      "kq3",
      "kq4",
      "pq1",
      "gr1",
      "mumg",
      "mh1",
      "mh2",
      "kq2-amiga",
      "pq1-amiga",
      "mh2-amiga",
    ],
    bug:
      "save.game writes zero loop and cel counts for an object whose view is no longer " +
      "loaded, where the original copies the raw record; restore's view rebinding fills them " +
      "again: unexplained.",
  },
  {
    phase: "restore",
    field: /^host\.pictureShown$/,
    editions: [
      ...MENU_EDITIONS.filter((edition) => edition !== "ddp" && edition !== "sq2-iigs"),
      "mumg",
      UNCATALOGUED_2089,
    ],
    bug:
      "after a restore the engine counts the picture as not shown, though the restored " +
      "picture is on screen, until the game's next show.pic: unexplained.",
  },
  {
    phase: "restore",
    field: /^menuProbe$/,
    editions: ["kq4"],
    bug:
      "after a restore on 3.002.086 no menu opens: that save layout has no menu-gate word, and " +
      "the restore sets the gate to 0: unexplained.",
  },
];

/** One difference for a failure message; an object record shows only its changed keys. */
function explain(difference: Difference): string {
  const clip = (text: string) => (text.length > 160 ? `${text.slice(0, 160)}…` : text);
  if (/^object\d+$/.test(difference.field)) {
    const before = JSON.parse(difference.before) as Record<string, unknown>;
    const after = JSON.parse(difference.after) as Record<string, unknown>;
    const keys = recordKeys(difference).filter((key) => !key.startsWith("raw"));
    const pick = (record: Record<string, unknown>) =>
      JSON.stringify(Object.fromEntries(keys.map((key) => [key, record[key]])));
    return `${difference.field}: ${pick(before)}\n    -> ${pick(after)}`;
  }
  return `${difference.field}: ${clip(difference.before)}\n    -> ${clip(difference.after)}`;
}

/** Check every comparison of one phase; fail on any unexplained difference or stale pending entry. */
function report(
  context: Context,
  comparisons: readonly (readonly [label: string, before: Snapshot, after: Snapshot])[],
): void {
  const unexplained: string[] = [];
  const seen = new Set<Pending>();
  for (const [label, before, after] of comparisons) {
    for (const difference of differences(before, after)) {
      const pending = PENDING.find(
        (entry) =>
          entry.phase === context.phase &&
          entry.editions.includes(context.edition) &&
          entry.field.test(difference.field) &&
          (entry.when?.(difference) ?? true),
      );
      if (pending) {
        seen.add(pending);
        continue;
      }
      const allowed = ALLOWED.find(
        (entry) =>
          entry.phase === context.phase &&
          entry.field.test(difference.field) &&
          (entry.when?.(context, difference) ?? true),
      );
      if (!allowed) unexplained.push(`  ${label} ${explain(difference)}`);
    }
  }
  assert.ok(
    unexplained.length === 0,
    `${context.edition} (${context.profile}) ${context.phase}: differences without a ` +
      `docs/fidelity.md citation or a pending entry` +
      (context.departure ? ` (restarted logic departs at ${context.departure})` : "") +
      `:\n${unexplained.join("\n")}`,
  );
  const unseen = PENDING.filter(
    (entry) =>
      entry.phase === context.phase && entry.editions.includes(context.edition) && !seen.has(entry),
  );
  assert.deepEqual(
    unseen.map((entry) => entry.bug),
    [],
    `${context.edition} (${context.profile}) ${context.phase}: pending entries that no longer occur; remove them`,
  );
}

/** The first instruction where two runs' logic executes differently, or null. */
function departure(cold: readonly number[], restarted: readonly number[]): string | null {
  const length = Math.min(cold.length, restarted.length);
  for (let i = 0; i < length; i++) {
    if (cold[i] === restarted[i]) continue;
    const a = unpack(cold[i]!);
    const b = unpack(restarted[i]!);
    const where =
      a.logic === b.logic && a.pc === b.pc
        ? `logic ${a.logic} pc ${a.pc} op 0x${a.op.toString(16)}(${a.arg}) ${a.result === 1 ? "true" : "false"} -> ${b.result === 1 ? "true" : "false"}`
        : `logic ${a.logic} pc ${a.pc} -> logic ${b.logic} pc ${b.pc}`;
    return `instruction ${i}: ${where}`;
  }
  return null;
}

/** The cold boot's route; false (with the test skipped) when an unrouted edition misses the point. */
function coldReach(edition: Edition, run: Speedrun, t: TestContext): boolean {
  if (!edition.unrouted) {
    edition.reach(run);
    return true;
  }
  try {
    edition.reach(run);
    return true;
  } catch (error) {
    t.skip(
      `the generic opening reaches no playable point: ${(error as Error).message.slice(0, 120)}`,
    );
    return false;
  }
}

const mapped = (run: Speedrun, key: number) =>
  run.engine.readControls().some((control) => control.key === key);

/** Let a lifecycle key's cycle finish with its windows dismissed. */
function idle(run: Speedrun, ticks: number): void {
  for (let t = 0; t < ticks; t++) {
    if (run.engine.modalKind !== null || run.engine.continuationPending) run.dismiss();
    else run.advance();
  }
}

for (const edition of EDITIONS) {
  describe(`${edition.label} restart and restore`, { skip: edition.skip() }, () => {
    test(
      "an accepted restart offers the same menu, keys and controls",
      { skip: edition.noRestart ?? false },
      (t) => {
        const session = boot(edition);
        const { run } = session;
        const profile = run.engine.profile.id;
        if (!coldReach(edition, run, t)) return;
        const coldSteps = session.runs[0]!.steps.length;
        const before = probed(run);

        const restartKey = edition.restartKey ?? AGI_KEY.F9;
        if (edition.unrouted && !mapped(run, restartKey)) return t.skip("no restart key is mapped");
        const resets = run.engine.runResetSerial;
        run.key(restartKey);
        run.until(() => run.engine.runResetSerial !== resets, 600, "the accepted restart");
        edition.reach(run);
        const restartedSteps = session.runs[1]!.steps.length;
        const after = probed(run);
        const departed = departure(
          session.runs[0]!.steps.slice(0, coldSteps),
          session.runs[1]!.steps.slice(0, restartedSteps),
        );
        t.diagnostic(
          `rooms cold ${session.runs[0]!.rooms.join(",")}; restarted ${session.runs[1]!.rooms.join(",")}; ` +
            `${coldSteps} and ${restartedSteps} instructions; departure ${departed ?? "none"}`,
        );
        report(
          {
            phase: "restart",
            edition: edition.label,
            profile,
            departure: departed,
            saved: null,
            after,
          },
          [["at the playable point", before, after]],
        );
      },
    );

    test(
      "a restore offers the menu, keys and controls of the save",
      { skip: edition.saveKey === null ? "the game has no save action" : false },
      (t) => {
        const session = boot(edition);
        const { run, storage } = session;
        const profile = run.engine.profile.id;
        if (!coldReach(edition, run, t)) return;
        const boundary: { saved?: Snapshot; restored?: Snapshot } = {};
        session.hooks.saved = (engine) => (boundary.saved = snapshot(engine, { boundary: true }));
        const saveKey = edition.saveKey ?? AGI_KEY.F5;
        if (edition.unrouted && !mapped(run, saveKey)) return t.skip("no save key is mapped");
        run.key(saveKey);
        run.until(() => storage.image !== null, 600, "the game's save");
        idle(run, 60);
        const settledSave = probed(run);

        // Change what the player sees: walk away and toggle the sound.
        run.direction(3);
        run.advance(60);
        run.direction(0);
        run.key(AGI_KEY.F2);
        idle(run, 60);

        session.hooks.restored = (engine) =>
          (boundary.restored ??= snapshot(engine, { boundary: true }));
        run.key(edition.restoreKey ?? AGI_KEY.F7);
        if (edition.restoreBlocked) {
          idle(run, 600);
          assert.equal(
            storage.reads,
            0,
            `${edition.label}: the restore reached the image; remove the pending entry "${edition.restoreBlocked}"`,
          );
          return;
        }
        run.until(() => boundary.restored !== undefined, 600, "the game's restore");
        idle(run, 60);
        const settledRestore = probed(run);
        const saved = boundary.saved!;
        report({ phase: "restore", edition: edition.label, profile, departure: null, saved }, [
          ["at the boundary", saved, boundary.restored!],
          ["settled", settled(settledSave), settled(settledRestore)],
        ]);
      },
    );
  });
}

/**
 * After the restored pass settles, what the player uses: the SESSION fields,
 * the menu as it opens, the picture and whether the engine counts it as
 * shown. Game-owned state was compared at the boundary; after it, the
 * game's own f12 handling may change it.
 */
function settled(all: Snapshot): Snapshot {
  return Object.fromEntries(
    Object.entries(all).filter(
      ([key]) => SESSION.test(key) || /^(picture\.\w+|host\.pictureShown)$/.test(key),
    ),
  );
}

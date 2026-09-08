import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLogicResource, buildLogicResource } from "../src/logic/resource.ts";
import { parseView } from "../src/view/view.ts";
import { renderPicture } from "../src/picture/renderer.ts";
import { createPictureSurface } from "../src/types.ts";
import { ACTION_BY_CODE, CONDITION_BY_CODE, GOTO, IF, NOT, OR } from "../src/logic/opcodes.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { fixtureSkip } from "./fixtures.ts";
import { loadGame } from "./game-fixture.ts";

/**
 * Optional King's Quest fixture tests. GAMES specifies the editions and
 * expected resource counts, opening state and parser responses. Each suite
 * checks resource parsing, opcode dispatch, boot, input and movement.
 */

interface GameCase {
  slug: string;
  /** Room entered on a cold boot (title / intro screen). */
  introRoom: number;
  /** First playable room (restarted boot lands here directly). */
  firstRoom: number;
  /** Picture number the first room draws (hand-checked: pic == room here). */
  firstPicture: number;
  /** Directory entries that parse: LOGDIR / VIEWDIR / PICDIR. */
  counts: { logic: number; view: number; picture: number };
  /** Distinct visual colours / priority values in the first room's picture. */
  firstPictureColors: number;
  firstPicturePriorities: number;
  /** Ego (object 0) position after the restarted boot (get.posn). */
  egoStart: { x: number; y: number };
  /** A phrase the first room answers, and a fragment of the authentic reply. */
  look: { phrase: string; expect: string };
  /** Fragment of the authentic unknown-word reply to "xyzzyplugh". */
  unknownReply: string;
}

const GAMES: readonly GameCase[] = [
  {
    slug: "kq1",
    introRoom: 83,
    firstRoom: 1,
    firstPicture: 1,
    counts: { logic: 90, view: 118, picture: 82 },
    // pic 1 uses colours {0,1,2,3,4,6,7,8,9,10,13,14,15} and 9 priority bands.
    firstPictureColors: 13,
    firstPicturePriorities: 9,
    egoStart: { x: 110, y: 100 },
    // KQ1 room 1: plain "look" answers "You need to be more specific.";
    // "look room" gives the room description.
    look: { phrase: "look room", expect: "castle" },
    unknownReply: `I don't understand "xyzzyplugh"`,
  },
  {
    slug: "kq2",
    introRoom: 97,
    firstRoom: 1,
    firstPicture: 1,
    counts: { logic: 133, view: 207, picture: 108 },
    // pic 1 uses colours {0,1,2,3,5,6,7,8,9,10,11,12,13,14,15} and 5 bands.
    firstPictureColors: 15,
    firstPicturePriorities: 5,
    egoStart: { x: 100, y: 100 },
    look: { phrase: "look", expect: "beach" },
    unknownReply: `I don't understand "xyzzyplugh"`,
  },
  {
    slug: "kq3",
    introRoom: 45,
    firstRoom: 7,
    firstPicture: 7,
    counts: { logic: 125, view: 216, picture: 97 },
    // pic 7 uses colours {0,1,3,4,6,7,8,9,10,12,14,15} and 7 bands.
    firstPictureColors: 12,
    firstPicturePriorities: 7,
    egoStart: { x: 96, y: 137 },
    look: { phrase: "look", expect: "wizard's house" },
    // KQ3 logic 0: print.v(v9) with messages "What's a %w1?" etc.
    unknownReply: "What's a xyzzyplugh?",
  },
];

// ---------- minimal host ----------

class QuietHost implements EngineHost {
  prints: string[] = [];
  pendingKeys: number[] = [];
  pendingLine: string | null = null;
  print(text: string): void {
    this.prints.push(text);
  }
  displayAt(): void {}
  statusLine(): void {}
  takeInputLine(): string | null {
    const line = this.pendingLine;
    this.pendingLine = null;
    return line;
  }
  takeKeys(): number[] {
    const keys = this.pendingKeys;
    this.pendingKeys = [];
    return keys;
  }
  ackPrint(): void {}
  prompt(): void {}
  statusScreen(): void {}
}

/** Probe logic slot (no KQ game uses logic 250): get.posn(o0, v200, v201); return. */
const PROBE_LOGIC = 250;
const PROBE_X = 200;
const PROBE_Y = 201;
const GET_POSN = 0x27;

function bootRestarted(game: GameCase): { engine: Engine; host: QuietHost } {
  const { container, dict } = loadGame(game.slug);
  container.putResource(
    "logic",
    PROBE_LOGIC,
    buildLogicResource(new Uint8Array([GET_POSN, 0, PROBE_X, PROBE_Y, 0x00]), []),
  );
  const host = new QuietHost();
  const engine = new Engine(container, host, dict, { restarted: true });
  for (let i = 0; i < 30; i++) engine.tick();
  return { engine, host };
}

function egoPosition(engine: Engine): { x: number; y: number } {
  engine.execute(PROBE_LOGIC);
  return { x: engine.vars[PROBE_X]!, y: engine.vars[PROBE_Y]! };
}

/** Advance one cycle, dismissing any modal print so the interpreter keeps running. */
function tickAck(engine: Engine, host: QuietHost): void {
  engine.tick();
  if (host.prints.length > 0) engine.ackPrint();
}

// ---------- bytecode walk ----------

/**
 * Linear decode of one logic: actions by ACTION_BY_CODE operand length,
 * 0xff condition blocks with 0xfc/0xfd markers (said = count + count u16le),
 * 0xfe goto = 2-byte offset, 0x00 return. Unreachable tail padding after a
 * terminator may fail to decode; the first undecodable byte there ends it.
 */
function walk(code: Uint8Array, actions: Set<number>, conditions: Set<number>): void {
  let pc = 0;
  let afterTerminator = false;
  while (pc < code.length) {
    const b = code[pc]!;
    if (b === 0x00) {
      afterTerminator = true;
      pc++;
      continue;
    }
    if (b === GOTO) {
      afterTerminator = true;
      pc += 3;
      continue;
    }
    if (b === IF) {
      pc = walkConditions(code, pc + 1, conditions) + 2;
      afterTerminator = false;
      continue;
    }
    const spec = ACTION_BY_CODE.get(b);
    if (!spec || pc + 1 + spec.operands.length > code.length) {
      if (afterTerminator) return;
      throw new Error(`unknown action byte 0x${b.toString(16)} at offset ${pc}`);
    }
    actions.add(b);
    afterTerminator = false;
    pc += 1 + spec.operands.length;
  }
}

function walkConditions(code: Uint8Array, from: number, conditions: Set<number>): number {
  let pc = from;
  for (;;) {
    const b = code[pc]!;
    if (b === IF) return pc + 1;
    if (b === NOT) {
      pc++;
      continue;
    }
    if (b === OR) {
      pc++;
      for (;;) {
        const t = code[pc]!;
        if (t === OR) {
          pc++;
          break;
        }
        if (t === NOT) pc++;
        pc = walkOneCondition(code, pc, conditions);
      }
      continue;
    }
    pc = walkOneCondition(code, pc, conditions);
  }
}

function walkOneCondition(code: Uint8Array, pc: number, conditions: Set<number>): number {
  const b = code[pc]!;
  if (b === 0x0e) {
    conditions.add(b);
    return pc + 2 + code[pc + 1]! * 2;
  }
  const spec = CONDITION_BY_CODE.get(b);
  if (!spec) throw new Error(`unknown condition byte 0x${b.toString(16)} at offset ${pc}`);
  conditions.add(b);
  return pc + 1 + spec.operands.length;
}

function usedOpcodes(slug: string): { actions: Set<number>; conditions: Set<number> } {
  const { container } = loadGame(slug);
  const actions = new Set<number>();
  const conditions = new Set<number>();
  for (let n = 0; n < 256; n++) {
    const payload = container.getResource("logic", n);
    if (payload) walk(parseLogicResource(payload).code, actions, conditions);
  }
  return { actions, conditions };
}

const ENGINE_SOURCE = readFileSync(new URL("../src/runtime/engine.ts", import.meta.url), "utf8");
const STUB_WORDS = /pending|no-op|not yet/i;

// ---------- tests ----------

for (const game of GAMES) {
  const skip = fixtureSkip(game.slug);

  test(
    `${game.slug}: every LOGDIR/VIEWDIR/PICDIR entry parses and the census matches`,
    { skip },
    () => {
      const { container } = loadGame(game.slug);
      const counts = { logic: 0, view: 0, picture: 0 };
      for (let n = 0; n < 256; n++) {
        const logic = container.getResource("logic", n);
        if (logic) {
          const parsed = parseLogicResource(logic);
          assert.ok(parsed.code.length > 0, `logic ${n} has bytecode`);
          counts.logic++;
        }
        const view = container.getResource("view", n);
        if (view) {
          assert.ok(parseView(view).loops.length > 0, `view ${n} has at least one loop`);
          counts.view++;
        }
        const picture = container.getResource("picture", n);
        if (picture) {
          renderPicture(picture, createPictureSurface());
          counts.picture++;
        }
      }
      assert.deepEqual(counts, game.counts);
    },
  );

  test(`${game.slug}: bytecode walk decodes every logic with only known opcodes`, { skip }, (t) => {
    const { actions, conditions } = usedOpcodes(game.slug);
    for (const code of actions) assert.ok(ACTION_BY_CODE.has(code));
    for (const code of conditions) assert.ok(CONDITION_BY_CODE.has(code));
    const names = [...actions].map((c) => ACTION_BY_CODE.get(c)!.name).sort();
    // Every AGI game exercises the core vocabulary; these anchor the walk.
    for (const name of ["new.room", "print", "draw.pic", "animate.obj", "set.view", "position"]) {
      assert.ok(names.includes(name), `${game.slug} uses ${name}`);
    }
    assert.ok(conditions.has(0x0e), `${game.slug} uses said()`);
    assert.ok(actions.has(0xa1), `${game.slug} uses menu.input`);
    t.diagnostic(`${game.slug} distinct actions (${names.length}): ${names.join(" ")}`);
  });

  test(
    `${game.slug}: every used action opcode has a real (non-stub) engine handler`,
    { skip },
    () => {
      const { actions } = usedOpcodes(game.slug);
      const stubs: string[] = [];
      for (const code of [...actions].sort((a, b) => a - b)) {
        const hex = code.toString(16).padStart(2, "0");
        const lines = ENGINE_SOURCE.split("\n").filter((l) => l.includes(`case 0x${hex}:`));
        assert.ok(
          lines.length > 0,
          `engine has a case 0x${hex} (${ACTION_BY_CODE.get(code)!.name})`,
        );
        for (const line of lines) {
          if (STUB_WORDS.test(line))
            stubs.push(`0x${hex} ${ACTION_BY_CODE.get(code)!.name}: ${line.trim()}`);
        }
      }
      assert.deepEqual(stubs, [], `stubbed handlers for opcodes ${game.slug} uses`);
    },
  );

  test(
    `${game.slug}: cold boot visits intro room ${game.introRoom} then room ${game.firstRoom}`,
    { skip },
    () => {
      const { container, dict } = loadGame(game.slug);
      const host = new QuietHost();
      const engine = new Engine(container, host, dict);
      const visited: number[] = [];
      for (let i = 0; i < 400 && visited.at(-1) !== game.firstRoom; i++) {
        if (i % 40 === 0) host.pendingKeys.push(13);
        tickAck(engine, host);
        if (visited.at(-1) !== engine.vars[0]) visited.push(engine.vars[0]!);
      }
      assert.deepEqual(visited, [game.introRoom, game.firstRoom]);
    },
  );

  test(
    `${game.slug}: restarted boot lands in room ${game.firstRoom} with ego on a drawn picture`,
    { skip },
    () => {
      const { engine } = bootRestarted(game);
      assert.equal(engine.vars[0], game.firstRoom);
      assert.deepEqual(egoPosition(engine), game.egoStart);

      // Hand-verify against the room's picture rendered on its own.
      const standalone = createPictureSurface();
      renderPicture(
        loadGame(game.slug).container.getResource("picture", game.firstPicture)!,
        standalone,
      );
      assert.equal(new Set(standalone.visual).size, game.firstPictureColors);
      assert.equal(new Set(standalone.priority).size, game.firstPicturePriorities);

      const colors = new Set(engine.surface.visual);
      const priorities = new Set(engine.surface.priority);
      assert.ok(
        colors.size >= game.firstPictureColors,
        `room draws >= ${game.firstPictureColors} colours, got ${colors.size}`,
      );
      assert.ok(
        priorities.size >= game.firstPicturePriorities,
        `priority buffer is not flat: ${priorities.size} values`,
      );
    },
  );

  test(
    `${game.slug}: parser answers "${game.look.phrase}" and an unknown word in the first room`,
    { skip },
    () => {
      const { engine, host } = bootRestarted(game);
      host.pendingLine = game.look.phrase;
      engine.tick();
      assert.ok(host.prints.length >= 1, `"${game.look.phrase}" produced a print`);
      assert.ok(
        host.prints.some((p) => p.includes(game.look.expect)),
        `"${game.look.phrase}" reply contains "${game.look.expect}", got ${JSON.stringify(host.prints)}`,
      );
      engine.ackPrint();
      host.prints = [];
      engine.tick();

      host.pendingLine = "xyzzyplugh frobnicate";
      engine.tick();
      assert.equal(engine.vars[9], 1, "v9 = position of the first unknown word");
      assert.ok(
        host.prints.some((p) => p.includes(game.unknownReply)),
        `unknown-word reply contains ${JSON.stringify(game.unknownReply)}, got ${JSON.stringify(host.prints)}`,
      );
    },
  );

  test(`${game.slug}: ego walks when v6 (ego direction) is set`, { skip }, () => {
    const { engine, host } = bootRestarted(game);
    const before = egoPosition(engine);
    // Direction 3 = right (1 = up, clockwise). The pre-logic mirror copies v6
    // into object 0 each cycle; the post-logic motion pass moves it.
    engine.vars[6] = 3;
    for (let i = 0; i < 20; i++) tickAck(engine, host);
    const after = egoPosition(engine);
    assert.equal(engine.vars[0], game.firstRoom, "still in the first room");
    assert.notDeepEqual(after, before, `ego moved from ${JSON.stringify(before)}`);
    assert.ok(after.x > before.x, `walking right increases x: ${before.x} -> ${after.x}`);
  });
}

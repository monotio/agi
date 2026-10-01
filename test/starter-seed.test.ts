import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { installBoilerplateSeed } from "../src/agent/baseTemplate.ts";
import { executeAgentTool } from "../src/agent/tools.ts";
import {
  authoredLogicSource,
  authoredPictureSource,
  createAgentSessionState,
  type AgentSessionState,
} from "../src/agent/agentState.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { buildSound } from "../src/sound/build.ts";
import { compileSoundDocumentSource } from "../src/sound/source.ts";
import { buildView } from "../src/view/view.ts";
import { Engine, HostWait, type EngineHost } from "../src/runtime/engine.ts";

class SeedHost implements EngineHost {
  keys: number[] = [];
  lines: string[] = [];
  sounds: number[] = [];
  restoreImage: Uint8Array | null = null;
  waitKey(): number {
    throw new HostWait();
  }
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
  takeInputLine(): string | null {
    return this.lines.shift() ?? null;
  }
  playSound(num: number): void {
    this.sounds.push(num);
  }
  soundOutput(): void {}
  saveGame(): boolean {
    return true;
  }
  restoreGame(): Uint8Array | null {
    return this.restoreImage;
  }
  print(): void {}
  displayAt(): void {}
  statusLine(): void {}
}

function bootState(state: AgentSessionState) {
  const host = new SeedHost();
  const engine = new Engine(state.container, host, state.sources.words, {
    profile: state.profile,
  });
  return { engine, host };
}

function tick(engine: Engine, n = 1): void {
  for (let i = 0; i < n; i++) engine.tick();
}

function surfaceRows(engine: Engine): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 25; r++) rows.push(engine.textRow(r));
  return rows;
}

function fileBytes(state: AgentSessionState): [string, number[]][] {
  return [...state.getFiles()]
    .map(([name, bytes]) => [name, [...bytes]] as [string, number[]])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

describe("installBoilerplateSeed", () => {
  test("installs the complete Boilerplate byte for byte on a fresh session", () => {
    const state = createAgentSessionState();
    const seed = installBoilerplateSeed(state);
    const expected = createStarterProject("boilerplate");
    assert.deepEqual(seed.seed, expected.seed, "the installed seed is the canonical Boilerplate");
    const files = state.getFiles();
    const want = expected.files();
    assert.deepEqual([...files.keys()].sort(), [...want.keys()].sort());
    for (const [name, bytes] of files)
      assert.deepEqual(
        [...bytes],
        [...want.get(name)!],
        `${name} must match the Boilerplate exactly`,
      );
    assert.equal(state.profile.id, "2.936");
    assert.deepEqual([...state.sources.words], [...expected.sources.words]);
    assert.deepEqual(state.authoring.bindings, expected.bindings);
    assert.deepEqual([...state.sources.logics], [...expected.sources.logics]);
    assert.deepEqual([...state.sources.pictures], [...expected.sources.pictures]);
    assert.deepEqual([...state.sources.views], [...expected.sources.views]);
    assert.deepEqual(state.sources.objects, [...expected.sources.objects]);
    assert.deepEqual([...state.sources.sounds], [...expected.sources.sounds]);
    assert.equal(
      state.genesisComplete,
      false,
      "the seed is scaffolding — the brief's world is still owed",
    );
  });

  test("every installed source claim recompiles to its native bytes under the session profile", () => {
    const state = createAgentSessionState();
    const seed = installBoilerplateSeed(state);
    for (const [num, source] of state.sources.logics)
      assert.equal(
        authoredLogicSource(state, num),
        source,
        `logic ${num} claim must reproduce its resource`,
      );
    for (const [num, source] of state.sources.pictures)
      assert.equal(authoredPictureSource(state, num), source);
    for (const [num, input] of state.sources.views)
      assert.deepEqual(
        [...buildView(input, state.profile)],
        [...state.container.getResource("view", num)!],
        `view ${num}`,
      );
    for (const [num, body] of state.sources.sounds) {
      const bytes = Array.isArray(body)
        ? buildSound(body)
        : compileSoundDocumentSource(body, state.profile.id);
      assert.deepEqual(
        [...bytes],
        [...state.container.getResource("sound", num)!],
        `sound ${num} claim must reproduce its resource`,
      );
    }
    const wordsFile = state.getFiles().get("WORDS.TOK")!;
    assert.deepEqual(
      new Map(parseWordsTok(wordsFile).map(({ word, id }) => [word, id])),
      state.sources.words,
      "WORDS.TOK and the dictionary claim agree",
    );
    assert.equal(seed.profileId, state.profile.id);
  });

  test("re-seeding the untouched Boilerplate is idempotent — a failed Genesis can retry", () => {
    const state = createAgentSessionState();
    installBoilerplateSeed(state);
    const before = fileBytes(state);
    // A world plan and game tests recorded before the failure are not
    // resource work; they survive a reseed.
    state.authoring.world.rooms["2"] = { title: "Annex", description: "", exits: {} };
    installBoilerplateSeed(state);
    assert.deepEqual(fileBytes(state), before);
    assert.ok(state.authoring.world.rooms["2"], "the recorded plan survives reseeding");
  });

  test("refuses a completed or imported session rather than reseeding it", () => {
    const state = createAgentSessionState();
    installBoilerplateSeed(state);
    state.genesisComplete = true;
    const before = fileBytes(state);
    assert.throws(() => installBoilerplateSeed(state), /already holds/);
    assert.deepEqual(fileBytes(state), before);
  });

  test("refuses to overwrite authored work that diverged from the seed", () => {
    const state = createAgentSessionState();
    const seed = installBoilerplateSeed(state);
    const replacement = assembleLogic("return;", {
      dictionary: state.sources.words,
      profile: state.profile,
    }).payload;
    state.container.putResource("logic", 1, replacement);
    state.sources.logics.set(1, "return;");
    assert.throws(() => installBoilerplateSeed(state), /authored work/);
    assert.deepEqual(
      [...state.container.getResource("logic", 1)!],
      [...replacement],
      "the divergent room is retained for review",
    );
    const expected = createStarterProject("boilerplate");
    const boot = openContainer(expected.files()).getResource("logic", 0)!;
    assert.deepEqual(
      [...state.container.getResource("logic", 0)!],
      [...boot],
      "the untouched seed resources stay intact",
    );
    assert.equal(seed.kind, "boilerplate");
  });

  test("refuses a reserved binding authored on top of the untouched bytes", () => {
    const state = createAgentSessionState();
    installBoilerplateSeed(state);
    const files = state.getFiles();
    const reserved = executeAgentTool(state, "reserve_binding", {
      bindings: [{ name: "beacon_flag", kind: "flag", id: 200 }],
      name: null,
      kind: null,
      id: null,
    });
    assert.equal(reserved.success, true);
    assert.deepEqual(state.getFiles(), files, "a binding alone keeps every native byte identical");
    assert.throws(() => installBoilerplateSeed(state), /authored work/);
    assert.ok(state.authoring.bindings["beacon_flag"], "the refused retry keeps the reservation");
  });

  test("refuses a seeded session whose claims drifted without byte changes", () => {
    for (const drift of [
      (state: AgentSessionState) => state.sources.sounds.delete(255),
      (state: AgentSessionState) =>
        state.sources.views.set(
          2,
          structuredClone(createStarterProject("starter").sources.views.get(0)!),
        ),
      (state: AgentSessionState) => state.sources.words.set("lark", 500),
      (state: AgentSessionState) =>
        state.sources.objects!.push({ name: "the ring", startingRoom: 1 }),
    ]) {
      const state = createAgentSessionState();
      installBoilerplateSeed(state);
      const files = state.getFiles();
      drift(state);
      assert.deepEqual(state.getFiles(), files, "claim drift alone keeps every byte identical");
      assert.throws(() => installBoilerplateSeed(state), /authored work/);
    }
  });

  test("refuses a session authored outside the seed", () => {
    const state = createAgentSessionState();
    state.container.putResource(
      "logic",
      1,
      assembleLogic("return;", { dictionary: state.sources.words, profile: state.profile }).payload,
    );
    assert.throws(() => installBoilerplateSeed(state), /authored work/);
  });

  test("refuses a non-2.936 session profile rather than mis-seeding it", () => {
    const state = createAgentSessionState(undefined, "2.917");
    assert.throws(() => installBoilerplateSeed(state), /2\.936/);
  });
});

function addDeathCommand(state: AgentSessionState): void {
  state.sources.words.set("die", 102);
  const source = state.sources.logics
    .get(1)!
    .replace("return;", 'if (said("die")) { call(death_logic); }\nreturn;');
  state.container.putResource(
    "logic",
    1,
    compileProjectLogic(source, {
      profile: state.profile,
      dictionary: state.sources.words,
      bindings: state.authoring.bindings,
    }).assembly.payload,
  );
  state.sources.logics.set(1, source);
}

describe("a seeded genesis session boots and plays in the real Engine", () => {
  test("boots into room 1 with a black picture and no actor", () => {
    const state = createAgentSessionState();
    installBoilerplateSeed(state);
    const { engine } = bootState(state);
    tick(engine, 6);
    assert.equal(engine.readState().room, 1);
    assert.deepEqual(engine.readObjects(), []);
    assert.ok(engine.getFrame().visual.every((pixel) => pixel === 0));
    assert.match(surfaceRows(engine).join("\n"), /Your game starts here/);
  });

  test("typing and F1 help work after dismissing the welcome", () => {
    const state = createAgentSessionState();
    installBoilerplateSeed(state);
    const { engine, host } = bootState(state);
    tick(engine, 6);
    host.keys.push(0x0d);
    tick(engine, 2);
    host.lines.push("look");
    tick(engine, 3);
    assert.match(surfaceRows(engine).join("\n"), /I don't know the word/);
    host.keys.push(0x0d);
    tick(engine, 2);
    host.keys.push(0x3b00);
    tick(engine, 3);
    assert.match(surfaceRows(engine).join("\n"), /arrow keys walk/i);
    assert.deepEqual(host.sounds, []);
  });

  test("ESC opens the seeded menu bar", () => {
    const state = createAgentSessionState();
    installBoilerplateSeed(state);
    const { engine, host } = bootState(state);
    tick(engine, 6);
    host.keys.push(0x0d);
    tick(engine, 2);
    host.keys.push(0x1b);
    tick(engine, 2);
    assert.equal(engine.modalKind, "menu");
    assert.deepEqual(
      engine.readMenuState().headings.map((h) => h.title),
      ["File", "Speed", "Sound", "Help"],
    );
  });

  test("die enters the shared death box, plays its cue and F9 restarts clean", () => {
    const state = createAgentSessionState();
    installBoilerplateSeed(state);
    addDeathCommand(state);
    const { engine, host } = bootState(state);
    tick(engine, 6);
    host.keys.push(0x0d);
    tick(engine, 2);
    host.lines.push("die");
    tick(engine, 3);
    assert.equal(engine.readState().flags[202], 1, "the death logic marked the player dead");
    assert.deepEqual(host.sounds, [255], "the shared death cue played once");
    assert.match(engine.textRow(10), /You have died/);
    host.keys.push(0x4300); // F9
    tick(engine, 4);
    const after = engine.readState();
    assert.equal(after.flags[202], 0, "restart cleared the dead flag");
    assert.equal(after.room, 1);
    assert.equal(after.flags[14], 1, "menu enabled again");
  });

  test("a cancelled restore keeps the player dead; a saved image revives", () => {
    const state = createAgentSessionState();
    installBoilerplateSeed(state);
    addDeathCommand(state);
    const { engine, host } = bootState(state);
    tick(engine, 6);
    host.keys.push(0x0d);
    tick(engine, 2);
    const image = engine.serialize();
    host.lines.push("die");
    tick(engine, 3);
    assert.equal(engine.readState().flags[202], 1);
    host.keys.push(0x31); // '1' -> Restore, host returns null: cancelled
    tick(engine, 3);
    assert.equal(engine.readState().flags[202], 1, "cancelled restore stays dead");
    host.restoreImage = image;
    host.keys.push(0x4100); // F7
    tick(engine, 3);
    assert.equal(engine.readState().flags[202], 0, "restore revived the player");
  });
});

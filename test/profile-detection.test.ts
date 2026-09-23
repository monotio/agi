import test from "node:test";
import assert from "node:assert/strict";
import { detectProfileDecision } from "../src/runtime/profile.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { openContainer } from "../src/container/container.ts";
import { buildTutorial } from "../games/adventure-department/game.ts";

const dummyHost: EngineHost = {
  print() {},
  displayAt() {},
  statusLine() {},
  takeInputLine: () => null,
  takeKeys: () => [],
  waitKey: () => {
    throw new Error("waitKey");
  },
  promptNumber: () => {
    throw new Error("promptNumber");
  },
  promptString: () => {
    throw new Error("promptString");
  },
  saveGame: () => {
    throw new Error("saveGame");
  },
  restoreGame: () => {
    throw new Error("restoreGame");
  },
  quit: () => {
    throw new Error("quit");
  },
  randomByte: () => 0,
};

test("detectProfileDecision reports kind 'binary' for interpreter binaries", () => {
  const binaryFiles = new Map<string, Uint8Array>([
    ["LOGDIR", new Uint8Array(3)],
    ["AGIDATA.OVL", new TextEncoder().encode("Adventure Game Interpreter\nVersion 2.917\n")],
  ]);
  const decision = detectProfileDecision(binaryFiles);
  assert.equal(decision.kind, "binary");
  assert.equal(decision.build, "2.917");
  assert.equal(decision.profile.id, "2.917");
});

test("a binary naming a build without a promoted profile runs the container fallback and reports the build", () => {
  const files = new Map<string, Uint8Array>([
    ["LOGDIR", new Uint8Array(3)],
    ["AGIDATA.OVL", new TextEncoder().encode("Adventure Game Interpreter\nVersion 2.903\n")],
  ]);
  const decision = detectProfileDecision(files);
  assert.equal(decision.kind, "binary");
  assert.equal(decision.build, "2.903");
  assert.equal(decision.profile.id, "2.936");
  const overridden = detectProfileDecision(files, "2.917");
  assert.equal(overridden.profile.id, "2.917", "an override replaces the profile");
  assert.equal(overridden.build, "2.903", "but not the identification");
});

test("detectProfileDecision reports kind 'catalog' for catalogued hash pairs without interpreter binaries", () => {
  const tutorial = buildTutorial();
  const files = new Map(Object.entries(tutorial.files));
  // Adventure Department has no interpreter files
  assert.equal(files.has("AGIDATA.OVL"), false);
  assert.equal(files.has("AGI"), false);
  const decision = detectProfileDecision(files);
  assert.equal(decision.kind, "catalog");
  assert.equal(decision.build, "2.936");
  assert.equal(decision.profile.id, "2.936");
});

test("detectProfileDecision reports kind 'default' for uncatalogued fan games without interpreter files", () => {
  const strippedV2 = new Map<string, Uint8Array>([
    ["LOGDIR", new Uint8Array(3)],
    ["PICDIR", new Uint8Array(3)],
    ["VIEWDIR", new Uint8Array(3)],
    ["SNDDIR", new Uint8Array(3)],
    ["VOL.0", new Uint8Array(10)],
    ["WORDS.TOK", new Uint8Array(52)],
  ]);
  const decision = detectProfileDecision(strippedV2);
  assert.equal(decision.kind, "default");
  assert.equal(decision.build, null);
  assert.equal(decision.profile.id, "2.936");
});

test("Engine constructor accepts an explicit profile override and exposes detection kind", () => {
  const strippedV2 = new Map<string, Uint8Array>([
    ["LOGDIR", new Uint8Array(3)],
    ["VOL.0", new Uint8Array(10)],
    ["WORDS.TOK", new Uint8Array(52)],
  ]);
  const container = openContainer(strippedV2);
  const engine = new Engine(container, dummyHost, undefined, { profile: "2.411" });
  assert.equal(engine.profile.id, "2.411");
  assert.equal(engine.profileKind, "default");
  assert.equal(engine.profileBuild, null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readProjectDocuments } from "../src/authoring/projectDocuments.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { compileProjectSelection } from "../src/authoring/projectSelection.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import {
  prepareGuidedRespondToCommand,
  type GuidedContext,
} from "../src/authoring/guidedProject.ts";
import { createContainer, openContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { parseWordsTok } from "../src/logic/words.ts";
import { Engine, type EngineHost } from "../src/runtime/engine.ts";
import { PROFILES, type AgiProfile } from "../src/runtime/profile.ts";

/**
 * Command matching under real said() semantics. The bare-logic cases pin the
 * interpreter rules the guided shadow check defers to — operand 1 matches any
 * one retained word, 9999 ends the pattern only where the profile recognizes
 * the rest-of-line terminator, and a literal pattern must consume every
 * retained word exactly — then the guided respond-to-command prepare → apply
 * → compile path lands a two-word handler the real engine answers, next to
 * the seeded literal it does not shadow.
 */

const ENTER = 0x0d;

class MatchHost implements EngineHost {
  keys: number[] = [];
  lines: string[] = [];
  printed: string[] = [];
  takeKeys(): number[] {
    return this.keys.splice(0);
  }
  takeInputLine(): string | null {
    return this.lines.shift() ?? null;
  }
  print(text: string): void {
    this.printed.push(text);
  }
  displayAt(): void {}
  statusLine(): void {}
}

const DICTIONARY = new Map([
  ["look", 100],
  ["north", 201],
  ["forest", 202],
]);

/** A bare logic 0 that arms the parser and prints once when `pattern` matches. */
function saidEngine(pattern: string, profile: AgiProfile = PROFILES["2.936"]) {
  const container = createContainer();
  container.putResource(
    "logic",
    0,
    assembleLogic(`accept.input();\nif (${pattern}) { print("matched"); }\nreturn;`, {
      dictionary: DICTIONARY,
      profile,
    }).payload,
  );
  const host = new MatchHost();
  const engine = new Engine(container, host, DICTIONARY, { profile });
  // The first pass's input phase runs before accept.input() arms the parser,
  // so input lines only land from the second cycle on.
  engine.tick();
  return { engine, host };
}

test("an exact literal said() fails on a command with a trailing word", () => {
  const { engine, host } = saidEngine('said("look")');
  host.lines.push("look");
  engine.tick();
  assert.deepEqual(host.printed, ["matched"], 'said("look") answers the exact word');
  host.keys.push(ENTER);
  engine.tick();
  host.lines.push("look north");
  engine.tick();
  assert.deepEqual(
    host.printed,
    ["matched"],
    "the literal pattern does not consume a trailing word",
  );
});

test("operand 1 matches any one retained word", () => {
  const { engine, host } = saidEngine("said(100, 1)");
  host.lines.push("look north");
  engine.tick();
  assert.deepEqual(host.printed, ["matched"], "said(100, 1) consumes 'look' plus any one word");
});

test("a 9999 tail consumes the rest of the line only where the profile allows it", () => {
  const { engine, host } = saidEngine("said(100, 9999)");
  host.lines.push("look north forest");
  engine.tick();
  assert.deepEqual(host.printed, ["matched"], "9999 ends the pattern mid-input here");

  const early = saidEngine("said(100, 9999)", PROFILES["2.089"]);
  early.host.lines.push("look north forest");
  early.engine.tick();
  assert.deepEqual(
    early.host.printed,
    [],
    "profile 2.089 has no tail terminator: 9999 is an ordinary word id",
  );
});

test("a prepared two-word command is answered by the real interpreter", () => {
  const project = createStarterProject("starter");
  const files = Object.fromEntries(project.files());
  const sources: Record<string, string> = {};
  for (const [num, source] of project.sources.logics) sources[`logic:${num}`] = source;
  for (const [num, source] of project.sources.pictures) sources[`picture:${num}`] = source;
  const read = readProjectDocuments({
    files,
    profileId: project.profileId,
    sources,
    bindings: project.bindings,
  });
  assert.deepEqual(read.diagnostics, []);
  const draft = new ProjectDraft(read.documents);
  const ctx: GuidedContext = { draft, files, profileId: project.profileId };

  // The seeded said("look") is a literal one-word pattern; it must not block
  // the longer command.
  const op = prepareGuidedRespondToCommand(ctx, {
    room: 1,
    command: "look north",
    response: "Trees to the north.",
  });
  assert.ok(op.ok, `prepare refused: ${op.ok ? "" : op.message}`);
  op.apply();

  const built = compileProjectSelection({
    draft,
    files,
    profileId: project.profileId,
    keys: draft.dirtyKeys(),
  });
  const gameFiles = built.compiled.files();
  const dictionary = new Map(
    parseWordsTok(gameFiles.get("WORDS.TOK")!).map(({ word, id }) => [word, id]),
  );
  const container = openContainer(gameFiles, { profile: PROFILES[project.profileId] });
  const host = new MatchHost();
  const engine = new Engine(container, host, dictionary, {
    profile: PROFILES[project.profileId],
  });
  const tickUntil = (want: () => boolean, limit: number, what: string) => {
    for (let i = 0; i < limit && !want(); i++) engine.tick();
    assert.ok(want(), `expected ${what} within ${limit} cycles`);
  };

  tickUntil(() => engine.readState().room === 1 && engine.readState().inputEnabled, 20, "room 1");
  host.lines.push("look north");
  tickUntil(() => host.printed.includes("Trees to the north."), 20, "the guided reply");
  assert.ok(
    !host.printed.includes(
      "You stand in a sunny clearing. A path leads past a grey cottage and a big leafy tree.",
    ),
    "the literal look handler did not answer the longer command",
  );
  host.keys.push(ENTER);
  engine.tick();

  // The one-word command still reaches the seeded handler.
  host.lines.push("look");
  tickUntil(
    () =>
      host.printed.includes(
        "You stand in a sunny clearing. A path leads past a grey cottage and a big leafy tree.",
      ),
    20,
    "the seeded look reply",
  );
});

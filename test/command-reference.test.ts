import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  V3_ACTIONS,
  IIGS_ACTIONS,
  AMIGA_ACTIONS,
  CONDITIONS,
  actionSpec,
} from "../src/logic/opcodes.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { commandReference, formatCommandCatalog } from "../src/agent/commandReference.ts";
import { createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
import { createOrientationPrompt, AGI_SYSTEM_PROMPT } from "../src/agent/prompt.ts";

test("command reference exactly follows every promoted profile and its operand variants", () => {
  for (const profile of Object.values(PROFILES)) {
    const refs = commandReference(profile);
    for (const candidate of [...ACTIONS, ...V3_ACTIONS, ...IIGS_ACTIONS, ...AMIGA_ACTIONS]) {
      // Names, not codes: the IIgs profile reassigns the shared tail codes to
      // its own actions, so code resolution cannot stand in for vocabulary.
      const real = actionSpec(candidate.name, profile);
      const entry = refs.find((item) => item.kind === "action" && item.name === candidate.name);
      assert.equal(Boolean(entry), Boolean(real), `${profile.id} ${candidate.name}`);
      if (real) assert.deepEqual(entry?.operands, real.operands);
    }
    // Conditions the assembler accepts: the IIgs 0x13 slot overruns its
    // handler table and is rejected there (docs/fidelity.md).
    const accepted = CONDITIONS.filter(
      (c) =>
        c.code <= profile.maxCondition &&
        !(c.code === 0x13 && profile.condition0x13 === "wild-dispatch"),
    );
    assert.deepEqual(
      refs.filter((item) => item.kind === "condition").map((item) => item.name),
      accepted.map((c) => c.name),
      profile.id,
    );
  }
});

test("the IIgs catalog omits click.move.pending; the Amiga 2.31x catalog lists it", () => {
  const names = (id: keyof typeof PROFILES) =>
    commandReference(PROFILES[id])
      .filter((item) => item.kind === "condition")
      .map((item) => item.name);
  assert.ok(!names("iigs-1.014").includes("click.move.pending"));
  assert.ok(names("amiga-2.316").includes("click.move.pending"));
});

test("Amiga stub slots carry stub help, not the PC effects", () => {
  // Each of these dispatch-table entries is the shared stub routine that only
  // steps over its operands (GR h6+0x66 / +0x72 / +0x8e; SQ2 and KQ2 h121).
  const stubs = {
    "amiga-2.202": ["menu.input", "open.dialogue", "close.dialogue"],
    "amiga-2.316": [
      "menu.input",
      "open.dialogue",
      "close.dialogue",
      "hold.key",
      "set.pri.base",
      "discard.sound",
      "hide.mouse",
      "allow.menu",
      "show.mouse",
      "fence.mouse",
      "release.key",
    ],
  } as const;
  for (const [id, names] of Object.entries(stubs)) {
    const refs = commandReference(PROFILES[id as keyof typeof stubs]);
    for (const name of names) {
      const help = refs.find((item) => item.name === name)?.help ?? "";
      assert.match(help, /^Amiga stub:/, `${id} ${name}`);
      assert.doesNotMatch(help, /priorit|gate|menu interaction|input-width/i, `${id} ${name}`);
    }
  }
  // Real handlers keep their help.
  const gr = commandReference(PROFILES["amiga-2.316"]);
  assert.match(gr.find((item) => item.name === "mouse.posn")?.help ?? "", /pointer/);
  assert.match(
    commandReference(PROFILES["2.936"]).find((item) => item.name === "set.pri.base")?.help ?? "",
    /priorities/,
  );
});

test("prompts load command details on demand using the imported game's profile", () => {
  const catalog = formatCommandCatalog(PROFILES["2.936"]);
  assert.ok(!AGI_SYSTEM_PROMPT.includes(catalog));
  assert.ok(AGI_SYSTEM_PROMPT.includes("read_command_reference"));
  const text = createOrientationPrompt({
    game: "custom",
    profile: "2.230",
    room: 1,
    sceneBrief: "",
  });
  assert.ok(!text.includes(formatCommandCatalog(PROFILES["2.230"])));
  assert.match(text, /Interpreter profile: 2\.230/);
  assert.ok(text.includes("read_command_reference"));
});

test("command lookup supplies real signatures and semantic help, and generic failures offer candidates", () => {
  const state = createAgentSessionState();
  const result = executeAgentTool(state, "read_command_reference", {
    query: "priority",
    kind: null,
    offset: 0,
  });
  assert.equal(result.success, true, result.error ?? "");
  assert.match(JSON.stringify(result.details), /set.priority/);
  assert.match(JSON.stringify(result.details), /already fixes/i);
  for (const [fake, real] of [
    ["fix.priority", "set.priority"],
    ["cycle.speed", "cycle.time"],
    ["positionn", "position"],
    ["relese.priorty", "release.priority"],
  ]) {
    const result = executeAgentTool(state, "write_logic_source", {
      room: 2,
      source: `${fake}(o1); return;`,
    });
    assert.equal(result.success, false);
    assert.ok(
      (result.details?.["relatedCommands"] as { name: string }[]).some((c) => c.name === real),
      `${fake}: ${JSON.stringify(result)}`,
    );
    assert.equal(state.container.getResource("logic", 2), null);
  }
});

test("compiler failures guide vocabulary and operand repairs without changing resources", () => {
  const state = createAgentSessionState();
  const word = executeAgentTool(state, "write_logic_source", {
    room: 2,
    source: 'if (said("unregistered")) { return; } return;',
  });
  assert.equal(word.success, false);
  assert.match(JSON.stringify(word.details), /read_words/);
  assert.match(JSON.stringify(word.details), /write_words/);
  const arity = executeAgentTool(state, "write_logic_source", {
    room: 2,
    source: "cycle.time(o1); return;",
  });
  assert.equal(arity.success, false);
  assert.match(JSON.stringify(arity.details), /cycle.time\(object, var\)/);
  assert.equal(state.container.getResource("logic", 2), null);
});

test("every exposed command has behavior help and exact searches lead with the requested command", () => {
  for (const profile of Object.values(PROFILES))
    for (const command of commandReference(profile))
      assert.ok(
        command.help && command.help.length > 12,
        `${profile.id}: ${command.name} lacks behavior help`,
      );
  const state = createAgentSessionState();
  const result = executeAgentTool(state, "read_command_reference", {
    query: "cycle.time",
    kind: "action",
    offset: 0,
  });
  const first = (result.details?.["commands"] as { name: string }[])[0];
  assert.equal(first?.name, "cycle.time");
});

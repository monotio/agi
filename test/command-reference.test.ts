import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, V3_ACTIONS, CONDITIONS, actionSpec } from "../src/logic/opcodes.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { commandReference, formatCommandCatalog } from "../src/agent/commandReference.ts";
import { createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
import { createOrientationPrompt, AGI_SYSTEM_PROMPT } from "../src/agent/prompt.ts";

test("command reference exactly follows every promoted profile and its operand variants", () => {
  for (const profile of Object.values(PROFILES)) {
    const refs = commandReference(profile);
    for (const candidate of [...ACTIONS, ...V3_ACTIONS]) {
      const real = actionSpec(candidate.code, profile);
      const entry = refs.find((item) => item.kind === "action" && item.name === candidate.name);
      assert.equal(Boolean(entry), Boolean(real), `${profile.id} ${candidate.name}`);
      if (real) assert.deepEqual(entry?.operands, real.operands);
    }
    assert.equal(
      refs.filter((item) => item.kind === "condition").length,
      CONDITIONS.filter((c) => c.code <= profile.maxCondition).length,
    );
  }
});

test("prompts load command details on demand using the imported game's profile", () => {
  const catalog = formatCommandCatalog(PROFILES["2.936"]);
  assert.ok(catalog.length < 12000);
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

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VOCABULARY,
  VOCABULARY_ACTIONS,
  toolDescription,
  parameterHelp,
} from "../src/vocabulary.ts";
import { AGENT_TOOLS } from "../src/agent/tools.ts";
import { WORKSPACE_AGENT_TOOLS } from "../app/src/agent/workspaceAgentTools.ts";
import { PROJECT_ASSIST_TOOLS } from "../app/src/agent/projectAssistTools.ts";
import { STUDIO_TERMS } from "../app/src/studio/studioTerms.ts";
import { createAgentSessionState } from "../src/agent/agentState.ts";
import { executeAgentTool, ASK_TOOLS } from "../src/agent/tools.ts";
import { renderPicture } from "../src/picture/renderer.ts";
import { createPictureSurface } from "../src/types.ts";

test("Add depth uses the item kernel, preserves art and rejects stale revisions", () => {
  const state = createAgentSessionState();
  const source =
    '# @item tree "Tree" art\nvis 2\npri off\nrect 20,50 30,80\nfill 25,60\n# @end\nend';
  assert.ok(executeAgentTool(state, "write_picture", { room: 1, source }).success);
  const read = executeAgentTool(state, "read_picture", { num: 1 });
  const revision = read.details?.["revision"];
  const before = createPictureSurface();
  renderPicture(state.container.getResource("picture", 1)!, before);
  const added = executeAgentTool(state, "add_depth", {
    num: 1,
    itemId: "tree",
    expectedRevision: revision,
    baseY: 80,
    priorityBase: 48,
  });
  assert.ok(added.success, added.error ?? "Add depth failed");
  const after = createPictureSurface();
  renderPicture(state.container.getResource("picture", 1)!, after);
  assert.deepEqual(after.visual, before.visual);
  assert.equal(after.priority[60 * 160 + 25], 7);
  assert.equal(after.priority[60 * 160 + 40], 4);
  const bytes = state.container.getResource("picture", 1)!.slice();
  const stale = executeAgentTool(state, "add_depth", {
    num: 1,
    itemId: "tree",
    expectedRevision: revision,
    baseY: 100,
    priorityBase: 48,
  });
  assert.equal(stale.success, false);
  assert.deepEqual(state.container.getResource("picture", 1), bytes);
  assert.ok(!ASK_TOOLS.includes("add_depth"));
});

test("vocabulary records have stable ids, plain help and technical hover", () => {
  for (const [id, term] of Object.entries(VOCABULARY)) {
    assert.equal(term.id, id);
    assert.ok(term.label.length > 0);
    assert.match(term.help, /\.$/);
    assert.equal(typeof term.technical, "string");
  }
  assert.equal(
    VOCABULARY.gate.help,
    "Characters stop here unless the room's LOGIC lets them through.",
  );
  assert.match(VOCABULARY.gate.technical, /ignore\.blocks/);
});

test("each action shares its name stem and help with every tool catalog", () => {
  const tools = [...AGENT_TOOLS, ...PROJECT_ASSIST_TOOLS, ...WORKSPACE_AGENT_TOOLS];
  for (const action of Object.values(VOCABULARY_ACTIONS)) {
    assert.equal(action.label.toLowerCase().replaceAll(" ", "_"), action.tool);
    const definitions = tools.filter((tool) => tool.name === action.tool);
    assert.ok(definitions.length > 0, action.tool);
    for (const definition of definitions) {
      assert.ok(definition.description.startsWith(action.help + " "), action.tool);
      assert.ok(definition.description.length > action.help.length + 20, action.tool);
    }
  }
  for (const tool of tools) assert.ok(tool.name in VOCABULARY_ACTIONS, tool.name);
  assert.equal(
    toolDescription("add_depth", "Uses the selected item."),
    VOCABULARY.addDepth.help + " Uses the selected item.",
  );
});

test("UI explainers use the canonical help lines", () => {
  const pairs = {
    depth: "depth",
    bands: "depthBand",
    "walk-lines": "walk",
    order: "drawOrder",
    step: "step",
    ghost: "standIn",
    loops: "loop",
    mirror: "mirrorLoop",
    transparent: "transparentColour",
    onion: "onionSkin",
    keep: "saved",
  } as const;
  for (const [ui, id] of Object.entries(pairs)) {
    assert.equal(STUDIO_TERMS[ui as keyof typeof STUDIO_TERMS].says, VOCABULARY[id].help, ui);
  }
});

test("every tool parameter opens with shared help and retains its input contract", () => {
  function check(tool: keyof typeof VOCABULARY_ACTIONS, fields: Record<string, unknown>): void {
    for (const [field, value] of Object.entries(fields)) {
      const schema = value as Record<string, unknown>;
      assert.equal(typeof schema["description"], "string", `${tool}.${field}`);
      assert.ok(
        (schema["description"] as string).startsWith(parameterHelp(tool, field) + " Input "),
        `${tool}.${field}`,
      );
      if (schema["properties"]) check(tool, schema["properties"] as Record<string, unknown>);
      const items = schema["items"] as Record<string, unknown> | undefined;
      if (items?.["properties"]) check(tool, items["properties"] as Record<string, unknown>);
    }
  }
  for (const tool of [...AGENT_TOOLS, ...PROJECT_ASSIST_TOOLS, ...WORKSPACE_AGENT_TOOLS])
    check(tool.name as keyof typeof VOCABULARY_ACTIONS, tool.parameters.properties);
  const sound = AGENT_TOOLS.find((tool) => tool.name === "read_sound")!;
  assert.deepEqual(
    (sound.parameters.properties["representation"] as Record<string, unknown>)["enum"],
    ["auto", "music", "sound", null],
  );
});

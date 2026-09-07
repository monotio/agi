import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
import { AGI_SYSTEM_PROMPT, createGenesisPrompt } from "../src/agent/prompt.ts";
import { splitToolResult } from "../src/agent/toolTransport.ts";

test("animated sprite feedback explains timing and baseline without silently changing logic", () => {
  const state = createAgentSessionState();
  const before = executeAgentTool(state, "write_logic_source", { room: 1, source: "return;" });
  assert.equal(before.success, true);
  const logic = state.container.getResource("logic", 1)!.slice();
  const result = executeAgentTool(state, "write_view", {
    num: 1,
    spec: {
      loops: [
        {
          cels: [
            { width: 1, height: 1, pixels: [1] },
            { width: 1, height: 1, pixels: [2] },
            { width: 1, height: 1, pixels: [3] },
          ],
        },
      ],
    },
  });
  assert.equal(result.success, true);
  const captions = result.images!.map((image) => image.caption).join("\n");
  assert.match(captions, /cycle.time/);
  assert.match(captions, /baseline/i);
  assert.match(captions, /logic/i);
  assert.deepEqual(state.container.getResource("logic", 1), logic);
  assert.ok(splitToolResult(result).text.length < 3000);
});

test("invented fix.priority is rejected with the authentic correction and no mutation", () => {
  const state = createAgentSessionState();
  executeAgentTool(state, "write_logic_source", { room: 2, source: "return;" });
  const original = state.container.getResource("logic", 2)!.slice();
  const bad = executeAgentTool(state, "write_logic_source", {
    room: 2,
    source: "fix.priority(o1); return;",
  });
  assert.equal(bad.success, false);
  assert.match(bad.error ?? "", /read_command_reference/);
  assert.match(JSON.stringify(bad.details), /set.priority/);
  assert.deepEqual(state.container.getResource("logic", 2), original);
  assert.match(AGI_SYSTEM_PROMPT, /cycle.time/);
  assert.match(AGI_SYSTEM_PROMPT, /v10.*pace/);
});

test("generated boot chooses a deliberate global cycle pace", () => {
  assert.match(createGenesisPrompt("A quiet courtyard"), /assignn\(v10, 2\)/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_TOOLS,
  createAgentSessionState,
  executeAgentTool,
  executeAgentToolAsync,
  type AgentRuntimeDeps,
} from "../src/agent/tools.ts";

test("every catalog tool rejects undeclared fields through both public dispatchers", async () => {
  for (const tool of AGENT_TOOLS) {
    const session = createAgentSessionState();
    for (const execute of [executeAgentTool, executeAgentToolAsync]) {
      const result = await execute(session, tool.name, { undeclared: true });
      assert.equal(result.success, false, tool.name);
      assert.match(result.error ?? "", /^Invalid arguments for /, tool.name);
    }
  }
});

const malformed: Record<string, Record<string, unknown>> = {
  read_room_context: { room: "1" },
  read_frames: { count: "9" },
  read_objects: { ids: "0" },
  read_state: { compact: "true" },
};

for (const [name, args] of Object.entries(malformed)) {
  const cases: Record<string, unknown> = {
    "wrong field type": args,
    "unknown field": { undeclared: true },
    "own prototype field": JSON.parse('{"__proto__":{"polluted":true}}'),
    "null arguments": null,
    "array arguments": [],
  };
  for (const [label, input] of Object.entries(cases)) {
    test(`${name} rejects ${label} before accessing the live interpreter`, async () => {
      let reads = 0;
      const deps: AgentRuntimeDeps = {
        readOnly: true,
        frames: {
          read() {
            reads++;
            return [];
          },
        },
        engine: {
          state() {
            reads++;
            return { room: 1 };
          },
          objects() {
            reads++;
            return [];
          },
        },
      };
      const result = await executeAgentToolAsync(
        createAgentSessionState(),
        name,
        input as Record<string, unknown>,
        deps,
      );
      assert.equal(reads, 0, "rejected calls must not read live data");
      assert.equal(result.success, false);
      assert.match(result.error ?? "", new RegExp(`^Invalid arguments for ${name};`));
    });
  }
}

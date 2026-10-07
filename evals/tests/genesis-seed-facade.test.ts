import assert from "node:assert/strict";
import { test } from "node:test";
import { validateGenesisToolCalls } from "../lib/asserts.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";

const seedRoom1 = createStarterProject("boilerplate").sources.logics.get(1)!;

test("anthropic tool_use calls inspect and rewrite the seeded room", () => {
  // The seed's room-1 source names its resources through readable bindings
  // (first_pic) — replaying it proves
  // the facade compiles the same authored surface the prompt describes.
  const rewritten = `${seedRoom1}\n// Rewritten during eval review.\n`;
  const result = validateGenesisToolCalls("", {
    providerResponse: {
      content: [
        { type: "tool_use", name: "read_logic", input: { num: 1, offset: 0, limit: 5 } },
        {
          type: "tool_use",
          name: "write_logic",
          input: { room: 1, source: rewritten },
        },
      ],
    },
  });
  assert.equal(result.pass, true, result.reason);
});

test("the parsed-output tool_calls shape replays against the seed too", () => {
  const result = validateGenesisToolCalls(
    {
      tool_calls: [
        {
          function: {
            name: "read_logic",
            arguments: JSON.stringify({ num: 1, offset: 0, limit: 5 }),
          },
        },
      ],
    },
    {},
  );
  assert.equal(result.pass, true, result.reason);
});

test("the seeded facade still fails calls against resources the seed does not hold", () => {
  const result = validateGenesisToolCalls("", {
    providerResponse: {
      output: [
        {
          type: "function_call",
          name: "read_logic",
          arguments: JSON.stringify({ num: 2, offset: 0, limit: 5 }),
        },
      ],
    },
  });
  assert.equal(result.pass, false);
  assert.match(result.reason ?? "", /Logic 2 is not present/);
});

test("Genesis starts with an empty VIEWS directory", () => {
  const result = validateGenesisToolCalls("", {
    providerResponse: {
      output: [
        {
          type: "function_call",
          name: "read_view",
          arguments: JSON.stringify({ num: 0, cels: null, rows: null }),
        },
      ],
    },
  });
  assert.equal(result.pass, false);
  assert.match(result.reason ?? "", /View 0 is not present/);
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "../src/agent/schemaValidate.ts";
import { AGENT_TOOLS } from "../src/agent/tools.ts";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    num: { type: "integer", minimum: 0, maximum: 255 },
    label: { type: ["string", "null"], maxLength: 4 },
    mode: { type: "string", enum: ["a", "b"] },
    items: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  required: ["num", "label", "mode", "items"],
};

describe("validateToolArguments", () => {
  it("accepts conforming arguments and treats a missing nullable field as null", () => {
    assert.deepEqual(
      validateToolArguments(schema, { num: 3, mode: "a", items: [{ name: "x" }] }),
      [],
    );
    assert.deepEqual(
      validateToolArguments(schema, { num: 3, label: null, mode: "b", items: [{ name: "x" }] }),
      [],
    );
  });

  it("reports type, range, enum, length, item count, unknown and missing fields", () => {
    const errors = validateToolArguments(schema, {
      num: 256,
      label: "toolong",
      mode: "c",
      items: [],
      extra: 1,
    });
    assert.deepEqual(errors, [
      "num must be <= 255, got 256.",
      "label must have at most 4 characters.",
      'mode must be one of ["a","b"].',
      "items must have at least 1 items.",
      "extra is not a known field.",
    ]);
    assert.deepEqual(validateToolArguments(schema, { num: 1.5, mode: "a", items: [{}] }), [
      "num must be integer, got number.",
      "items[0].name is required.",
    ]);
    assert.deepEqual(validateToolArguments(schema, {}), [
      "arguments.num is required.",
      "arguments.mode is required.",
      "arguments.items is required.",
    ]);
  });

  it("accepts an all-null optional call for every catalog tool", () => {
    for (const tool of AGENT_TOOLS) {
      const args: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(tool.parameters.properties)) {
        const type = (prop as { type?: unknown }).type;
        if (Array.isArray(type) && type.includes("null")) args[key] = null;
      }
      const errors = validateToolArguments(tool.parameters, args).filter(
        (e) => !e.endsWith("is required."),
      );
      assert.deepEqual(errors, [], tool.name);
    }
  });
});

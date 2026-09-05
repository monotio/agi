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
    hex: { type: ["string", "null"], pattern: "^[0-9A-Fa-f]+$" },
    beats: { type: ["number", "null"], exclusiveMinimum: 0, exclusiveMaximum: 8 },
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
    const ok = { num: 1, mode: "a", items: [{ name: "x" }] };
    assert.deepEqual(validateToolArguments(schema, { ...ok, hex: "0F", beats: 0.5 }), []);
    assert.deepEqual(validateToolArguments(schema, { ...ok, hex: "XYZ", beats: 0 }), [
      "hex must match ^[0-9A-Fa-f]+$.",
      "beats must be > 0, got 0.",
    ]);
    assert.deepEqual(validateToolArguments(schema, { ...ok, beats: 8 }), [
      "beats must be < 8, got 8.",
    ]);
    assert.deepEqual(validateToolArguments(schema, {}), [
      "arguments.num is required.",
      "arguments.mode is required.",
      "arguments.items is required.",
    ]);
  });

  it("the catalog uses only keywords the validator implements", () => {
    const known = new Set([
      "type",
      "description",
      "properties",
      "required",
      "additionalProperties",
      "items",
      "enum",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "minItems",
      "maxItems",
      "minLength",
      "maxLength",
      "pattern",
    ]);
    const walk = (schema: unknown, where: string): void => {
      if (!schema || typeof schema !== "object") return;
      for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
        assert.ok(known.has(key), `${where} uses unsupported keyword ${key}`);
        if (key === "properties")
          for (const [name, prop] of Object.entries(value as Record<string, unknown>))
            walk(prop, `${where}.${name}`);
        else if (key === "items") walk(value, `${where}[]`);
      }
    };
    for (const tool of AGENT_TOOLS) walk(tool.parameters, tool.name);
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

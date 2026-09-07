import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeToolArguments, validateToolArguments } from "../src/agent/schemaValidate.ts";
import { AGENT_TOOLS, createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
import { MAX_FRAMES } from "../src/agent/frames.ts";

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
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const raw = JSON.parse(
        `{"num":1,"mode":"a","items":[{"name":"x"}],${JSON.stringify(key)}:{"polluted":1}}`,
      );
      assert.deepEqual(validateToolArguments(schema, raw), [`${key} is not a known field.`]);
      assert.deepEqual(validateToolArguments(schema, normalizeToolArguments(schema, raw)), [
        `${key} is not a known field.`,
      ]);
      const session = createAgentSessionState();
      const call = JSON.parse(`{"words":["look"],${JSON.stringify(key)}:{"polluted":1}}`);
      const res = executeAgentTool(session, "write_words", call);
      assert.equal(res.success, false, key);
      assert.match(res.error ?? "", /not a known field/);
    }
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
    assert.deepEqual(validateToolArguments(schema, {}), [
      "arguments.num is required.",
      "arguments.mode is required.",
      "arguments.items is required.",
    ]);
  });

  it("normalizes omitted nullable fields to null, recursively, without mutating input", () => {
    const nested = {
      type: "object",
      properties: {
        ...schema.properties,
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, note: { type: ["string", "null"] } },
            required: ["name", "note"],
          },
        },
      },
      required: ["num", "label", "mode", "items"],
    };
    const input = { num: 1, mode: "a", items: [{ name: "x" }] };
    const out = normalizeToolArguments(nested, input);
    assert.deepEqual(out, { num: 1, mode: "a", items: [{ name: "x", note: null }], label: null });
    assert.deepEqual(input, { num: 1, mode: "a", items: [{ name: "x" }] });
    assert.deepEqual(normalizeToolArguments(nested, { ...input, label: "ok" }).label, "ok");
  });

  it("handlers that compare against null accept omitted optional fields at execution", () => {
    const session = createAgentSessionState();
    const actor = executeAgentTool(session, "write_actor", {
      num: 0,
      transparentColor: 0,
      mirrorLeftFromRight: true,
      right: [["120", "340"]],
      down: [["506", "780"]],
      up: [["90A", "BC0"]],
    });
    assert.equal(actor.success, true, actor.error ?? "");
    const music = executeAgentTool(session, "write_music", {
      num: 8,
      tempo: 90,
      tracks: [{ channel: "melody", volume: 13, events: [{ note: "C4", beats: 1, repeat: 1 }] }],
    });
    assert.equal(music.success, true, music.error ?? "");
    const read = executeAgentTool(session, "read_sound", { num: 8 });
    assert.equal(read.success, true, read.error ?? "");
    const paged = executeAgentTool(session, "read_logic", { num: 0 });
    assert.equal(paged.success, false);
    assert.doesNotMatch(paged.error ?? "", /required|Invalid arguments/);
  });

  it("bounds read_frames count and stride in the schema instead of clamping silently", () => {
    const tool = AGENT_TOOLS.find((candidate) => candidate.name === "read_frames")!;
    const good = { count: MAX_FRAMES, stride: 255, sheet: null, plane: null };
    assert.deepEqual(validateToolArguments(tool.parameters, good), []);
    assert.deepEqual(validateToolArguments(tool.parameters, { ...good, count: 0 }), [
      "count must be >= 1, got 0.",
    ]);
    assert.deepEqual(validateToolArguments(tool.parameters, { ...good, count: MAX_FRAMES + 1 }), [
      `count must be <= ${MAX_FRAMES}, got ${MAX_FRAMES + 1}.`,
    ]);
    assert.deepEqual(validateToolArguments(tool.parameters, { ...good, stride: 0 }), [
      "stride must be >= 1, got 0.",
    ]);
    assert.deepEqual(validateToolArguments(tool.parameters, { ...good, stride: 256 }), [
      "stride must be <= 255, got 256.",
    ]);
  });

  it("the catalog uses only keywords the validator implements", () => {
    const known: Record<string, true> = {
      type: true,
      description: true,
      properties: true,
      required: true,
      additionalProperties: true,
      items: true,
      enum: true,
      minimum: true,
      maximum: true,
      exclusiveMinimum: true,
      exclusiveMaximum: true,
      minItems: true,
      maxItems: true,
      minLength: true,
      maxLength: true,
      pattern: true,
    };
    const walk = (schema: unknown, where: string): void => {
      if (!schema || typeof schema !== "object") return;
      for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
        assert.ok(Object.hasOwn(known, key), `${where} uses unsupported keyword ${key}`);
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

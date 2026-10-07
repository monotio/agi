import assert from "node:assert/strict";
import { test } from "node:test";
import { proposeNames } from "../src/agent/namingTools.ts";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";

const source =
  'set(f36);\nif (isset(f36)) { print(m1); }\nreturn;\n#message 1 "The brass key opens the gate."';
function proposal() {
  return {
    name: "gate_open",
    kind: "flag" as const,
    id: 36,
    logic: null,
    rename: null,
    evidence: [
      {
        logic: 1,
        line: 1,
        role: "Changed",
        text: "set(f36);",
        nearbyMessages: ["The brass key opens the gate."],
      },
      {
        logic: 1,
        line: 2,
        role: "Read",
        text: "if (isset(f36)) { print(m1); }",
        nearbyMessages: ["The brass key opens the gate."],
      },
    ],
  };
}
const input = { documents: { "logic:1": source, bindings: "{}" }, profile: DEFAULT_V2_PROFILE };

test("naming requires read and changed identity evidence and keeps it in the reviewed bindings", () => {
  const changes = proposeNames({ ...input, names: [proposal()] });
  assert.equal(changes.length, 1);
  const names = JSON.parse(String(changes[0]!.content));
  assert.deepEqual(names.gate_open.evidence, proposal().evidence);
});

test("thin, stale and invented naming evidence produces no proposal", () => {
  for (const names of [
    [{ ...proposal(), evidence: [] }],
    [{ ...proposal(), evidence: proposal().evidence.slice(0, 1) }],
    [{ ...proposal(), evidence: proposal().evidence.map((e) => ({ ...e, role: "Used" })) }],
    [{ ...proposal(), evidence: proposal().evidence.map((e) => ({ ...e, text: "reset(f36);" })) }],
    [
      {
        ...proposal(),
        evidence: proposal().evidence.map((e) => ({ ...e, nearbyMessages: ["A guessed clue"] })),
      },
    ],
    [{ ...proposal(), id: 37 }],
    [{ ...proposal(), kind: "view" as const, id: 36 }],
  ])
    assert.throws(() => proposeNames({ ...input, names }));
  assert.equal(input.documents.bindings, "{}");
});

test("message evidence belongs to its LOGIC and names preserve other metadata", () => {
  const message = {
    ...proposal(),
    name: "gate_hint",
    kind: "message" as const,
    id: 1,
    logic: 1,
    evidence: [{ ...proposal().evidence[1]!, role: "Used" }],
  };
  const changes = proposeNames({ ...input, names: [message] });
  assert.equal(JSON.parse(String(changes[0]!.content)).gate_hint.logic, 1);
  assert.throws(() => proposeNames({ ...input, names: [{ ...message, logic: 2 }] }));
});

test("resource and variable names use typed references, including a literal PICTURE selector", () => {
  const code =
    'v40=1; draw.pic(v40); if (v40==1) { print(m1); } call(2); set.view(o1,3); sound(4,f40); return;\n#message 1 "The gate scene"';
  const evidence = {
    logic: 1,
    line: 1,
    role: "Used",
    text: code.split("\n")[0]!,
    nearbyMessages: ["The gate scene"],
  };
  const names = [
    { name: "gate_picture", kind: "picture" as const, id: 1 },
    { name: "gate_logic", kind: "logic" as const, id: 2 },
    { name: "gate_view", kind: "view" as const, id: 3 },
    { name: "gate_sound", kind: "sound" as const, id: 4 },
    { name: "scene_selector", kind: "variable" as const, id: 40 },
  ].map((item) => ({
    ...item,
    logic: null,
    rename: null,
    evidence:
      item.kind === "variable"
        ? [
            { ...evidence, role: "Changed" },
            { ...evidence, role: "Read" },
          ]
        : [evidence],
  }));
  const changes = proposeNames({
    documents: { "logic:1": code },
    profile: DEFAULT_V2_PROFILE,
    names,
  });
  assert.deepEqual(Object.keys(JSON.parse(String(changes[0]!.content))), [
    "gate_logic",
    "gate_picture",
    "gate_sound",
    "gate_view",
    "scene_selector",
  ]);
});

test("nearby naming evidence quotes game messages rather than vocabulary", () => {
  const code =
    'set(f36); if (isset(f36) && said("brass")) { print(m1); } return; #message 1 "Look closer"';
  assert.throws(
    () =>
      proposeNames({
        documents: { "logic:1": code, words: '[["brass",2]]' },
        profile: DEFAULT_V2_PROFILE,
        names: [
          {
            ...proposal(),
            evidence: ["Changed", "Read"].map((role) => ({
              logic: 1,
              line: 1,
              role,
              text: code,
              nearbyMessages: ["brass"],
            })),
          },
        ],
      }),
    /messages/,
  );
});

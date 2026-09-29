import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import { inspectProjectReferences } from "../src/authoring/projectReferences.ts";
import { inspectProjectSourceDependencies } from "../src/authoring/projectSourceDependencies.ts";

for (const [profileId, source, expected] of [
  ["iigs-1.014", "discard.sound(5); load.sound(7); return;", ["sound:5", "sound:7"]],
  ["3.002.149", "discard.sound(); return;", []],
  ["amiga-2.333", "discard.sound(5); return;", []],
] as const) {
  test(`${profileId} sound discard dependencies follow its real operand behavior`, () => {
    const profile = PROFILES[profileId];
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(source, { profile, dictionary: new Map() }).payload,
    );
    const native = inspectProjectReferences({ container, profile });
    const authored = inspectProjectSourceDependencies({ source, profile, bindings: {} });
    assert.deepEqual(native.dependencies["logic:0"] ?? [], expected);
    assert.deepEqual(authored.dependencies, expected);
    assert.deepEqual(authored.unresolved, []);
    assert.deepEqual(
      native.references.map(({ target }) => target),
      expected.map((key) => ({ kind: "sound", num: Number(key.slice(6)) })),
    );
  });
}

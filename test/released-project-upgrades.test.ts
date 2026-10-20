import assert from "node:assert/strict";
import { test } from "node:test";
import { releasedTemplates } from "./released-template-fixtures.ts";
import { migrateScriptSize } from "../src/authoring/scriptSizeMigration.ts";
import { parseLogicSyntax } from "../src/logic/syntax.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { createContainer } from "../src/container/container.ts";
import { Engine } from "../src/runtime/engine.ts";
import { decodeSave } from "../src/runtime/persistence.ts";

for (const { version, source } of releasedTemplates) {
  test(`released ${version} boot and word feedback upgrade together`, () => {
    const result = migrateScriptSize({ "logic:0": source });
    assert.ok(result);
    const updated = String(result["logic:0"]);
    assert.match(updated, /set\(f200\);\n {2}script.size\(200\);/);
    const tree = parseLogicSyntax(updated);
    assert.ok(tree.program.length);
    for (let k = 1; k <= 11; k++) assert.ok(updated.includes(`word.to.string(s11, ${k - 1});`));
    assert.equal(migrateScriptSize(result), null);
  });
}
const base = releasedTemplates.at(-1)!.source;
const variants: Record<string, string> = {
  "setter outside guard": "if (!isset(f200)) { assignn(v42, 1); }\nset(f200);",
  "Astra commented guard": "// Historical boot: if (!isset(f200)) {\nset(f200);",
  "Astra earlier unrelated setter": "set(f200);\n" + base,
  "duplicate setters": base.replace("set(f200);", "set(f200); set(f200);"),
  "nested guard": base
    .replace("if (!isset(f200)) {", "if (isset(f40)) { if (!isset(f200)) {")
    .replace("call.v(current_room);", "} call.v(current_room);"),
  "combined guard": base.replace("!isset(f200)", "!isset(f200) && !isset(f40)"),
  "renamed guard": base.replaceAll("f200", "f199"),
  "guard in string": '#message 99 "!isset(f200)"\nset(f200);',
};
for (const [name, source] of Object.entries(variants))
  test(`${name} preserves replay over four ticks and restores blue`, () => {
    const changed = migrateScriptSize({ "logic:0": source });
    const updated = String(changed?.["logic:0"] ?? source);
    assert.equal(updated.includes("script.size(200)"), false, "custom boot is never rewritten");
    const container = createContainer();
    container.putResource(
      "logic",
      0,
      assembleLogic(
        `assignn(v0,1);\n${updated}\nif (!isset(f220)) { set(f220); assignn(v43,1); load.pic(v43); draw.pic(v43); }`,
        { dictionary: new Map() },
      ).payload,
    );
    container.putResource("logic", 1, assembleLogic("return;", { dictionary: new Map() }).payload);
    container.putResource("picture", 1, Uint8Array.of(0xf0, 1, 0xf8, 0, 0, 0xff));
    const host = {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => [],
    };
    const engine = new Engine(container, host);
    for (let tick = 0; tick < 4; tick++) {
      engine.tick();
      const saved = decodeSave(engine.serialize(), engine.profile);
      assert.equal(saved.replayActive, 2);
      // Native replay kinds 2 and 4 load and draw PICTURE 1.
      assert.deepEqual(saved.replay.slice(0, saved.replayActive), [
        { kind: 2, value: 1 },
        { kind: 4, value: 1 },
      ]);
    }
    const restored = new Engine(container, host);
    restored.restoreImage(engine.serialize());
    assert.equal(restored.surface.visual[0], 1);
  });

test("project bindings resolve the released boot and fallback without changing the author names", () => {
  const source = base.replaceAll("f200", "boot_flag").replaceAll("parser_status", "unknown_word");
  const bindings = JSON.stringify({
    boot_flag: { kind: "flag", num: 200 },
    unknown_word: { kind: "variable", num: 9 },
  });
  const result = migrateScriptSize({ "logic:0": source, bindings });
  assert.ok(result);
  const updated = String(result["logic:0"]);
  assert.ok(updated.includes("set(boot_flag);\n  script.size(200);"));
  assert.ok(updated.includes("equaln(unknown_word, 1)"));
  assert.ok(updated.includes("word.to.string(s11, 0)"));
});

test("a called resource writing the boot flag prevents an automatic resize, including indirect writes", () => {
  for (const action of ["set(f200);", "reset(f200);", "toggle(f200);", "set.v(v40);"]) {
    const c = createContainer();
    c.putResource("logic", 0, assembleLogic(base, { dictionary: new Map() }).payload);
    c.putResource(
      "logic",
      3,
      assembleLogic(action + " return;", { dictionary: new Map() }).payload,
    );
    const changed = migrateScriptSize({ "logic:0": base }, Object.fromEntries(c.files));
    assert.ok(!String(changed?.["logic:0"] ?? base).includes("script.size(200)"));
  }
});

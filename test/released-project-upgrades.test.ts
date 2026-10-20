import assert from "node:assert/strict";
import { test } from "node:test";
import { releasedTemplates } from "./released-template-fixtures.ts";
import { migrateScriptSize } from "../src/authoring/scriptSizeMigration.ts";
import { parseLogicSyntax } from "../src/logic/syntax.ts";
import { assembleLogic } from "../src/logic/assembler.ts";
import { createContainer } from "../src/container/container.ts";
import { Engine } from "../src/runtime/engine.ts";
import { decodeSave } from "../src/runtime/persistence.ts";

for (const {version, source} of releasedTemplates) {
  test(`released ${version} boot and word feedback upgrade together`, () => {
    const result = migrateScriptSize({"logic:0": source});
    assert.ok(result);
    const updated = String(result["logic:0"]);
    assert.match(updated, /set\(f200\);\n  script.size\(200\);/);
    const tree = parseLogicSyntax(updated);
    assert.ok(tree.program.length);
    for (let k = 1; k <= 11; k++) assert.ok(updated.includes(`word.to.string(s11, ${k-1});`));
    assert.equal(migrateScriptSize(result), null);
  });
}
const base = releasedTemplates.at(-1)!.source;
const variants: Record<string, string> = {
  "setter outside guard": 'if (!isset(f200)) { assignn(v42, 1); }\nset(f200);',
  "Astra commented guard": '// Historical boot: if (!isset(f200)) {\nset(f200);',
  "Astra earlier unrelated setter": 'set(f200);\n' + base,
  "duplicate setters": base.replace('set(f200);', 'set(f200); set(f200);'),
  "nested guard": base.replace("if (!isset(f200)) {", "if (isset(f40)) { if (!isset(f200)) {").replace("call.v(current_room);", "} call.v(current_room);"),
  "combined guard": base.replace('!isset(f200)', '!isset(f200) && !isset(f40)'),
  "renamed guard": base.replaceAll('f200', 'f199'),
  "guard in string": '#message 99 "!isset(f200)"\nset(f200);',
};
for (const [name, source] of Object.entries(variants)) test(`${name} preserves replay over four ticks and restores blue`, () => {
  const changed = migrateScriptSize({"logic:0":source});
  const updated = String(changed?.["logic:0"] ?? source);
  assert.equal(updated.includes('script.size(200)'), false, "custom boot is never rewritten");
  const container = createContainer();
  container.putResource('logic', 0, assembleLogic(`assignn(v0,1);\n${updated}\nif (!isset(f220)) { set(f220); assignn(v43,1); load.pic(v43); draw.pic(v43); }`, {dictionary:new Map()}).payload);
  container.putResource('logic', 1, assembleLogic('return;', {dictionary:new Map()}).payload);
  container.putResource('picture', 1, Uint8Array.of(0xf0,1,0xf8,0,0,0xff));
  const host = {print(){}, displayAt(){}, statusLine(){}, takeInputLine:()=>null, takeKeys:()=>[]};
  const engine = new Engine(container,host);
  for(let tick=0;tick<4;tick++) { engine.tick(); assert.equal(decodeSave(engine.serialize(),engine.profile).replayActive, 2); }
  const restored = new Engine(container,host);
  restored.restoreImage(engine.serialize());
  assert.equal(restored.surface.visual[0],1);
});

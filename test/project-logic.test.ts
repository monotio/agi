import { test } from "node:test";
import assert from "node:assert/strict";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { AssemblerError } from "../src/logic/assembler.ts";
import { DEFAULT_V2_PROFILE } from "../src/runtime/profile.ts";

const context = {
  profile: DEFAULT_V2_PROFILE,
  dictionary: new Map([["open", 100]]),
  bindings: { door: { num: 50 }, score: { num: 30 } },
};

test("project logic builds real bytes without an agent session and retains source origins", () => {
  const source = "set(door); score = 7; return;";
  const build = compileProjectLogic(source, { ...context, sourceMap: true });
  assert.deepEqual([...build.assembly.code], [12, 50, 3, 30, 7, 0]);
  assert.equal(build.expansion.authored, source);
  assert.equal(build.expansion.prelude, "#define door 50\n#define score 30\n");
  const map = build.assembly.sourceMap!;
  assert.equal(map.source, build.expansion.prelude + source);
  assert.equal(map.entries[0]!.start, build.expansion.authoredStart);
  assert.equal(map.source.slice(map.entries[0]!.start, map.entries[0]!.end), "set(door);");
});

test("source definitions shadow generated bindings and body errors retain authored lines", () => {
  const build = compileProjectLogic("#define door 51\nset(door); return;", context);
  assert.deepEqual([...build.assembly.code], [12, 51, 0]);
  assert.equal(build.expansion.prelude, "#define score 30\n");
  assert.throws(
    () => compileProjectLogic("return;\nunknown();", context),
    (error: unknown) => error instanceof AssemblerError && error.line === 2 && error.col === 1,
  );
});

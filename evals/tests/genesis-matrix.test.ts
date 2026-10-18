import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { BASE_TEMPLATE_LOGIC0_SOURCE } from "../../src/authoring/baseTemplate.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { analyzeLogic, logic0TemplateSource } from "../genesis-matrix.ts";

const BENCHMARKS = resolve(import.meta.dirname, "../benchmarks/genesis");

/**
 * Every committed Genesis snapshot must still analyse to the metrics committed
 * beside it. A change to the analyser, or to the engine code it reads games
 * with, that moves a number shows up here instead of silently making later
 * snapshots incomparable with earlier ones.
 */
for (const version of readdirSync(BENCHMARKS)) {
  test(`genesis benchmark ${version} reproduces its committed metrics`, () => {
    const snapshot = join(BENCHMARKS, version);
    const out = mkdtempSync(join(tmpdir(), "agi-genesis-matrix-"));
    try {
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          resolve(import.meta.dirname, "../genesis-matrix.ts"),
          join(snapshot, "runs"),
          out,
        ],
        { stdio: "pipe" },
      );
      assert.deepEqual(
        JSON.parse(readFileSync(join(out, "metrics.json"), "utf8")),
        JSON.parse(readFileSync(join(snapshot, "matrix", "metrics.json"), "utf8")),
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}

/**
 * Logic 0 counts as model-authored only when the model changed it. A run is
 * compared against the base template revision it started from, so a later
 * template change is not reported as a model edit in historical runs.
 */
const NO_WORDS = new Map<string, number>();
const assemble = (source: string) =>
  assembleLogic(source, { dictionary: NO_WORDS, profile: DEFAULT_V2_PROFILE }).payload;
const logic0Analysis = (source: string) => {
  const payload = assemble(source);
  const template = assemble(logic0TemplateSource(payload, NO_WORDS));
  return analyzeLogic(0, payload, NO_WORDS, new Map([[0, template]]));
};
const SCRIPT_SIZE_LINE = /^[ \t]*script\.size\(200\);\r?\n/m;
const WITHOUT_SCRIPT_SIZE = BASE_TEMPLATE_LOGIC0_SOURCE.replace(SCRIPT_SIZE_LINE, "");
const LEGACY_WORD_INDEX = (source: string) =>
  source.replace(
    /word\.to\.string\(s11, (\d+)\);/g,
    (_, idx: string) => `word.to.string(s11, ${Number(idx) + 1});`,
  );

test("current template logic 0 is unmodified", () => {
  const info = logic0Analysis(BASE_TEMPLATE_LOGIC0_SOURCE);
  assert.equal(info.templateStatus, "identical");
  assert.equal(info.templateDelta, undefined);
});

test("logic 0 from the template before script.size is unmodified", () => {
  assert.notEqual(WITHOUT_SCRIPT_SIZE, BASE_TEMPLATE_LOGIC0_SOURCE);
  const info = logic0Analysis(WITHOUT_SCRIPT_SIZE);
  assert.equal(info.templateDelta, undefined);
  assert.equal(info.templateStatus, "identical");
});

test("logic 0 from the template before both word index and script.size is unmodified", () => {
  const info = logic0Analysis(LEGACY_WORD_INDEX(WITHOUT_SCRIPT_SIZE));
  assert.equal(info.templateDelta, undefined);
  assert.equal(info.templateStatus, "identical");
});

test("a model edit to logic 0 still counts as modified", () => {
  const info = logic0Analysis(BASE_TEMPLATE_LOGIC0_SOURCE.replace("  status.line.on();\n", ""));
  assert.equal(info.templateStatus, "modified");
  assert.deepEqual(info.templateDelta, { changedMessages: [], addedInsns: [], removedInsns: 1 });
});

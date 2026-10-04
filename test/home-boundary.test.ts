import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { homeBoundaryLeaks } from "../scripts/lint-deps.mjs";
import { HOME_ENTRY, HOME_START } from "../scripts/deferred-modules.mjs";

const presence = HOME_START[0]!;
const deferred = "app/src/project/playerSentences.ts";

test("Home follows static chains from both roots and reports their paths", () => {
  const graph: {
    source: string;
    dependencies: { resolved: string; dependencyTypes: string[] }[];
  }[] = [
    { source: HOME_ENTRY, dependencies: [{ resolved: "app/src/App.vue", dependencyTypes: [] }] },
    {
      source: "app/src/App.vue",
      dependencies: [{ resolved: "app/src/library/useGameLibrary.ts", dependencyTypes: [] }],
    },
    {
      source: "app/src/library/useGameLibrary.ts",
      dependencies: [{ resolved: deferred, dependencyTypes: [] }],
    },
    { source: deferred, dependencies: [{ resolved: HOME_ENTRY, dependencyTypes: [] }] },
    {
      source: presence,
      dependencies: [{ resolved: "src/studio/vocabulary.ts", dependencyTypes: [] }],
    },
    { source: "src/studio/vocabulary.ts", dependencies: [] },
  ];
  assert.deepEqual(homeBoundaryLeaks(graph), [
    [HOME_ENTRY, "app/src/App.vue", "app/src/library/useGameLibrary.ts", deferred],
    [presence, "src/studio/vocabulary.ts"],
  ]);
  // A dynamic or type-only edge anywhere along a chain cuts off its static tail.
  for (const dependencyTypes of [["dynamic-import"], ["type-only"]]) {
    const allowed = structuredClone(graph);
    allowed[0]!.dependencies[0]!.dependencyTypes = dependencyTypes;
    allowed[4]!.dependencies[0]!.dependencyTypes = dependencyTypes;
    assert.deepEqual(homeBoundaryLeaks(allowed), []);
    // A second, static route to the same module still leaks.
    allowed[0]!.dependencies.push({ resolved: deferred, dependencyTypes: [] });
    assert.deepEqual(homeBoundaryLeaks(allowed), [[HOME_ENTRY, deferred]]);
  }
  assert.throws(() => homeBoundaryLeaks(graph.slice(1)), /Home root.*app\/src\/main\.ts/);
  assert.throws(() => homeBoundaryLeaks(graph.filter((m) => m.source !== presence)), /Home root/);
});

test("the dependency reporter checks real Vue imports, re-exports and erased type imports", () => {
  const directory = mkdtempSync(join(tmpdir(), "agi-home-boundary-"));
  const cli = fileURLToPath(
    new URL("../../bin/dependency-cruiser.mjs", import.meta.resolve("dependency-cruiser")),
  );
  function write(file: string, text: string): void {
    const target = join(directory, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  function run() {
    return spawnSync(
      process.execPath,
      [
        cli,
        HOME_ENTRY,
        ...HOME_START,
        "--config",
        fileURLToPath(new URL("../.dependency-cruiser.mjs", import.meta.url)),
        "--output-type",
        `plugin:${new URL("../scripts/lint-deps.mjs", import.meta.url).href}`,
      ],
      { cwd: directory, encoding: "utf8", timeout: 20000 },
    );
  }
  try {
    write(HOME_ENTRY, 'import "./App.vue";');
    write(presence, "export {};");
    write(
      "app/src/App.vue",
      '<script setup lang="ts">import { value } from "./library/barrel.ts";</script><template>{{ value }}</template>',
    );
    write("app/src/library/barrel.ts", 'export { value } from "../project/playerSentences.ts";');
    write(deferred, "export const value = 1; export type Shape = { value: number };");
    let result = run();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Home static boundary failed/);
    assert.match(result.stdout, /main\.ts.*App\.vue.*barrel\.ts.*playerSentences\.ts/);
    // Exercise the real parser's syntax classifications, including inline types.
    write(
      "app/src/library/barrel.ts",
      'import type { Shape } from "../project/playerSentences.ts";\n' +
        'import { type Shape as Other } from "../project/playerSentences.ts";\n' +
        'export type { Shape } from "../project/playerSentences.ts";\n' +
        'export { type Shape as Alias } from "../project/playerSentences.ts";\n' +
        'export const value = () => import("../project/playerSentences.ts");',
    );
    result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Home static boundary passed.*ms/);
    write(
      "app/src/library/barrel.ts",
      'import type { Shape } from "../project/playerSentences.ts";\n' +
        'export const lazy = () => import("../project/playerSentences.ts");\n' +
        'export { value } from "../project/playerSentences.ts";',
    );
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Home static boundary failed/);
    // Existing dependency errors retain their verdict when Home itself is safe.
    write("app/src/library/barrel.ts", "export const value = 1;");
    write(presence, 'import "../../../src/platform.ts";');
    write("src/platform.ts", 'import "node:fs";');
    result = run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /src-no-platform-modules/);
    assert.match(result.stdout, /Home static boundary passed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the shared Home entry matches the HTML module script", () => {
  const html = readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
  const moduleScript = html.match(/<script\s+type="module"\s+src="([^"]+)"/);
  assert.equal(`app${moduleScript?.[1]}`, HOME_ENTRY);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphChunk } from "../scripts/check-bundle-budget.ts";

const entry = "assets/engine.worker.js";
function chunk(
  file: string,
  imports: readonly string[] = [],
  dynamicImports: readonly string[] = [],
): GraphChunk {
  return { file, isEntry: file === entry, imports, dynamicImports, css: [], modules: [] };
}

function runGate(startup: boolean, unsafe: boolean) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "agi-worker-entry-gate-")));
  const scripts = join(directory, "scripts");
  const app = join(directory, "app");
  const assets = join(app, "dist", "assets");
  const fonts = join(app, "dist", "fonts");
  const records = join(app, "node_modules", ".agi");
  for (const path of [scripts, assets, fonts, records]) mkdirSync(path, { recursive: true });
  const debuggerFile = "assets/debugController.js";
  const home = "assets/home.js";
  try {
    // This size-only build fixture includes the two required startup fonts.
    writeFileSync(join(fonts, "sans.woff2"), new Uint8Array([0x77, 0x4f, 0x46, 0x32]));
    writeFileSync(join(fonts, "mono.woff2"), new Uint8Array([0x77, 0x4f, 0x46, 0x32]));
    // Run the actual gate, unchanged, in a complete disposable build tree.
    writeFileSync(
      join(scripts, "check-bundle-budget.ts"),
      readFileSync(new URL("../scripts/check-bundle-budget.ts", import.meta.url)),
    );
    writeFileSync(
      join(app, "bundle-graph.config.ts"),
      readFileSync(new URL("../app/bundle-graph.config.ts", import.meta.url)),
    );
    writeFileSync(
      join(app, "devKeys.config.ts"),
      readFileSync(new URL("../app/devKeys.config.ts", import.meta.url)),
    );
    const main = { ...chunk("assets/index.js", [], [home]), isEntry: true };
    const starter = {
      ...chunk(home),
      modules: [
        "games/adventure-department/game.ts",
        "app/src/play/PlayArea.vue",
        "app/src/three/AgiStage.ts",
        "app/src/audio/AgiAudio.ts",
        "app/src/library/gamePreview.ts",
        "app/src/library/gameLibrary.ts",
        "app/src/project/projectHistoryStorage.ts",
        "app/src/world/useRoomMap.ts",
        "app/src/history/useHistoryView.ts",
        "app/src/history/useHistoryController.ts",
        "app/src/agent/agentLog.ts",
      ],
    };
    const presence = {
      ...chunk("assets/presence.js"),
      modules: ["app/src/project/earlierProgress.ts"],
    };
    const create = {
      ...chunk("assets/create.js"),
      modules: ["app/src/studio/workspace/CreateWorkspace.vue"],
    };
    const graph = {
      chunks: [main, starter, presence, create],
      assets: [{ file: entry }],
      workers: {
        [entry]: [chunk(entry, [], [debuggerFile]), chunk(debuggerFile, unsafe ? [entry] : [])],
      },
    };
    writeFileSync(join(records, "bundle-graph.json"), JSON.stringify(graph));
    writeFileSync(
      join(assets, "index.js"),
      startup ? 'new Worker("engine.worker.js");' : "export {};",
    );
    writeFileSync(join(assets, "home.js"), "export {};");
    writeFileSync(join(assets, "presence.js"), "export {};");
    writeFileSync(join(assets, "create.js"), "export {};");
    writeFileSync(join(assets, "engine.worker.js"), "self.onmessage = () => {};");
    writeFileSync(
      join(assets, "debugController.js"),
      unsafe ? 'import "./engine.worker.js";' : "export {};",
    );
    return spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(scripts, "check-bundle-budget.ts")],
      { encoding: "utf8", timeout: 10000 },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const startup of [true, false]) {
  test(`the full bundle gate rejects an entry import in a ${startup ? "startup" : "deferred"} worker`, () => {
    const result = runGate(startup, true);
    assert.equal(result.error, undefined);
    assert.match(result.stdout, /startup JavaScript:/, "the fixture must execute the actual gate");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /engine\.worker\.js.*debugController\.js/);
  });
}

test("the complete safe worker build passes the full gate", () => {
  const result = runGate(true, false);
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /startup JavaScript:/, "the fixture must execute the actual gate");
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  workerEntryImportBacks,
  workerStaticClosure,
  type GraphChunk,
} from "../scripts/check-bundle-budget.ts";
import { isStudioModule, isHomeDeferredModule } from "../scripts/deferred-modules.mjs";

test("editor code under the studio folders counts as lazy Studio code", () => {
  assert.equal(isStudioModule("src/vocabulary.ts"), false);
  assert.equal(isStudioModule("src/studio/editOperations.ts"), true);
  assert.equal(isStudioModule("app/src/studio/studioTerms.ts"), true);
});

test("Home excludes agent, debugger, editor, words analysis and sound preview code", () => {
  for (const module of [
    "app/src/authoring/AgentBubble.vue",
    "app/src/authoring/AgentLogPanel.vue",
    "app/src/authoring/AgentTaskControls.vue",
    "app/src/agent/agentRun.ts",
    "app/src/agent/agentLog.ts",
    "app/src/agent/authoringLoader.ts",
    "src/agent/agentState.ts",
    "src/agent/history.ts",
    "src/agent/roomPictures.ts",
    "src/agent/viewUsage.ts",
    "src/agent/worldPlan.ts",
    "src/agent/toolTransport.ts",
    "src/agent/gameTestFormat.ts",
    "app/src/engine/executionDebugLink.ts",
    "app/src/engine/useEngineDebug.ts",
    "app/src/project/playerSentences.ts",
    "app/src/authoring/SoundPreview.vue",
    "src/sound/preview.ts",
    "src/sound/sound.ts",
    "app/src/audio/AgiAudio.ts",
    "src/sound/document.ts",
    "app/src/settings/AiSettings.vue",
    "app/src/inspector/InspectPanel.vue",
    "src/studio/editOperations.ts",
    "app/src/studio/workspace/WordsEditor.vue",
    "src/runtime/engine.ts",
    "app/src/worker/engine.worker.ts",
    "app/src/references/referenceHandles.ts",
    "src/agent/roomTools.ts",
    "app/node_modules/openai/index.mjs",
    "app/node_modules/monaco-editor/editor.js",
    "app/src/studio/workspace/WordsEditor.vue?vue&type=script",
  ])
    assert.equal(isHomeDeferredModule(module), true, module);
  for (const module of [
    "app/src/home/LibraryPanel.vue",
    "app/src/engine/engineContext.ts",
    "src/logic/words.ts",
    "src/runtime/profile.ts",
  ])
    assert.equal(isHomeDeferredModule(module), false, module);
});

/**
 * The worker-budget measure: a startup worker's initial download is its
 * entry chunk plus every statically imported chunk — a lazy feature split
 * that makes the bundler hoist shared Engine/core into extra chunks must
 * still count them all. Compiled `imports` edges decide, not source syntax.
 */

function chunk(file: string, fields: Partial<Omit<GraphChunk, "file">> = {}): GraphChunk {
  return {
    file,
    isEntry: fields.isEntry ?? false,
    imports: fields.imports ?? [],
    dynamicImports: fields.dynamicImports ?? [],
    css: fields.css ?? [],
    modules: fields.modules ?? [],
  };
}

test("a worker's static import chain counts every chunk exactly once", () => {
  // entry -> shared -> nested: the shared core a debugger split hoists is
  // still fetched before the worker's first instruction.
  const chunks = [
    chunk("assets/engine.worker-AAA.js", {
      isEntry: true,
      imports: ["assets/shared-BBB.js"],
      dynamicImports: ["assets/debugController-CCC.js"],
    }),
    chunk("assets/shared-BBB.js", { imports: ["assets/core-DDD.js"] }),
    chunk("assets/core-DDD.js"),
    chunk("assets/debugController-CCC.js", {
      imports: ["assets/debugShared-EEE.js"],
    }),
    chunk("assets/debugShared-EEE.js"),
  ];
  assert.deepEqual(
    workerStaticClosure(chunks, "assets/engine.worker-AAA.js").map((c) => c.file),
    ["assets/engine.worker-AAA.js", "assets/shared-BBB.js", "assets/core-DDD.js"],
  );
});

test("a dynamic import stays outside the startup closure", () => {
  // The debugger chunk and its own static tail are action-triggered bytes.
  const chunks = [
    chunk("assets/engine.worker-AAA.js", {
      isEntry: true,
      dynamicImports: ["assets/debugController-CCC.js"],
    }),
    chunk("assets/debugController-CCC.js", {
      imports: ["assets/plans-DDD.js"],
    }),
    chunk("assets/plans-DDD.js"),
  ];
  assert.deepEqual(
    workerStaticClosure(chunks, "assets/engine.worker-AAA.js").map((c) => c.file),
    ["assets/engine.worker-AAA.js"],
  );
});

test("a chunk shared by two static paths is counted once", () => {
  const chunks = [
    chunk("assets/engine.worker-AAA.js", {
      isEntry: true,
      imports: ["assets/left-BBB.js", "assets/right-CCC.js"],
    }),
    chunk("assets/left-BBB.js", { imports: ["assets/core-DDD.js"] }),
    chunk("assets/right-CCC.js", { imports: ["assets/core-DDD.js"] }),
    chunk("assets/core-DDD.js"),
  ];
  assert.deepEqual(
    workerStaticClosure(chunks, "assets/engine.worker-AAA.js")
      .map((c) => c.file)
      .sort(),
    [
      "assets/core-DDD.js",
      "assets/engine.worker-AAA.js",
      "assets/left-BBB.js",
      "assets/right-CCC.js",
    ],
  );
});

test("a lazy chunk importing the worker entry back is flagged", () => {
  // The exact unsafe topology the WebKit production defect shipped: a
  // second evaluation of the entry's side effects steals the wire.
  const chunks = [
    chunk("assets/engine.worker-AAA.js", {
      isEntry: true,
      dynamicImports: ["assets/debugController-BBB.js"],
    }),
    chunk("assets/debugController-BBB.js", {
      imports: ["assets/engine.worker-AAA.js"],
    }),
  ];
  assert.deepEqual(workerEntryImportBacks(chunks), [
    { entry: "assets/engine.worker-AAA.js", importer: "assets/debugController-BBB.js" },
  ]);
});

test("an import-back through an intermediate chunk is flagged", () => {
  const chunks = [
    chunk("assets/engine.worker-AAA.js", {
      isEntry: true,
      imports: ["assets/worker-shared-BBB.js"],
    }),
    chunk("assets/worker-shared-BBB.js"),
    chunk("assets/debugController-CCC.js", { imports: ["assets/plans-DDD.js"] }),
    chunk("assets/plans-DDD.js", { imports: ["assets/engine.worker-AAA.js"] }),
  ];
  assert.deepEqual(workerEntryImportBacks(chunks), [
    { entry: "assets/engine.worker-AAA.js", importer: "assets/plans-DDD.js" },
  ]);
});

test("a lazy chunk importing only side-effect-free shared chunks is safe", () => {
  const chunks = [
    chunk("assets/engine.worker-AAA.js", {
      isEntry: true,
      imports: ["assets/worker-shared-BBB.js"],
    }),
    chunk("assets/worker-shared-BBB.js", {
      dynamicImports: ["assets/debugController-CCC.js"],
    }),
    chunk("assets/debugController-CCC.js", {
      imports: ["assets/worker-shared-BBB.js"],
    }),
  ];
  assert.deepEqual(workerEntryImportBacks(chunks), []);
});

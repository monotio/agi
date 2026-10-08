import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentTarget } from "../src/agent/agentNavigation.ts";
import { createWorkspaceEditor } from "../src/shell/workspaceEditor.ts";
import type { EngineApi } from "../src/engine/engineContext.ts";

test("agent navigation keeps result identity and refuses the wrong game or invalid resource", () => {
  const target = {
    projectId: "game-a",
    documentId: "revision-one",
    taskId: "turn-a",
    messageId: "answer-a",
    resource: "view:7",
    loop: 2,
    cel: 3,
  };
  assert.deepEqual(
    resolveAgentTarget(target, { projectId: "game-a", documentId: "revision-one" }),
    { kind: "current", target },
  );
  assert.deepEqual(
    resolveAgentTarget(target, { projectId: "game-a", documentId: "revision-two" }),
    { kind: "earlier", target },
  );
  assert.throws(
    () => resolveAgentTarget(target, { projectId: "game-b", documentId: "revision-one" }),
    /another game/,
  );
  assert.throws(
    () =>
      resolveAgentTarget(
        { ...target, resource: "view:256" },
        { projectId: "game-a", documentId: "revision-one" },
      ),
    /Invalid project document/,
  );
});

test("opening a current result selects the native editor and preserves line and conversation identity", async () => {
  let documentId = "revision-one";
  const session = { capture: () => ({ snapshot: { documentId } }) };
  const game = { projectId: "game-a" };
  const engine = {
    getProjectSession: () => session,
    getBootedGame: () => game,
  } as unknown as EngineApi;
  const editor = createWorkspaceEditor(engine);
  editor.open("picture:1");
  const target = {
    projectId: "game-a",
    documentId,
    taskId: "turn-a",
    messageId: "answer-a",
    resource: "logic:7",
    line: 12,
  };
  await editor.openAgentTarget(target);
  assert.equal(editor.selected.value, "logic:7");
  assert.equal(editor.nameLocation.value?.line, 12);
  assert.deepEqual(editor.agentTarget.value, target);
  documentId = "revision-two";
  await assert.rejects(
    () => editor.openAgentTarget({ ...target, resource: "picture:2" }),
    /earlier version/,
  );
  assert.equal(editor.selected.value, "logic:7");
});

test("opening a result cannot cross a game handoff while navigation loads", async () => {
  const session = { capture: () => ({ snapshot: { documentId: "revision-one" } }) };
  let game = { projectId: "game-a" };
  const engine = {
    getProjectSession: () => session,
    getBootedGame: () => game,
  } as unknown as EngineApi;
  const editor = createWorkspaceEditor(engine);
  editor.open("picture:1");
  const navigating = editor.openAgentTarget({
    projectId: "game-a",
    documentId: "revision-one",
    messageId: "answer-a",
    resource: "view:7",
    loop: 2,
    cel: 3,
  });
  game = { projectId: "game-a" };
  await assert.rejects(navigating, /game changed/);
  assert.equal(editor.selected.value, "picture:1");
  assert.equal(editor.agentTarget.value, undefined);
});

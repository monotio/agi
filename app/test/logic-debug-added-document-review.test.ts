import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { createDebugController } from "../src/worker/debugController.ts";
import { installDebugController } from "../src/worker/debugLoader.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import type { WorkerInbound, WorkerOutbound } from "../src/worker/workerProtocol.ts";
import type { TestWorkerLike } from "../src/studio/logic/debug/testSession.ts";
import { createStudioDraftSource } from "../src/studio/logic/debug/debugDraft.ts";
import { createDebugWorkspace } from "../src/studio/logic/debug/logicDebugWorkspace.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();

class EnginePort implements TestWorkerLike {
  onmessage: ((event: { data: WorkerOutbound }) => void) | null = null;
  private terminated = false;
  private readonly context = createWorkerContext({
    control: (data) => this.deliver(data),
    presentation: (data) => this.deliver(data),
    now: () => 0,
    seedWord: () => 42,
  });

  constructor() {
    installDebugController(this.context, createDebugController(this.context));
    this.context.host = createEngineHost(this.context);
  }

  private deliver(data: WorkerOutbound): void {
    if (!this.terminated) this.onmessage?.({ data });
  }

  postMessage(message: WorkerInbound): void {
    if (this.terminated) return;
    onWorkerMessage(this.context, message);
    this.context.fns.stopTimers();
  }

  terminate(): void {
    this.terminated = true;
    this.context.fns.stopTimers();
  }
}

test("adding a new source document marks the frozen Test build stale", async () => {
  const prepared = prepareLocalProject({ title: "Debug new source review", kind: "starter" });
  await prepared.save();
  const project = await openEditableProject(prepared.projectId);
  const workspace = createDebugWorkspace({
    draft: createStudioDraftSource(() => project),
    createWorker: () => new EnginePort(),
  });
  try {
    await workspace.test();
    assert.equal(workspace.state.stale, false);
    const before = project.draft.capture();
    assert.equal(before.read("logic:9"), undefined);
    project.draft.edit("logic:9", "// An independently editable new room.\nreturn;", 0);
    workspace.noteDraftChanged();
    assert.equal(
      workspace.state.stale,
      true,
      "the frozen complete build differs when the current draft gains a document",
    );
  } finally {
    workspace.dispose();
  }
});

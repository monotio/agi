import assert from "node:assert/strict";
import { test } from "node:test";
import { LogicAnalysisClient } from "../src/studio/logic/analysisClient.ts";
import { attachLogicLanguageServer } from "../src/studio/logic/analysisService.ts";
import type { LogicAnalysisProject } from "../src/studio/logic/analysisClient.ts";
import type { LspMessage, LspResponse, LspNotification } from "../../src/logic/lspTypes.ts";

class FakeWorker {
  onmessage: ((event: MessageEvent<LspResponse | LspNotification>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  requests: LspMessage[] = [];
  terminated = false;
  port = {
    onmessage: null as ((event: { data: LspMessage }) => void) | null,
    postMessage: (data: LspResponse | LspNotification) =>
      this.onmessage?.({ data } as MessageEvent<LspResponse | LspNotification>),
  };
  constructor() {
    attachLogicLanguageServer(this.port);
  }
  postMessage(request: LspMessage) {
    if (request.id === undefined || request.id === 0)
      this.port.onmessage!({ data: structuredClone(request) });
    else this.requests.push(structuredClone(request));
  }
  terminate() {
    this.terminated = true;
  }
  reply(index = 0) {
    this.port.onmessage!({ data: this.requests[index]! });
  }
}
function project(source = "set(door); return;", revision = 1): LogicAnalysisProject {
  return {
    revision,
    profileId: "2.936",
    words: [["open", 100]],
    bindings: { door: { num: 50 } },
    documents: { "logic:1": { version: revision, source } },
  };
}

test("analysis worker uses actual shared project semantics and proposes rename without mutation", async () => {
  const worker = new FakeWorker();
  const client = new LogicAnalysisClient(() => worker);
  client.setProject(project());
  const definition = client.request("logic:1", "textDocument/definition", {
    position: { line: 0, character: 4 },
  });
  worker.reply();
  assert.equal((await definition)?.uri, "agi-project:///bindings.json");
  const rename = client.request("logic:1", "textDocument/rename", {
    position: { line: 0, character: 4 },
    newName: "gate",
  });
  worker.reply(1);
  assert.equal((await rename)?.documentChanges.length, 2);
  const diagnostics = client.request("logic:1", "textDocument/diagnostic");
  worker.reply(2);
  assert.deepEqual((await diagnostics).items, []);
  client.dispose();
});

test("a new project snapshot rejects old requests even when text and version return to earlier values", async () => {
  const worker = new FakeWorker();
  const client = new LogicAnalysisClient(() => worker);
  client.setProject(project());
  const before = client.request("logic:1", "textDocument/hover", {
    position: { line: 0, character: 4 },
  });
  const rejected = assert.rejects(before, /superseded/);
  client.setProject(project("set(f1); return;", 2));
  await rejected;
  client.setProject(project());
  const current = client.request("logic:1", "textDocument/hover", {
    position: { line: 0, character: 4 },
  });
  worker.reply(0);
  worker.reply(1);
  assert.match((await current)?.contents.value ?? "", /#define door 50/);
  client.dispose();
});

test("cancellation, disposal and a dead worker settle promises and allow clean restart", async () => {
  const workers: FakeWorker[] = [];
  const client = new LogicAnalysisClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, 20);
  client.setProject(project());
  const controller = new AbortController();
  const cancelled = client.request("logic:1", "textDocument/diagnostic", {}, controller.signal);
  const cancelledCheck = assert.rejects(cancelled, /cancelled/);
  controller.abort();
  await cancelledCheck;
  const stalled = client.request("logic:1", "textDocument/diagnostic");
  await assert.rejects(stalled, /timed out/);
  assert.equal(workers[0]!.terminated, true);
  const restarted = client.request("logic:1", "textDocument/diagnostic");
  workers[1]!.reply();
  assert.deepEqual((await restarted).items, []);
  const pending = client.request("logic:1", "textDocument/diagnostic");
  const disposal = assert.rejects(pending, /closed/);
  client.dispose();
  await disposal;
  await assert.rejects(client.request("logic:1", "textDocument/diagnostic"), /closed/);
});

test("project snapshots own mutable inputs and worker failures never become successful results", async () => {
  const worker = new FakeWorker();
  const client = new LogicAnalysisClient(() => worker);
  const bindings = { door: { num: 50 } };
  client.setProject({ ...project(), bindings });
  bindings.door.num = 99;
  const hover = client.request("logic:1", "textDocument/hover", {
    position: { line: 0, character: 4 },
  });
  worker.reply();
  assert.match((await hover)?.contents.value ?? "", /#define door 50/);
  const pending = client.request("logic:1", "textDocument/diagnostic");
  const failed = assert.rejects(pending, /worker failed/);
  worker.onerror?.({} as ErrorEvent);
  await failed;
  assert.equal(worker.terminated, true);
  client.dispose();
});

test("opening a project stays lazy and invalid document keys cannot reach the worker", async () => {
  let created = 0;
  const client = new LogicAnalysisClient(() => {
    created++;
    return new FakeWorker();
  }, 20);
  client.setProject(project());
  assert.equal(created, 0);
  await assert.rejects(
    client.request("toString", "textDocument/diagnostic"),
    /No authored logic document/,
  );
  assert.equal(created, 0);
  client.dispose();
});

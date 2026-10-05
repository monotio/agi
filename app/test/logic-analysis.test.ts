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
  notifications: LspMessage[] = [];
  terminated = false;
  port = {
    onmessage: null as ((event: { data: LspMessage }) => void) | null,
    postMessage: (data: LspResponse | LspNotification) =>
      this.onmessage?.({ data } as MessageEvent<LspResponse | LspNotification>),
  };
  constructor() {
    attachLogicLanguageServer(this.port, { schedule: (run) => run() });
  }
  postMessage(request: LspMessage) {
    if (request.id === undefined) this.notifications.push(structuredClone(request));
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

test("an unchanged workspace notification preserves a pending definition", async () => {
  const worker = new FakeWorker();
  const client = new LogicAnalysisClient(() => worker);
  const snapshot = project("marker: return;\ngoto marker;");
  client.setProject(snapshot);
  const definition = client.request("logic:1", "textDocument/definition", {
    position: { line: 1, character: 6 },
  });
  client.setProject(structuredClone(snapshot));
  worker.reply();
  assert.deepEqual((await definition)?.range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 6 },
  });
  client.dispose();
});

test("a definition captured before an edit cannot move a newer document's caret", async () => {
  const worker = new FakeWorker();
  const client = new LogicAnalysisClient(() => worker);
  client.setProject(project("marker: return;\ngoto marker;"));
  const old = client.request("logic:1", "textDocument/definition", {
    position: { line: 1, character: 6 },
  });
  const deliver = worker.onmessage!;
  let reply: MessageEvent<LspResponse | LspNotification> | undefined;
  worker.onmessage = (event) => (reply = event);
  worker.reply();
  worker.onmessage = deliver;
  const rejected = assert.rejects(old, /superseded/);
  client.setProject(project("\nmarker: return;\ngoto marker;", 2));
  deliver(reply!);
  await rejected;
  const current = client.request("logic:1", "textDocument/definition", {
    position: { line: 2, character: 6 },
  });
  worker.reply(1);
  assert.equal((await current)?.range.start.line, 1);
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

test("typing sends only the edited document and keeps closed sources available", async () => {
  const worker = new FakeWorker();
  const client = new LogicAnalysisClient(() => worker);
  client.setProject({
    ...project(),
    documents: {
      ...project().documents,
      "logic:2": { version: 1, source: "reset(door); return;" },
    },
  });
  const initial = client.request("logic:1", "textDocument/diagnostic");
  worker.reply();
  await initial;
  worker.notifications.length = 0;
  client.changeDocument("logic:1", 2, "set(door); reset(door); return;");
  assert.deepEqual(
    worker.notifications.map((entry) => entry.method),
    ["textDocument/didChange"],
  );
  assert.deepEqual(worker.notifications[0]?.params, {
    textDocument: { uri: "agi-project:///logic.1.lgc", version: 2 },
    contentChanges: [{ text: "set(door); reset(door); return;" }],
  });
  const references = client.request("logic:1", "textDocument/references", {
    position: { line: 0, character: 5 },
  });
  worker.reply(1);
  assert.equal((await references)?.filter((entry) => entry.uri.endsWith("logic.2.lgc")).length, 1);
  client.dispose();
});

test("a request cancelled before its worker turn performs no analysis", () => {
  const queued: (() => void)[] = [];
  const replies: (LspResponse | LspNotification)[] = [];
  const port = {
    onmessage: null as ((event: { data: LspMessage }) => void) | null,
    postMessage: (reply: LspResponse | LspNotification) => replies.push(reply),
  };
  attachLogicLanguageServer(port, {
    schedule: (run) => {
      queued.push(run);
    },
  });
  port.onmessage!({
    data: {
      jsonrpc: "2.0",
      method: "workspace/didChangeConfiguration",
      params: { settings: { agiLogic: { project: project() } } },
    },
  });
  port.onmessage!({
    data: {
      jsonrpc: "2.0",
      id: 4,
      method: "agi/compile",
      params: { textDocument: { uri: "agi-project:///logic.1.lgc" } },
    },
  });
  port.onmessage!({ data: { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 4 } } });
  for (const run of queued) run();
  assert.deepEqual(replies, [
    { jsonrpc: "2.0", id: 4, error: { code: -32800, message: "Request cancelled." } },
  ]);
});

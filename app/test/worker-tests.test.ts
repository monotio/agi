import assert from "node:assert/strict";
import { test } from "node:test";
import { installTestsWorker } from "../src/studio/tests.worker.ts";
import {
  runTestsInWorker,
  type TestsWorkerOutbound,
  type TestsWorkerInbound,
} from "../src/studio/testsRunner.ts";
import { captureAgentWorkspace } from "../../src/authoring/projectAgentCandidate.ts";
import { ProjectDraft } from "../../src/authoring/projectDraft.ts";
import { runGameTests } from "../../src/agent/gameTestsRunner.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { ProjectModel } from "../../src/authoring/projectModel.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { readProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import type { ProjectSession } from "../src/project/projectSession.ts";

function input(): TestsWorkerInbound {
  const starter = createStarterProject("starter");
  const files = Object.fromEntries(starter.files());
  const documents = readProjectDocuments({ files, profileId: "2.936" }).documents;
  return {
    files,
    documents: {
      ...documents,
      tests: JSON.stringify({
        format: "monotio.agi.tests.v2",
        tests: [
          { name: "pass", room: 1, steps: [], expect: { room: 1 } },
          { name: "fail", room: 1, steps: [], expect: { room: 2 } },
        ],
      }),
      world: JSON.stringify({
        rooms: { "1": { title: "Home", description: "", exits: {} } },
        facts: {},
        quests: {},
      }),
    },
    profileId: "2.936",
    allowMissingRooms: false,
    names: null,
  };
}

test("the tests worker gives the Agent runner's verdicts on the same committed game", () => {
  const data = input();
  const direct = captureAgentWorkspace({
    draft: new ProjectDraft(data.documents),
    files: data.files,
    profileId: data.profileId,
  }).openToolState();
  const expected = runGameTests(direct.state, null);
  let answer: TestsWorkerOutbound | undefined;
  const port = {
    onmessage: null as ((event: MessageEvent<TestsWorkerInbound>) => void) | null,
    postMessage(message: TestsWorkerOutbound) {
      answer = message;
    },
  };
  installTestsWorker(port);
  port.onmessage!({ data } as MessageEvent<TestsWorkerInbound>);
  assert.deepEqual(answer, { result: expected });
  assert.equal(expected.success, false);
  const outcomes = expected.details!["gameTests"] as { passed: boolean }[];
  assert.deepEqual(
    outcomes.map((test) => test.passed),
    [true, false],
  );
  port.onmessage!({ data } as MessageEvent<TestsWorkerInbound>);
  assert.deepEqual(answer, { result: expected }, "every run starts with fresh evidence");
});

function fakeWorker() {
  let terminated = 0;
  let posted: TestsWorkerInbound | undefined;
  const worker = {
    onmessage: null as Worker["onmessage"],
    onerror: null as Worker["onerror"],
    postMessage(message: TestsWorkerInbound) {
      posted = message;
    },
    terminate() {
      terminated++;
    },
  };
  return {
    worker: worker as unknown as Worker,
    get terminated() {
      return terminated;
    },
    get posted() {
      return posted;
    },
  };
}
function session(): ProjectSession {
  const data = input();
  const build = compileProjectDocuments({
    files: data.files,
    documents: data.documents,
    profileId: data.profileId,
  });
  return {
    model: new ProjectModel({ documents: data.documents, build, digest: sha256Hex }),
    allowMissingRooms: false,
  } as ProjectSession;
}

test("Stop terminates the tests worker and leaves the committed game untouched", async () => {
  const project = session();
  const before = project.model.capture().documentId;
  const fake = fakeWorker();
  const stop = new AbortController();
  const result = runTestsInWorker(project, {
    signal: stop.signal,
    createWorker: () => fake.worker,
  });
  assert.ok(fake.posted);
  stop.abort();
  await assert.rejects(result, /Tests stopped/);
  assert.equal(fake.terminated, 1);
  assert.equal(project.model.capture().documentId, before);
});

test("a tests worker that never answers is terminated at its deadline", async () => {
  const fake = fakeWorker();
  const result = runTestsInWorker(session(), { deadlineMs: 1, createWorker: () => fake.worker });
  await assert.rejects(result, /took too long/);
  assert.equal(fake.terminated, 1);
});

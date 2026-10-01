import type { PreviewUpdateOutcome } from "../src/worker/workerProtocol.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openProjectSession } from "../src/project/projectSession.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer } from "../../src/container/container.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";

test("session admits before saving, keeps invalid source and restores History on reopen", async () => {
  const documents = { "logic:0": "return;" };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const data = {
    projectId: requireProjectId("session-test"),
    title: "Test",
    authoredAt: "",
    files: Object.fromEntries(compiled.files()),
    words: [] as [string, number][],
    workspace: writeProjectWorkspace(documents),
  };
  const order: string[] = [];
  let stored: CachedGameData = data;
  const session = openProjectSession({
    data,
    lifetime: "initial",
    admission: {
      runToken: "test-run",
      admit: async () => {
        order.push("admit");
        return { status: "committed", expected: null, current: null, patchGeneration: 1 };
      },
    },
    write: async (request) => {
      order.push("save");
      stored = {
        ...request.data,
        projectId: data.projectId,
        authoredAt: "",
        generation: (request.expected?.generation ?? 0) + 1,
      };
      return {
        commitId: request.commitId,
        workspaceId: request.workspaceId,
        candidateHash: "a",
        documents: request.documents,
        saved: { ...request.expected!, generation: stored.generation!, buildId: request.buildId },
      };
    },
  });
  const proposal = session.model.propose(session.model.capture(), "Message", [
    { key: "logic:0", content: 'print("Changed"); return;' },
  ]);
  assert.equal(
    (await session.submit({ proposal, origin: "logic", label: "Message", author: "creator" }))
      .status,
    "committed",
  );
  await session.flush();
  assert.deepEqual(order, ["admit", "save"]);
  const good = session.model.capture().lastAdmissibleBuild!.identity.revision;
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Typing", [
      { key: "logic:0", content: "if (" },
    ]),
    origin: "logic",
    label: "Typing",
    author: "creator",
  });
  await session.flush();
  assert.equal(session.model.capture().lastAdmissibleBuild!.identity.revision, good);
  session.dispose();
  const reopened = openProjectSession({
    data: stored,
    lifetime: "initial",
    admission: {
      runToken: "next-run",
      admit: async () => {
        throw new Error("unused");
      },
    },
  });
  assert.equal(reopened.model.capture().read("logic:0")!.content, "if (");
  assert.equal(reopened.history.capture().commits.length, 3);
  reopened.dispose();
});

test("a late admission after disposal leaves the old model and storage untouched", async () => {
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "return;" },
    profileId: "2.936",
  });
  let release: ((outcome: PreviewUpdateOutcome) => void) | undefined;
  let saved = 0;
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("late-session"),
      title: "Late",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
    },
    lifetime: "initial",
    admission: {
      runToken: "old-run",
      admit: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    write: async () => {
      saved++;
      throw new Error("unused");
    },
  });
  const before = session.model.capture();
  const edit = session.submit({
    proposal: session.model.propose(before, "Edit", [
      { key: "logic:0", content: "// changed\nreturn;" },
    ]),
    origin: "logic",
    label: "Edit",
    author: "creator",
  });
  await Promise.resolve();
  session.dispose();
  release!({ status: "committed", expected: null, current: null, patchGeneration: 1 });
  await assert.rejects(edit, /superseded/);
  assert.equal(session.model.capture().documentId, before.documentId);
  assert.equal(saved, 0);
});

test("deferred admission publishes documents then retries at a supplied natural boundary", async () => {
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "return;" },
    profileId: "2.936",
  });
  const order: string[] = [];
  let attempts = 0;
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("deferred-session"),
      title: "Deferred",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
    },
    lifetime: "initial",
    admission: {
      runToken: "deferred-run",
      admit: async () => {
        order.push("admit");
        return {
          status: ++attempts === 1 ? "deferred" : "committed",
          expected: null,
          current: null,
          patchGeneration: 1,
        };
      },
    },
    boundary: async () => {
      order.push("boundary");
    },
    publish: () => {
      order.push("publish");
    },
  });
  const result = await session.submit({
    proposal: session.model.propose(session.model.capture(), "Edit", [
      { key: "logic:0", content: "// changed\nreturn;" },
    ]),
    origin: "logic",
    label: "Edit",
    author: "creator",
  });
  assert.equal(result.status, "committed");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["admit", "publish", "boundary", "admit", "publish"]);
  session.dispose();
});

test("borrowed editors observe the same owned documents and diagnostics", async () => {
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "return;" },
    profileId: "2.936",
  });
  const input = {
    data: {
      projectId: requireProjectId("borrow-session"),
      title: "Borrow",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [] as [string, number][],
    },
    lifetime: "initial",
    admission: {
      runToken: "borrow-run",
      admit: async () => {
        throw new Error("Invalid typing uses the last build");
      },
    },
  };
  const session = openProjectSession(input);
  assert.equal(openProjectSession(input), session);
  let observations = 0;
  const unsubscribe = session.subscribe(() => {
    observations++;
  });
  const proposal = session.model.propose(session.model.capture(), "Typing", [
    { key: "logic:0", content: "if (" },
  ]);
  await session.submit({ proposal, origin: "logic", label: "Typing", author: "creator" });
  assert.ok(observations > 0);
  assert.equal(session.capture().snapshot.read("logic:0")!.content, "if (");
  assert.ok(session.capture().diagnostics.some((finding) => finding.code === "compile"));
  unsubscribe();
  session.dispose();
});

test("opening source errors before the first History commit preserves typed work", () => {
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "return;" },
    profileId: "2.936",
  });
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("initial-source-errors"),
      title: "Typing",
      authoredAt: "",
      words: [],
      files: Object.fromEntries(compiled.files()),
      workspace: writeProjectWorkspace({ "logic:0": "if (" }),
    },
    lifetime: "initial",
    admission: {
      runToken: "initial-source-run",
      admit: async () => {
        throw new Error("unused");
      },
    },
  });
  assert.equal(session.model.capture().read("logic:0")!.content, "if (");
  assert.equal(
    session.model.capture().lastAdmissibleBuild!.identity.revision,
    compiled.build.identity.revision,
  );
  assert.ok(session.capture().diagnostics.some((finding) => finding.code === "compile"));
  session.dispose();
});

test("deferred Undo, Redo, Restore and typing publish immediately and admit only the latest image", async () => {
  const documents = { "logic:0": "return;" };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  let waiting = false;
  let release: (() => void) | undefined;
  const admitted: string[] = [];
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("instant-history"),
      title: "Instant",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(documents),
    },
    lifetime: "initial",
    admission: {
      runToken: "instant-run",
      admit: async (image) => {
        if (!waiting) admitted.push(image.documents()["logic:0"] as string);
        return {
          status: waiting ? "deferred" : "committed",
          expected: null,
          current: null,
          patchGeneration: 1,
        };
      },
    },
    boundary: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  try {
    const opened = session.history.capture().cursor!;
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "Edit", [
        { key: "logic:0", content: 'print("Changed"); return;' },
      ]),
      origin: "logic",
      label: "Edit",
      author: "creator",
    });
    const changed = session.history.capture().cursor!;
    waiting = true;
    const undo = session.undo();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      session.model.capture().read("logic:0")!.content,
      "return;",
      "Undo changes the document while MAIN waits",
    );
    await undo;
    assert.equal(session.history.capture().cursor, opened);
    assert.equal(session.capture().pendingAdmission, true);
    await session.redo();
    assert.equal(session.history.capture().cursor, changed);
    await session.restore(opened);
    assert.equal(session.model.capture().read("logic:0")!.content, "return;");
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "Typing", [
        { key: "logic:0", content: 'print("Latest"); return;' },
      ]),
      origin: "logic",
      label: "Typing",
      author: "creator",
    });
    assert.equal(session.model.capture().read("logic:0")!.content, 'print("Latest"); return;');
    waiting = false;
    release!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(admitted, ['print("Changed"); return;', 'print("Latest"); return;']);
    assert.equal(session.capture().pendingAdmission, false);
  } finally {
    session.dispose();
  }
});

test("invalid typing retains the latest waiting runnable image and saves exact documents", async () => {
  const documents = { "logic:0": "return;" };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  let waiting = true;
  let release: (() => void) | undefined;
  let admitted = "";
  let saved = "";
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("waiting-typing"),
      title: "Typing",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(documents),
    },
    lifetime: "initial",
    admission: {
      runToken: "typing-run",
      admit: async (image) => {
        if (!waiting) admitted = image.documents()["logic:0"] as string;
        return {
          status: waiting ? "deferred" : "committed",
          expected: null,
          current: null,
          patchGeneration: 1,
        };
      },
    },
    boundary: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    write: async (request) => {
      saved = JSON.stringify(request.data.workspace);
      return {
        commitId: request.commitId,
        workspaceId: request.workspaceId,
        candidateHash: "a",
        documents: request.documents,
        saved: {
          ...request.expected!,
          generation: request.expected!.generation + 1,
          buildId: request.buildId,
        },
      };
    },
  });
  try {
    for (const content of ['print("Ready"); return;', "if ("]) {
      await session.submit({
        proposal: session.model.propose(session.model.capture(), "Typing", [
          { key: "logic:0", content },
        ]),
        origin: "logic",
        label: "Typing",
        author: "creator",
      });
    }
    await session.flush();
    assert.match(saved, /if \(/);
    assert.equal(session.capture().pendingAdmission, true);
    waiting = false;
    release!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(admitted, 'print("Ready"); return;');
    assert.equal(session.model.capture().read("logic:0")!.content, "if (");
  } finally {
    session.dispose();
  }
});

import { installWebLocksFixture } from "./webLocksFixture.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import type { PreviewUpdateOutcome } from "../src/worker/workerProtocol.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { authoringFingerprint } from "../src/project/gameStorage.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer } from "../../src/container/container.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";

installWebLocksFixture();
installIndexedDbFixture();

test("an Undo removal respects unselected drafts before offering a computed jump review", async () => {
  const documents = {
    "logic:0": "return;",
    "logic:99": 'get.num("Room",v20);new.room.v(v20);return;',
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("room-undo-review"),
      title: "Room review",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(documents),
    },
    lifetime: "initial",
    admission: {
      runToken: "review-run",
      admit: async () => ({
        status: "committed",
        expected: null,
        current: null,
        patchGeneration: 1,
      }),
    },
  });
  try {
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "Room", [
        { key: "logic:254", content: "return;" },
      ]),
      origin: "logic",
      label: "Room",
      author: "creator",
    });
    const before = session.model.capture();
    const cursor = session.history.capture().cursor;
    const drafts = session.drafts();
    await drafts.ready;
    drafts.stage([{ key: "logic:99", content: "new.room(254);return;" }]);
    const refused = await session.undo(undefined, "game");
    assert.equal(refused?.status, "diagnostics");
    assert.equal(session.model.capture().documentId, before.documentId);
    assert.equal(session.history.capture().cursor, cursor);
    await drafts.clear();
    const warning = await session.undo();
    assert.equal(warning?.status, "reviewRequired");
    if (warning?.status !== "reviewRequired") throw new Error("Expected review");
    assert.equal(session.model.capture().documentId, before.documentId);
    assert.match(warning.review.messages[0]!, /Room 254.*LOGIC 99.*debug teleport/);
    assert.equal((await session.undo(warning.review))?.status, "committed");
    assert.equal(session.model.capture().read("logic:254"), undefined);
    await session.redo();
    assert.ok(session.model.capture().read("logic:254"));
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "Changed entry", [
        { key: "logic:0", content: "// A later change\nreturn;" },
      ]),
      origin: "logic",
      label: "Changed entry",
      author: "creator",
    });
    await assert.rejects(session.undo(warning.review), /This Undo changed/);
  } finally {
    session.dispose();
  }
});

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
  let entered!: () => void;
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
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
          entered();
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
  assert.equal(session.saveStatus().state, "pending", "queued admission is unsaved work");
  await admitted;
  assert.equal(session.saveStatus().state, "pending", "blocked admission cannot report Saved");
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

test("a deferred prepared room retries its native image adoption", async () => {
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "return;" },
    profileId: "2.936",
  });
  let attempts = 0;
  let committed = false;
  let installedDuringWait = false;
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("prepared-room-retry"),
      title: "Room",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
    },
    lifetime: "initial",
    admission: {
      runToken: "prepared-room-run",
      admit: async () => {
        throw new Error("A room adoption keeps its reconciliation path");
      },
      admitPreparedRoom: async () => ({
        status: ++attempts === 1 ? "deferred" : "committed",
        expected: null,
        current: null,
        patchGeneration: 1,
      }),
    },
    boundary: async () => {},
    publish: (_snapshot, _data, outcome, nativeInstalled) => {
      committed ||= outcome?.status === "committed";
      installedDuringWait ||= outcome?.status === "deferred" && nativeInstalled === true;
    },
  });
  try {
    await session.submitPreparedRoom({
      proposal: session.model.propose(session.model.capture(), "Room", [
        { key: "logic:0", content: "// room\nreturn;" },
      ]),
      origin: "agent",
      label: "Room",
      author: "agent",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(installedDuringWait, true);
    assert.equal(attempts, 2);
    assert.equal(committed, true);
    assert.equal(session.capture().pendingAdmission, false);
  } finally {
    session.dispose();
  }
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

for (const source of ["catalog", "folder"] as const)
  test(`${source} edits save to a remix and later writes keep that owner`, async () => {
    const documents = { "logic:0": "return;" };
    const compiled = compileProjectDocuments({
      files: Object.fromEntries(createContainer().files),
      documents,
      profileId: "2.936",
    });
    const original = requireProjectId(`${source}-proof`);
    const requests: { projectId: string; expected: unknown }[] = [];
    const session = openProjectSession({
      data: {
        projectId: original,
        title: "Catalog",
        authoredAt: "",
        files: Object.fromEntries(compiled.files()),
        words: [],
        workspace: writeProjectWorkspace(documents),
        library: {
          version: 1,
          source,
          revision: compiled.build.identity.revision,
          ...(source === "catalog" ? { catalog: { id: "proof", version: "1" } } : {}),
          validation: { status: "ready", message: "Ready" },
        },
      },
      ...(source === "folder"
        ? { forkParent: { project: original, revision: compiled.build.identity.revision } }
        : {}),
      lifetime: "original",
      admission: {
        runToken: "catalog-run",
        admit: async () => ({
          status: "committed",
          expected: null,
          current: null,
          patchGeneration: 1,
        }),
      },
      write: async (request) => {
        requests.push({ projectId: request.projectId, expected: request.expected });
        assert.notEqual(request.projectId, original);
        assert.equal(request.data.library?.source, "remix");
        assert.equal(request.data.library?.parent?.project, original);
        assert.equal(request.data.library?.catalog, undefined);
        return {
          commitId: request.commitId,
          workspaceId: request.workspaceId,
          candidateHash: "a",
          documents: request.documents,
          saved: {
            projectId: request.projectId,
            lifetime: "remix-owner",
            generation: requests.length,
            revision: compiled.build.identity.revision,
            authoring: authoringFingerprint(undefined, request.data.workspace),
            buildId: request.buildId,
          },
        };
      },
    });
    for (const comment of ["first", "second"]) {
      await session.submit({
        proposal: session.model.propose(session.model.capture(), "Edit", [
          { key: "logic:0", content: `// ${comment}\nreturn;` },
        ]),
        origin: "logic",
        label: "Edit",
        author: "creator",
      });
      await session.flush();
      assert.equal(session.saveStatus().state, "saved");
    }
    assert.equal(requests[0]!.expected, null);
    assert.equal(requests[1]!.projectId, requests[0]!.projectId);
    assert.equal(session.lifetime, "remix-owner");
    session.dispose();
  });

test("a catalog save can create its remix while the next edit awaits admission", async () => {
  const documents = { "logic:0": "return;" };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const original = requireProjectId("catalog-overlap");
  let releaseSave!: () => void;
  let saving!: () => void;
  let releaseAdmission!: () => void;
  let admitting!: () => void;
  const saveEntered = new Promise<void>((resolve) => {
    saving = resolve;
  });
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  const admissionEntered = new Promise<void>((resolve) => {
    admitting = resolve;
  });
  const admissionGate = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  let admissions = 0;
  const savedOwners: string[] = [];
  const session = openProjectSession({
    data: {
      projectId: original,
      title: "Catalog",
      authoredAt: "",
      generation: 7,
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(documents),
      library: {
        version: 1,
        source: "catalog",
        revision: compiled.build.identity.revision,
        catalog: { id: "proof", version: "1" },
        validation: { status: "ready", message: "Ready" },
      },
    },
    lifetime: "initial",
    admission: {
      runToken: "overlap-run",
      async admit() {
        if (++admissions === 2) {
          admitting();
          await admissionGate;
        }
        return { status: "committed", expected: null, current: null, patchGeneration: admissions };
      },
    },
    async write(request) {
      savedOwners.push(request.projectId);
      if (savedOwners.length === 1) {
        saving();
        await saveGate;
      }
      return {
        commitId: request.commitId,
        workspaceId: request.workspaceId,
        candidateHash: "a",
        documents: request.documents,
        saved: {
          projectId: request.projectId,
          lifetime: "remix-owner",
          generation: savedOwners.length,
          revision: compiled.build.identity.revision,
          authoring: authoringFingerprint(undefined, request.data.workspace),
          buildId: request.buildId,
        },
      };
    },
  });
  const edit = (content: string) =>
    session.submit({
      proposal: session.model.propose(session.model.capture(), "Edit", [
        { key: "logic:0", content },
      ]),
      origin: "logic",
      label: "Edit",
      author: "creator",
    });
  await edit("// first\nreturn;");
  const flushing = session.flush();
  await saveEntered;
  const second = edit("// second\nreturn;");
  await admissionEntered;
  releaseSave();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(session.lifetime, "remix-owner");
  releaseAdmission();
  assert.equal((await second).status, "committed");
  await flushing;
  assert.equal(session.model.capture().read("logic:0")!.content, "// second\nreturn;");
  assert.equal(savedOwners.length, 2);
  assert.notEqual(savedOwners[0], original);
  assert.equal(savedOwners[1], savedOwners[0]);
  session.dispose();
});

test("refused owned saves retain the admitted world and make Flush and Retry fail", async () => {
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "return;" },
    profileId: "2.936",
  });
  let world: unknown;
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("world-continuation"),
      title: "World",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
    },
    lifetime: "initial",
    admission: {
      runToken: "world-run",
      admit: async () => ({
        status: "unchanged",
        expected: null,
        current: null,
        patchGeneration: 0,
      }),
    },
    write: async (request) => {
      world = request.data.authoringState?.["authoring"];
      throw new Error("Capture only");
    },
  });
  try {
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "Plan", [
        {
          key: "world",
          content: JSON.stringify({
            rooms: { "2": { title: "Gallery", description: "Portraits", exits: {} } },
            facts: {},
            quests: {},
          }),
        },
      ]),
      label: "Plan",
      origin: "agent",
      author: "creator",
    });
    await assert.rejects(session.flush(), /Could not save/);
    await assert.rejects(session.retry(), /Could not save/);
    assert.equal(
      (world as { world: { rooms: Record<string, { title: string }> } })?.world?.rooms["2"]?.title,
      "Gallery",
    );
  } finally {
    session.dispose();
  }
});

test("flush follows an edit queued while its storage write is in flight", async () => {
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "return;" },
    profileId: "2.936",
  });
  let releaseWrite!: () => void;
  let releaseAdmission!: () => void;
  let admissions = 0;
  const writes: string[] = [];
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("flush-queued-edit"),
      title: "Flush",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace({ "logic:0": "return;" }),
    },
    lifetime: "flush-queued",
    admission: {
      runToken: "flush-run",
      admit: async () => {
        if (++admissions === 2)
          await new Promise<void>((resolve) => {
            releaseAdmission = resolve;
          });
        return { status: "committed", expected: null, current: null, patchGeneration: admissions };
      },
    },
    write: async (request) => {
      writes.push(request.commitId);
      if (writes.length === 1)
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
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
  const edit = (content: string) =>
    session.submit({
      proposal: session.model.propose(session.model.capture(), "Edit", [
        { key: "logic:0", content },
      ]),
      label: "Edit",
      origin: "logic",
      author: "creator",
    });
  await edit('print("First"); return;');
  let flushed = false;
  const flushing = session.flush().then(() => {
    flushed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = edit('print("Second"); return;');
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseWrite();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(flushed, false, "the admitted edit is still waiting to publish its capture");
  releaseAdmission();
  await second;
  await flushing;
  assert.equal(writes.length, 2);
  assert.equal(session.saveStatus().state, "saved");
  session.dispose();
});

test("saved source stays saved while a deferred preview admission awaits the worker", async () => {
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "return;" },
    profileId: "2.936",
  });
  let releaseBoundary!: () => void;
  let releaseAdmission!: () => void;
  let entered!: () => void;
  const admissionEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let admissions = 0;
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("saved-preview"),
      title: "Saved preview",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace({ "logic:0": "return;" }),
    },
    lifetime: "saved-preview",
    admission: {
      runToken: "preview-run",
      admit: async () => {
        if (++admissions === 1)
          return { status: "deferred", expected: null, current: null, patchGeneration: 0 };
        entered();
        await new Promise<void>((resolve) => {
          releaseAdmission = resolve;
        });
        return { status: "committed", expected: null, current: null, patchGeneration: 1 };
      },
    },
    boundary: () =>
      new Promise<void>((resolve) => {
        releaseBoundary = resolve;
      }),
    write: async (request) => ({
      commitId: request.commitId,
      workspaceId: request.workspaceId,
      candidateHash: "a",
      documents: request.documents,
      saved: {
        ...request.expected!,
        generation: request.expected!.generation + 1,
        buildId: request.buildId,
      },
    }),
  });
  try {
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "Edit", [
        { key: "logic:0", content: 'print("Saved"); return;' },
      ]),
      label: "Edit",
      origin: "logic",
      author: "creator",
    });
    await session.flush();
    releaseBoundary();
    await admissionEntered;
    assert.equal(session.capture().pendingAdmission, true);
    assert.equal(session.saveStatus().state, "saved");
    // Saving documents does not wait for a player to close the parked window.
    await session.flush();
  } finally {
    session.dispose();
    releaseAdmission();
  }
});

for (const state of ["clean", "pending", "failed", "stale", "removed", "closed"] as const) {
  test(`save model: ${state} controls edits, names and flush`, async () => {
    const compiled = compileProjectDocuments({
      files: Object.fromEntries(createContainer().files),
      documents: { "logic:0": "return;" },
      profileId: "2.936",
    });
    let current = true;
    let reject = state === "failed";
    let writes = 0;
    const session = openProjectSession({
      data: {
        projectId: requireProjectId(`model-${state}`),
        title: "Model",
        authoredAt: "",
        files: Object.fromEntries(compiled.files()),
        words: [],
      },
      lifetime: "model",
      current: () => current,
      admission: {
        runToken: `model-${state}`,
        admit: async () => ({
          status: "committed",
          expected: null,
          current: null,
          patchGeneration: 1,
        }),
      },
      write: async (request) => {
        writes++;
        if (reject) throw new Error("Storage rejected write");
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
      if (state === "pending" || state === "failed") {
        await session.tag("Version");
        if (state === "failed") await assert.rejects(session.flush());
      }
      if (state === "stale" || state === "removed") {
        current = state === "stale";
        session.stopWrites(state);
      }
      if (state === "closed") session.dispose();
      const edit = () =>
        session.submit({
          proposal: session.model.propose(session.model.capture(), "WORDS", [
            { key: "notes", content: "Coordinated edit" },
            { key: "words", content: "[]" },
          ]),
          label: "WORDS",
          origin: "words",
          author: "creator",
        });
      if (["stale", "removed", "closed"].includes(state)) {
        const before = session.model.capture().documentId;
        await assert.rejects(edit());
        assert.equal(session.model.capture().documentId, before);
        await assert.rejects(session.tag("Refused"));
        await assert.rejects(session.flush());
        assert.equal(writes, 0);
      } else {
        assert.equal((await edit()).status, "committed");
        reject = false;
        await session.retry();
        assert.equal(session.saveStatus().state, "saved");
      }
    } finally {
      session.dispose();
    }
  });
}

test("becoming stale during admission refuses publication", async () => {
  let finish!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("stale-during-admission"),
      title: "Stale",
      authoredAt: "",
      files: Object.fromEntries(createContainer().files),
      words: [],
    },
    lifetime: "stale",
    admission: {
      runToken: "stale",
      async admit() {
        entered();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { status: "committed", expected: null, current: null, patchGeneration: 1 };
      },
    },
    write: async () => {
      throw new Error("Stale project must not write");
    },
  });
  try {
    const before = session.model.capture();
    const changes = [{ key: "logic:0", content: "return;" }];
    const editing = session.submit({
      proposal: session.model.propose(before, "Changed", changes),
      label: "Changed",
      origin: "logic",
      author: "creator",
    });
    await waiting;
    session.stopWrites("stale");
    finish();
    await assert.rejects(editing, /superseded/);
    assert.equal(session.model.capture().documentId, before.documentId);
  } finally {
    session.dispose();
    finish?.();
  }
});

test("a deferred admission publishes MAIN without queuing a second source save", async () => {
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "return;" },
    profileId: "2.936",
  });
  let release!: () => void;
  let admissions = 0;
  let writes = 0;
  let published = 0;
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("deferred-save-once"),
      title: "Once",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
    },
    lifetime: "once",
    admission: {
      runToken: "once",
      admit: async () => ({
        status: ++admissions === 1 ? "deferred" : "committed",
        expected: null,
        current: null,
        patchGeneration: 1,
      }),
    },
    boundary: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    publish: () => {
      published++;
    },
    write: async (request) => {
      writes++;
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
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "Changed", [
        { key: "logic:0", content: 'print("Changed"); return;' },
      ]),
      label: "Changed",
      origin: "logic",
      author: "creator",
    });
    await session.flush();
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(published, 2);
    assert.equal(session.saveStatus().state, "saved");
    await session.flush();
    assert.equal(writes, 1);
  } finally {
    session.dispose();
  }
});

test("checkpoint preparation returns not ready during an outstanding document write", async () => {
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "return;" },
    profileId: "2.936",
  });
  let entered!: () => void;
  let release!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("checkpoint-write"),
      title: "Checkpoint",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
    },
    lifetime: "initial",
    admission: {
      runToken: "write",
      admit: async () => ({
        status: "committed",
        expected: null,
        current: null,
        patchGeneration: 1,
      }),
    },
    write: async (request) => {
      entered();
      await held;
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
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "Note", [
        { key: "notes", content: "Writing" },
      ]),
      label: "Note",
      origin: "logic",
      author: "creator",
    });
    const saving = session.flush();
    await writing;
    let result: unknown;
    void session.prepareCheckpoint().then((outcome) => {
      result = outcome;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result, "not_ready");
    release();
    await saving;
    assert.equal(await session.prepareCheckpoint(), "ready");
  } finally {
    release();
    session.dispose();
  }
});

test("checkpoint preparation returns not ready before a future admission boundary", async () => {
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "return;" },
    profileId: "2.936",
  });
  let boundary!: () => void;
  let finish!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let admissions = 0;
  let running = false;
  let captures = 0;
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("checkpoint-admission"),
      title: "Checkpoint",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
    },
    lifetime: "checkpoint",
    admission: {
      runToken: "checkpoint",
      async admit() {
        if (++admissions === 1)
          return { status: "deferred", expected: null, current: null, patchGeneration: 0 };
        entered();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { status: "committed", expected: null, current: null, patchGeneration: 1 };
      },
    },
    boundary: () =>
      new Promise<void>((resolve) => {
        boundary = resolve;
      }),
    checkpointReady() {
      captures++;
    },
    publish: (_snapshot, _data, outcome) => {
      running = outcome?.status === "committed";
    },
    write: async (request) => ({
      commitId: request.commitId,
      workspaceId: request.workspaceId,
      candidateHash: "a",
      documents: request.documents,
      saved: {
        ...request.expected!,
        generation: request.expected!.generation + 1,
        buildId: request.buildId,
      },
    }),
  });
  try {
    const older = session.model.capture().lastAdmissibleBuild!.identity.revision;
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "Changed", [
        { key: "logic:0", content: 'print("Changed"); return;' },
      ]),
      label: "Changed",
      origin: "logic",
      author: "creator",
    });
    await session.flush();
    const stored = session.model.capture().lastAdmissibleBuild!.identity.revision;
    assert.notEqual(stored, older);
    // The worker still runs the older bytes: their checkpoint cannot be
    // published over the newer stored project while admission waits.
    assert.equal(await session.prepareCheckpoint(older), "not_ready");
    let result: unknown;
    void session.prepareCheckpoint().then((outcome) => {
      result = outcome;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result, "not_ready");
    boundary();
    await waiting;
    assert.equal(result, "not_ready");
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await session.prepareCheckpoint(), "ready");
    assert.equal(running, true);
    assert.equal(captures, 1, "completed admission requests a fresh capture");
  } finally {
    session.dispose();
    finish?.();
  }
});

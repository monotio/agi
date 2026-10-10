import { installWebLocksFixture } from "./webLocksFixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../../src/container/container.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import {
  commitProject,
  authoringFingerprint,
  loadAuthoredGame,
  loadAuthoredGameWithHistoryLifetime,
  saveAuthoredGame,
} from "../src/project/gameStorage.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import {
  captureProjectJournal,
  decodeJournalValue,
  type ProjectJournalCapture,
} from "../src/project/projectJournalCapture.ts";
import { rebuildProjectJournal } from "../src/project/projectSessionCore.ts";
import { writeProjectSaveJournal } from "../src/project/projectSaveJournal.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import type { ProjectCommitRequest } from "../src/project/gameStorage.ts";
import { testProjectId } from "./identity.ts";
import { roomReference } from "../src/references/referenceArt.ts";

installIndexedDbFixture();
installWebLocksFixture();
let baseData: CachedGameData;
let published: ProjectCommitRequest["data"];
const values = new Map<string, string>();
const storage = {
  get length() {
    return values.size;
  },
  key: (index: number) => [...values.keys()][index] ?? null,
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
} as Storage;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
const frames = new Map<number, FrameRequestCallback>();
let frame = 0;
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    frames.set(++frame, callback);
    return frame;
  },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: (id: number) => frames.delete(id),
});
function journals() {
  return [...values.entries()].filter(([key]) => key.startsWith("monotio_agi.project-writes."));
}
function paint() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}
async function session(name: string, aliases = false, preview = false, catalog = false) {
  values.clear();
  frames.clear();
  const documents = {
    "logic:0": "return;",
    "picture:1": Uint8Array.of(255),
    notes: "UNEDITED_SENTINEL",
    ...(aliases ? { "logic:1": "return;" } : {}),
  };
  const image = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const files = Object.fromEntries(image.files());
  if (aliases) files["LOGDIR"]!.set(files["LOGDIR"]!.slice(0, 3), 3);
  const projectId = testProjectId(name);
  await commitProject({
    projectId,
    workspaceId: "initial",
    commitId: "initial",
    expected: null,
    buildId: image.build.identity.buildId,
    documents: [],
    data: {
      title: name,
      ...(catalog
        ? {
            library: {
              version: 1 as const,
              revision: image.build.identity.revision,
              source: "catalog" as const,
              validation: { status: "ready" as const, message: "Ready" },
              catalog: { id: "example", version: "1" },
            },
          }
        : {}),
      ...(preview
        ? {
            library: {
              version: 1 as const,
              revision: image.build.identity.revision,
              source: "authored" as const,
              validation: { status: "ready" as const, message: "Ready" },
              preview: "data:image/png;base64,iVBORw0KGgo" + "A".repeat(200000),
            },
          }
        : {}),
      files,
      words: [],
      workspace: writeProjectWorkspace(documents),
    },
  });
  const opened = (await loadAuthoredGameWithHistoryLifetime(projectId))!;
  baseData = opened.data;
  return openProjectSession({
    publish: (_snapshot, data) => {
      published = data;
    },
    data: opened.data,
    lifetime: opened.lifetime!,
    admission: {
      runToken: name,
      admit: async () => ({
        status: "committed",
        expected: null,
        current: null,
        patchGeneration: 1,
      }),
    },
  });
}
async function edit(
  owner: ReturnType<typeof openProjectSession>,
  content: string,
  key = "logic:0",
) {
  await owner.submit({
    proposal: owner.model.propose(owner.model.capture(), "Message", [{ key, content }]),
    label: "Message",
    origin: "logic",
    author: "creator",
  });
}
test("journal writes coalesce on a frame and omit unedited resources and documents", async () => {
  const owner = await session("compact-content");
  await edit(owner, 'print("one"); return;');
  await edit(owner, 'print("two"); return;');
  assert.equal(
    journals().length,
    0,
    "accepted edits schedule, rather than synchronously encode a journal",
  );
  assert.equal(frames.size, 1);
  paint();
  const raw = journals()[0]![1];
  assert.ok(raw.includes("one"));
  assert.ok(raw.includes("two"));
  assert.ok(!raw.includes("UNEDITED_SENTINEL"));
  assert.ok(!raw.includes("VOL.0"));
  assert.ok(
    !raw.includes("picture:1"),
    "unedited resource content and identity are rebuilt from the base",
  );
  owner.dispose();
  const reopened = (await loadAuthoredGame(testProjectId("compact-content")))!;
  assert.equal(
    reopened.workspace!.documents.find((doc) => doc.key === "logic:0")!.content.type,
    "text",
  );
  assert.equal(reopened.projectHistory!.commits.length, 3);
  assert.equal(journals().length, 0);
});
test("closing before a reference attachment commits recovers it from the journal", async () => {
  const owner = await session("compact-reference");
  const projectId = testProjectId("compact-reference");
  const reference = roomReference(
    "ref-harbour",
    1,
    "Harbour",
    { project: projectId, revision: baseData.library!.revision },
    {
      width: 1,
      height: 1,
      rgba: Uint8Array.of(1, 2, 3, 255),
      bytes: Uint8Array.of(1),
      mime: "image/png",
    },
  );
  await owner.saveReferences((current) => [...current, reference]);
  paint();
  assert.equal(journals().length, 1);
  owner.dispose();
  const reopened = (await loadAuthoredGame(projectId))!;
  assert.deepEqual(reopened.references, [reference]);
  assert.equal(reopened.generation, baseData.generation! + 1);
  assert.equal(journals().length, 0);
});
test("closing before a reviewed room removal commits recovers the accepted Undo", async () => {
  const owner = await session("compact-reviewed-room");
  await edit(owner, 'get.num("Room",v20);new.room.v(v20);return;', "logic:99");
  await edit(owner, "return;", "logic:254");
  const warning = await owner.undo();
  assert.equal(warning?.status, "reviewRequired");
  if (warning?.status !== "reviewRequired") throw new Error("Expected review");
  assert.equal((await owner.undo(warning.review))?.status, "committed");
  const cursor = owner.history.capture().cursor;
  paint();
  const capture = captured();
  owner.dispose();
  const request = await rebuildProjectJournal(baseData, capture, {
    commit: commitProject,
    fingerprint: authoringFingerprint,
  });
  assert.equal(
    request.data.workspace!.documents.find((doc) => doc.key === "logic:254"),
    undefined,
  );
  assert.equal(request.data.projectHistory!.cursor, cursor);
});
test("a quota failure retains the previous recovery journal and Saving awaits IndexedDB", async () => {
  const owner = await session("compact-quota");
  await edit(owner, 'print("first"); return;');
  paint();
  assert.equal(journals().length, 1);
  const before = journals()[0]![1];
  const setItem = storage.setItem;
  storage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  try {
    await edit(owner, 'print("latest"); return;');
    paint();
    assert.equal(journals()[0]?.[1], before);
    assert.equal(owner.saveStatus().state, "pending");
  } finally {
    storage.setItem = setItem;
    owner.dispose();
  }
});

test("Discard and exit removes the session's pending recovery journal", async () => {
  const owner = await session("compact-discard");
  await edit(owner, 'print("discarded"); return;');
  paint();
  assert.equal(journals().length, 1);
  owner.discard();
  paint();
  assert.deepEqual(journals(), []);
});

function captured(): ProjectJournalCapture {
  const envelope = JSON.parse(journals()[0]![1]) as { entries: unknown };
  return (decodeJournalValue(envelope.entries) as { capture: ProjectJournalCapture }[])[0]!.capture;
}
test("compact replay preserves invalid source, Undo/Redo and exact commit metadata after a receipt", async () => {
  const owner = await session("compact-exact");
  await edit(owner, 'print("durable"); return;');
  await owner.flush();
  await edit(owner, 'print("next"); return;');
  await edit(owner, "if (");
  await owner.undo();
  await owner.redo();
  await owner.tag("Typed");
  paint();
  const capture = captured();
  const original = {
    ...capture.identity,
    documents: owner.model
      .capture()
      .keys.map((key) => ({ key, version: owner.model.capture().version(key) })),
    data: published,
  };
  owner.dispose();
  const recovered = (await loadAuthoredGame(original.projectId))!;
  assert.equal(
    recovered.workspace!.documents.find((doc) => doc.key === "logic:0")!.content.type,
    "text",
  );
  assert.equal(recovered.projectHistory!.tags["Typed"], recovered.projectHistory!.cursor);
  assert.equal(
    (await commitProject(original)).receipt.saved.generation,
    recovered.generation,
    "recovery must reproduce the exact candidate hash",
  );
});
test("an interrupted compact receipt rebases only its unattempted successor and replays once", async () => {
  const owner = await session("compact-interrupted");
  await edit(owner, 'print("first"); return;');
  paint();
  const first = captured();
  const firstRequest = await rebuildProjectJournal(baseData, first, {
    commit: commitProject,
    fingerprint: authoringFingerprint,
  });
  const receipt = (await commitProject(firstRequest, first.hash)).receipt;
  await edit(owner, 'print("second"); return;');
  paint();
  const next = captured();
  const original = {
    ...next.identity,
    expected: receipt.saved,
    documents: owner.model
      .capture()
      .keys.map((key) => ({ key, version: owner.model.capture().version(key) })),
    data: published,
  };
  owner.dispose();
  const key = journals()[0]![0];
  writeProjectSaveJournal(storage, key, [
    { capture: first, attempted: true },
    { capture: next, attempted: false },
  ]);
  const recovered = (await loadAuthoredGame(original.projectId))!;
  assert.equal(recovered.generation, 3);
  assert.equal((await commitProject(original)).receipt.saved.generation, 3);
  assert.equal(journals().length, 0);
  assert.equal((await loadAuthoredGame(original.projectId))!.generation, 3);
});

test("ordered edited versions rebuild native packing after an aliased resource changes and Undo", async () => {
  const owner = await session("compact-alias", true);
  await edit(owner, 'print("new"); return;', "logic:1");
  await owner.undo();
  paint();
  const capture = captured();
  const original = {
    ...capture.identity,
    documents: owner.model
      .capture()
      .keys.map((key) => ({ key, version: owner.model.capture().version(key) })),
    data: published,
  };
  assert.notDeepEqual(published.files["LOGDIR"], baseData.files["LOGDIR"]);
  owner.dispose();
  const recovered = (await loadAuthoredGame(original.projectId))!;
  assert.deepEqual(recovered.files, original.data.files);
  assert.equal((await commitProject(original)).receipt.saved.generation, recovered.generation);
});
test("pagehide and hidden visibility flush a scheduled journal immediately", async () => {
  const events = new EventTarget();
  const visibility = new EventTarget();
  const descriptors = ["document", "addEventListener", "removeEventListener"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: Object.assign(visibility, { visibilityState: "hidden" }),
  });
  Object.defineProperty(globalThis, "addEventListener", {
    configurable: true,
    value: events.addEventListener.bind(events),
  });
  Object.defineProperty(globalThis, "removeEventListener", {
    configurable: true,
    value: events.removeEventListener.bind(events),
  });
  const owner = await session("compact-lifecycle");
  try {
    await edit(owner, 'print("pagehide"); return;');
    assert.equal(journals().length, 0);
    events.dispatchEvent(new Event("pagehide"));
    assert.equal(journals().length, 1);
    assert.equal(frames.size, 0);
    await edit(owner, 'print("hidden"); return;');
    visibility.dispatchEvent(new Event("visibilitychange"));
    assert.ok(journals()[0]![1].includes("hidden"));
    assert.equal(frames.size, 0);
  } finally {
    owner.dispose();
    for (const [key, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
test("a stale compact journal retains its bytes and leaves another tab's project intact", async () => {
  const owner = await session("compact-stale");
  await edit(owner, 'print("unsaved"); return;');
  paint();
  const capture = captured();
  owner.dispose();
  const [key, raw] = journals()[0]!;
  await commitProject({
    ...capture.identity,
    expected: capture.base,
    commitId: "other-tab",
    documents: [],
    data: { ...baseData, title: "Other tab" },
  });
  const recovered = (await loadAuthoredGame(capture.base.projectId))!;
  assert.equal(recovered.title, "Other tab");
  assert.equal(storage.getItem(key), raw);
});

test("binary edits use base64 and omit an unedited library preview", async () => {
  const owner = await session("compact-binary", false, true);
  assert.ok(baseData.library!.preview);
  await owner.submit({
    proposal: owner.model.propose(owner.model.capture(), "Color", [
      { key: "picture:1", content: Uint8Array.of(240, 3, 255) },
    ]),
    label: "Color",
    origin: "picture",
    author: "creator",
  });
  paint();
  const raw = journals()[0]![1];
  assert.ok(raw.includes('["base64","8AP/"]'));
  assert.ok(raw.length < 5000, "an unchanged preview is inherited from the durable base");
  owner.dispose();
  const saved = (await loadAuthoredGame(testProjectId("compact-binary")))!;
  assert.equal(saved.library!.preview, undefined);
  assert.deepEqual(saved.workspace!.documents.find((doc) => doc.key === "picture:1")!.content, {
    type: "bytes",
    bytes: [240, 3, 255],
  });
});

test("a catalog fork journals subsequent edits under its new owner", async () => {
  const owner = await session("compact-catalog", false, false, true);
  await edit(owner, 'print("remix"); return;');
  await owner.flush();
  await edit(owner, 'print("new owner"); return;');
  paint();
  const capture = captured();
  assert.notEqual(capture.identity.projectId, baseData.projectId);
  assert.ok(
    journals()[0]![0].startsWith(`monotio_agi.project-writes.${capture.identity.projectId}.`),
  );
  owner.dispose();
  const recovered = (await loadAuthoredGame(capture.identity.projectId))!;
  assert.equal(recovered.generation, 2);
  assert.equal(
    (
      recovered.workspace!.documents.find((doc) => doc.key === "logic:0")!.content as {
        text: string;
      }
    ).text,
    'print("new owner"); return;',
  );
});
test("journal identities order metadata keys by code point", async () => {
  const owner = await session("compact-codepoints");
  await edit(owner, "return;");
  paint();
  const capture = captured();
  const request = {
    ...capture.identity,
    documents: [],
    data: { ...published, authoringState: { "🙂": 1, "\ue000": 2 } },
  };
  const input = {
    request,
    base: baseData,
    expected: capture.base,
    openedAt: capture.openedAt,
    baseImage: capture.baseImage,
    image: capture.image,
    operations: capture.operations,
  };
  const reversed = {
    ...request,
    data: { ...request.data, authoringState: { "\ue000": 2, "🙂": 1 } },
  };
  assert.equal(
    captureProjectJournal(input).hash,
    captureProjectJournal({ ...input, request: reversed }).hash,
  );
  owner.dispose();
});

test("recovery keeps the working image when Undo returns to invalid source", async () => {
  const owner = await session("compact-invalid-base");
  const result = await owner.submit({
    proposal: owner.model.propose(owner.model.capture(), "Typing", [
      { key: "logic:0", content: "if (" },
    ]),
    label: "Typing",
    origin: "logic",
    author: "creator",
  });
  assert.equal(result.status, "diagnostics");
  await edit(owner, 'print("working"); return;');
  await owner.undo();
  await owner.flush();
  await owner.submit({
    proposal: owner.model.propose(owner.model.capture(), "Notes", [
      { key: "notes", content: "Still typing" },
    ]),
    label: "Notes",
    origin: "logic",
    author: "creator",
  });
  paint();
  const capture = captured();
  const original = {
    ...capture.identity,
    documents: owner.model
      .capture()
      .keys.map((key) => ({ key, version: owner.model.capture().version(key) })),
    data: published,
  };
  owner.dispose();
  const recovered = (await loadAuthoredGame(original.projectId))!;
  assert.deepEqual(recovered.files, original.data.files);
  assert.equal((await commitProject(original)).receipt.saved.generation, recovered.generation);
});

test("recovery uses native documents for initial source errors before History exists", async () => {
  const initial = await session("compact-initial-error");
  initial.dispose();
  await saveAuthoredGame(baseData.projectId, {
    ...baseData,
    workspace: writeProjectWorkspace({ "logic:0": "if (", "picture:1": Uint8Array.of(255) }),
  });
  const opened = (await loadAuthoredGameWithHistoryLifetime(baseData.projectId))!;
  assert.equal(opened.data.projectHistory, undefined);
  const owner = openProjectSession({
    data: opened.data,
    lifetime: opened.lifetime!,
    admission: {
      runToken: "initial-error",
      admit: async () => ({
        status: "committed",
        expected: null,
        current: null,
        patchGeneration: 1,
      }),
    },
  });
  await owner.submit({
    proposal: owner.model.propose(owner.model.capture(), "Typing", [
      { key: "logic:0", content: "if (isset(" },
    ]),
    label: "Typing",
    origin: "logic",
    author: "creator",
  });
  paint();
  owner.dispose();
  const recovered = (await loadAuthoredGame(opened.data.projectId))!;
  assert.deepEqual(recovered.files, opened.data.files);
  assert.equal(
    (
      recovered.workspace!.documents.find((doc) => doc.key === "logic:0")!.content as {
        text: string;
      }
    ).text,
    "if (isset(",
  );
});

test("a session publishes no journal or accepted image before its lock is acquired", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")!;
  let acquire!: () => Promise<void>;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request(_name: string, callback: () => Promise<void>) {
          return new Promise<void>((resolve) => {
            acquire = async () => {
              await callback();
              resolve();
            };
          });
        },
      },
    },
  });
  const owner = await session("session-lock-ready");
  const before = owner.model.capture().documentId;
  const editing = edit(owner, 'print("Acquired"); return;');
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    paint();
    assert.equal(journals().length, 0);
    assert.equal(owner.model.capture().documentId, before);
    const holding = acquire();
    assert.equal(await owner.ready, true);
    await editing;
    paint();
    assert.equal(journals().length, 1);
    owner.dispose();
    await holding;
  } finally {
    owner.dispose();
    Object.defineProperty(globalThis, "navigator", descriptor);
  }
});

test("a project without Web Locks opens read-only and retains accepted content", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")!;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  const owner = await session("locks-unavailable");
  try {
    assert.equal(await owner.ready, false);
    await assert.rejects(edit(owner, "Changed"));
    assert.equal(owner.saveStatus().state, "conflict");
    assert.equal(owner.model.capture().read("notes")!.content, "UNEDITED_SENTINEL");
    paint();
    owner.dispose();
    assert.equal(journals().length, 0);
  } finally {
    owner.dispose();
    Object.defineProperty(globalThis, "navigator", descriptor);
  }
});

test("closing before room generation and its room edit commit replays the setting before admission", async () => {
  const owner = await session("compact-room-setting");
  await owner.setRoomGeneration(true);
  await edit(owner, "new.room(9); return;");
  assert.deepEqual(owner.capture().diagnostics, []);
  paint();
  const capture = captured();
  owner.dispose();
  const request = await rebuildProjectJournal(baseData, capture, {
    commit: commitProject,
    fingerprint: authoringFingerprint,
  });
  assert.equal(request.data.roomGeneration, true);
  assert.equal(
    request.data.workspace!.documents.find((doc) => doc.key === "logic:0")!.content.type,
    "text",
  );
  assert.equal(request.buildId, owner.model.capture().lastAdmissibleBuild!.identity.buildId);
});

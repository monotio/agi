import assert from "node:assert/strict";
import type { ProjectChange } from "../../src/authoring/projectContent.ts";
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

installIndexedDbFixture();
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

test("editor intent restores notes and invalid LOGIC before debounce or admission", async () => {
  const opened = await session("journal-editor-intent");
  opened.rememberEditorChanges([
    { key: "notes", content: "immediate note" },
    { key: "logic:0", content: "invalid LOGIC !!!" },
    { key: "words", content: '[["newword",42]]' },
  ]);
  const before = opened.model.capture().lastAdmissibleBuild!.identity.buildId;
  assert.equal(opened.model.capture().read("notes")!.content, "UNEDITED_SENTINEL");
  opened.dispose();
  const recovered = (await loadAuthoredGame(baseData.projectId))!;
  const documents = recovered.workspace!.documents;
  assert.equal(documents.find(({ key }) => key === "notes")!.content.type, "text");
  assert.deepEqual(documents.find(({ key }) => key === "notes")!.content, {
    type: "text",
    text: "immediate note",
  });
  assert.deepEqual(documents.find(({ key }) => key === "logic:0")!.content, {
    type: "text",
    text: "invalid LOGIC !!!",
  });
  assert.deepEqual(documents.find(({ key }) => key === "words")!.content, {
    type: "text",
    text: '[["newword",42]]',
  });
  const restarted = openProjectSession({
    data: recovered,
    lifetime: opened.lifetime,
    admission: {
      runToken: "restored-editor",
      admit: async () => {
        throw new Error("invalid source reached engine");
      },
    },
  });
  assert.equal(restarted.model.capture().lastAdmissibleBuild!.identity.buildId, before);
  restarted.dispose();
});

test("SOUND intent keeps the captured bytes and tempo together before admission", async () => {
  const owner = await session("journal-editor-sound");
  const { soundProjectChanges } = await import("../src/studio/sound/soundEdits.ts");
  const original = Uint8Array.of(8, 0, 10, 0, 12, 0, 14, 0, 255, 255, 255, 255, 255, 255, 255, 255);
  const bytes = original.slice();
  owner.rememberEditorChanges(soundProjectChanges("sound:7", bytes, 180));
  // An editor may reuse its event buffer; recovery belongs to the captured gesture.
  bytes.fill(0);
  owner.dispose();
  const recovered = (await loadAuthoredGame(baseData.projectId))!;
  assert.deepEqual(recovered.workspace!.documents.find(({ key }) => key === "sound:7")!.content, {
    type: "bytes",
    bytes: [...original],
  });
  const music = recovered.workspace!.documents.find(({ key }) => key === "music")!.content;
  assert.ok(music.type === "text");
  assert.equal(JSON.parse(music.text)["7"].tempo, 180);
});

test("a catalog fork acknowledgement keeps a newer editor intent recoverable immediately", async () => {
  const owner = await session("journal-fork-intent", false, false, true);
  await edit(owner, 'print("first remix"); return;');
  owner.rememberEditorChanges([{ key: "notes", content: "newer than the fork receipt" }]);
  const projectId = captured().identity.projectId;
  await owner.flush();
  assert.notEqual(projectId, baseData.projectId);
  assert.equal(journals().length, 1);
  assert.ok(journals()[0]![0].startsWith(`monotio_agi.project-writes.${projectId}.`));
  assert.match(journals()[0]![1], /newer than the fork receipt/);
  owner.dispose();
  const recovered = (await loadAuthoredGame(projectId))!;
  assert.deepEqual(recovered.workspace!.documents.find(({ key }) => key === "notes")!.content, {
    type: "text",
    text: "newer than the fork receipt",
  });
});

for (const action of ["undo", "restore"] as const) {
  test(`written editor intent stays retired after ${action} and reopen`, async () => {
    const owner = await session(`intent-${action}`);
    const initial = owner.history.capture().cursor!;
    // A derived companion changes between the gesture and admission.
    owner.rememberEditorChanges([
      { key: "notes", content: "Edited" },
      { key: "music", content: '{"1":90}' },
    ]);
    await owner.submit({
      proposal: owner.model.propose(owner.model.capture(), "Derived metadata", [
        { key: "notes", content: "Edited" },
        { key: "music", content: '{"1":90,"2":120}' },
      ]),
      label: "Derived metadata",
      origin: "sound",
      author: "creator",
    });
    await owner.flush();
    await (action === "undo" ? owner.undo() : owner.restore(initial));
    await owner.flush();
    owner.dispose();
    const saved = await loadAuthoredGame(testProjectId(`intent-${action}`));
    assert.equal(
      saved!.workspace!.documents.find((doc) => doc.key === "music"),
      undefined,
    );
    assert.equal(journals().length, 0);
  });
}

test("a coordinated intent recovers a document removal before admission", async () => {
  const owner = await session("intent-removal");
  assert.equal(owner.rememberEditorChanges([{ key: "notes", content: null }]), undefined);
  owner.dispose();
  const reopened = await loadAuthoredGame(testProjectId("intent-removal"));
  assert.equal(
    reopened!.workspace!.documents.find((doc) => doc.key === "notes"),
    undefined,
  );
});

test("an unchanged accepted document retires its editor intent", async () => {
  const owner = await session("intent-unchanged");
  owner.rememberEditorChanges([{ key: "notes", content: "UNEDITED_SENTINEL" }]);
  await edit(owner, "UNEDITED_SENTINEL", "notes");
  await owner.flush();
  owner.dispose();
  assert.equal(journals().length, 0);
});

for (const action of ["undo", "restore"] as const) {
  test(`${action} preserves an unadmitted intent on another document`, async () => {
    const owner = await session(`pending-intent-${action}`);
    const initial = owner.history.capture().cursor!;
    await edit(owner, 'print("Committed"); return;');
    await owner.flush();
    owner.rememberEditorChanges([{ key: "notes", content: "Older pending notes" }]);
    await (action === "undo" ? owner.undo() : owner.restore(initial));
    await owner.flush();
    owner.dispose();
    const reopened = await loadAuthoredGame(testProjectId(`pending-intent-${action}`));
    assert.deepEqual(reopened!.workspace!.documents.find((doc) => doc.key === "notes")!.content, {
      type: "text",
      text: "Older pending notes",
    });
    assert.equal(journals().length, 0);
  });
}

test("two SOUND gestures retire only their admitted intent, including tempo-only edits", async () => {
  const owner = await session("intent-two-sounds");
  const { soundProjectChanges } = await import("../src/studio/sound/soundEdits.ts");
  const bytes = Uint8Array.of(8, 0, 10, 0, 12, 0, 14, 0, 255, 255, 255, 255, 255, 255, 255, 255);
  const submit = async (changes: readonly ProjectChange[], intent?: number) =>
    owner.submit({
      proposal: owner.model.propose(owner.model.capture(), "Sound", changes),
      label: "Sound",
      origin: "sound",
      author: "creator",
      ...(intent === undefined ? {} : { editorIntent: intent }),
    });
  await submit([...soundProjectChanges("sound:1", bytes, 90), { key: "sound:2", content: bytes }]);
  await owner.flush();
  const first = soundProjectChanges(
    "sound:1",
    bytes,
    120,
    String(owner.model.capture().read("music")!.content),
  );
  owner.rememberEditorChanges(first);
  const intent1 = owner.captureEditorIntent("sound:1");
  const second = soundProjectChanges("sound:2", bytes, 180, String(first[1]!.content));
  owner.rememberEditorChanges(second);
  const intent2 = owner.captureEditorIntent("sound:2");
  // The first write derives the shared metadata after the second gesture.
  const actual = soundProjectChanges("sound:1", bytes, 120, String(second[1]!.content));
  await submit(actual, intent1);
  await owner.flush();
  assert.match(journals()[0]![1], /editorIntent/);
  assert.equal(owner.captureEditorIntent("sound:2"), intent2);
  await submit(
    soundProjectChanges(
      "sound:2",
      bytes,
      180,
      String(owner.model.capture().read("music")!.content),
    ),
    intent2,
  );
  await owner.flush();
  owner.dispose();
  const reopened = await loadAuthoredGame(testProjectId("intent-two-sounds"));
  const music = reopened!.workspace!.documents.find((doc) => doc.key === "music")!.content;
  assert.ok(music.type === "text");
  assert.equal(JSON.parse(music.text)["1"].tempo, 120);
  assert.equal(JSON.parse(music.text)["2"].tempo, 180);
  assert.equal(journals().length, 0);
});

test("removal retires a live journal through frames, further typing and dispose", async () => {
  const owner = await session("removed-journal-owner");
  owner.rememberEditorChanges([{ key: "notes", content: "Before removal" }]);
  assert.equal(journals().length, 1);
  const { clearCachedGame } = await import("../src/project/gameStorage.ts");
  await clearCachedGame(baseData.projectId);
  owner.stopWrites("removed");
  paint();
  owner.rememberEditorChanges([{ key: "notes", content: "After removal" }]);
  owner.dispose();
  assert.equal(journals().length, 0);
});

test("Restore preserves a failed editor intent until its own edit is admitted", async () => {
  const owner = await session("restore-failed-intent");
  const opened = owner.history.capture().cursor!;
  await edit(owner, 'print("Accepted"); return;');
  await owner.flush();
  owner.rememberEditorChanges([{ key: "notes", content: "Failed editor draft" }]);
  await owner.restore(opened);
  await owner.flush();
  assert.equal(owner.hasEditorIntents, true);
  owner.dispose();
  assert.equal(journals().length, 1);
  assert.match(journals()[0]![1], /Failed editor draft/);
  const reopened = (await loadAuthoredGame(baseData.projectId))!;
  assert.deepEqual(reopened.workspace!.documents.find((entry) => entry.key === "notes")!.content, {
    type: "text",
    text: "Failed editor draft",
  });
});

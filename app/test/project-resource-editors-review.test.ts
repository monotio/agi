import assert from "node:assert/strict";
import { test } from "node:test";
import { openContainer } from "../../src/container/container.ts";
import { compilePictureSource } from "../../src/picture/source.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { openEditableProject } from "../src/project/editableProject.ts";
import { loadAuthoredGame } from "../src/project/gameStorage.ts";
import { openProjectResourceEditor } from "../src/studio/project/projectResourceEdits.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key),
  },
});

async function fixture() {
  const prepared = prepareLocalProject({ title: "Editor admission review", kind: "starter" });
  await prepared.save();
  const project = await openEditableProject(prepared.projectId);
  const original = project.draft.capture().read("picture:1")!.content;
  assert.equal(typeof original, "string");
  const source = `${(original as string).replace(/end\s*$/, "")}vis 4\nrect 10,60 30,80\nend\n`;
  const bytes = compilePictureSource(source).bytes;
  const edit = {
    pictureNumber: 1,
    source,
    bytes,
    baseRevision: project.savedIdentity().revision,
    reason: "Reviewed drawing",
  };
  const before = (await loadAuthoredGame(prepared.projectId))!;
  return { project, edit, before };
}

test("closing from draft notification fences durable Keep and retains pending drawing", async () => {
  const f = await fixture();
  const editor = openProjectResourceEditor(f.project, "picture:1", {
    onDraftChanged: () => editor.close(),
  });
  await assert.rejects(editor.keepPicture(f.edit), /closed|workspace|stale/i);
  assert.deepEqual((await loadAuthoredGame(f.project.projectId))!.files, f.before.files);
  assert.equal(f.project.draft.capture().read("picture:1")?.content, f.edit.source);
  assert.ok(f.project.draft.dirtyKeys().includes("picture:1"));
});

test("a workspace accessor closing the editor cannot authorize a write by returning true", async () => {
  const f = await fixture();
  const editor = openProjectResourceEditor(f.project, "picture:1", {
    isCurrent: () => {
      editor.close();
      return true;
    },
  });
  await assert.rejects(editor.keepPicture(f.edit), /closed|workspace|stale/i);
  assert.deepEqual((await loadAuthoredGame(f.project.projectId))!.files, f.before.files);
  assert.deepEqual(f.project.draft.dirtyKeys(), []);
});

test("a receipt notification exception cannot report a durable Keep as failed", async () => {
  const f = await fixture();
  const editor = openProjectResourceEditor(f.project, "picture:1", {
    onKept: () => {
      throw new Error("UI notification failed");
    },
  });
  const result = await editor.keepPicture(f.edit);
  assert.equal(result.status, "committed");
  const stored = (await loadAuthoredGame(f.project.projectId))!;
  assert.deepEqual(
    openContainer(new Map(Object.entries(stored.files))).getResource("picture", 1),
    f.edit.bytes,
  );
  assert.deepEqual(f.project.draft.dirtyKeys(), []);
});

for (const ended of ["closed", "swapped"] as const) {
  test(`a durable receipt arriving after the editor is ${ended} cannot notify its former host`, async () => {
    const f = await fixture();
    const keep = f.project.keepCandidate.bind(f.project);
    let committed!: () => void;
    const receiptReady = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let deliver!: () => void;
    const delivery = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    f.project.keepCandidate = async (candidate, review) => {
      const result = await keep(candidate, review);
      committed();
      await delivery;
      return result;
    };
    let current = true;
    let notices = 0;
    const editor = openProjectResourceEditor(f.project, "picture:1", {
      isCurrent: () => current,
      onKept: () => {
        notices++;
      },
    });
    const pending = editor.keepPicture(f.edit);
    await receiptReady;
    if (ended === "closed") editor.close();
    else current = false;
    deliver();
    assert.equal((await pending).status, "committed", "a published receipt remains the truth");
    assert.equal(notices, 0, "late delivery must not update a closed or different workspace");
    const stored = (await loadAuthoredGame(f.project.projectId))!;
    assert.deepEqual(
      openContainer(new Map(Object.entries(stored.files))).getResource("picture", 1),
      f.edit.bytes,
    );
  });
}

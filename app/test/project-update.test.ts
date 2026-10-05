import assert from "node:assert/strict";
import { test } from "node:test";
import { openProjectSession } from "../src/project/projectSession.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer } from "../../src/container/container.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";

function opened(
  name: string,
  admit: Parameters<typeof openProjectSession>[0]["admission"]["admit"],
) {
  const documents = { "logic:0": "return;", "logic:1": "return;", notes: "Original" };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  let publishes = 0;
  const session = openProjectSession({
    data: {
      projectId: requireProjectId(name),
      title: "Update proof",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(documents),
    },
    lifetime: "initial",
    admission: { runToken: name, admit },
    publish() {
      publishes++;
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
    boundary: async () => {},
  });
  return { session, publishes: () => publishes };
}
const committed = () =>
  Promise.resolve({
    status: "committed" as const,
    expected: null,
    current: null,
    patchGeneration: 1,
  });

test("one Update admits all parts and creates one Undo step", async () => {
  const { session } = opened("update-together", committed);
  const before = session.history.capture().commits.length;
  await session.update([
    { key: "logic:1", content: 'print("New"); return;' },
    { key: "notes", content: "New note" },
  ]);
  assert.equal(session.history.capture().commits.length, before + 1);
  assert.equal(session.model.capture().read("notes")?.content, "New note");
  await session.undo();
  assert.equal(session.model.capture().read("notes")?.content, "Original");
  assert.equal(session.model.capture().read("logic:1")?.content, "return;");
  session.dispose();
});

test("an invalid part refuses the whole Update, preserving documents, game and history", async () => {
  let admissions = 0;
  const { session, publishes } = opened("update-invalid", async () => {
    admissions++;
    return committed();
  });
  const before = session.model.capture();
  const history = session.history.capture();
  const result = await session.update([
    { key: "logic:1", content: "if (" },
    { key: "notes", content: "Pending" },
  ]);
  assert.equal(result.status, "diagnostics");
  assert.equal(admissions, 0);
  assert.equal(publishes(), 0);
  assert.equal(session.model.capture().documentId, before.documentId);
  assert.deepEqual(session.history.capture(), history);
  session.dispose();
});

test("Update waits for a safe point and a subsequent refusal publishes nothing", async () => {
  let admissions = 0;
  const { session, publishes } = opened("update-safe", async () => ({
    status: ++admissions === 1 ? "deferred" : "refused",
    expected: null,
    current: null,
    patchGeneration: 0,
  }));
  const before = session.model.capture();
  const result = await session.update([{ key: "notes", content: "Pending" }]);
  assert.equal(admissions, 2);
  assert.equal(result.status, "refused");
  assert.equal(publishes(), 0);
  assert.equal(session.model.capture().documentId, before.documentId);
  session.dispose();
});

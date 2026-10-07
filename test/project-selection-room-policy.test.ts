import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { compileProjectDocuments } from "../src/authoring/projectDocuments.ts";
import { compileProjectSelection } from "../src/authoring/projectSelection.ts";

const profileId = "2.936" as const;

function workspace(documents: Record<string, string | Uint8Array>) {
  const files = Object.fromEntries(
    compileProjectDocuments({
      files: Object.fromEntries(createContainer().files),
      profileId,
      documents,
    }).files(),
  );
  return { files, draft: new ProjectDraft(documents), profileId };
}

function missingResource(candidate: ReturnType<typeof compileProjectSelection>, command: string) {
  return candidate.references.diagnostics.find(
    (entry) => entry.code === "missing-resource" && entry.command === command,
  );
}

test("a static missing new.room target stays an error without the generation policy", () => {
  const input = workspace({ "logic:0": "new.room(9); return;" });
  const candidate = compileProjectSelection({ ...input, keys: [] });
  assert.equal(missingResource(candidate, "new.room")?.severity, "error");
});

test("the explicit generation policy keeps only future new.room targets quiet", () => {
  const input = workspace({ "logic:0": "new.room(9); load.view(8); return;" });
  const candidate = compileProjectSelection({ ...input, keys: [], allowMissingRooms: true });
  assert.equal(missingResource(candidate, "new.room"), undefined);
  assert.equal(missingResource(candidate, "load.view")?.severity, "error");
});

test("a missing resource stays an error when the policy only covers rooms", () => {
  const input = workspace({ "logic:0": "load.view(8); return;" });
  const candidate = compileProjectSelection({ ...input, keys: [], allowMissingRooms: true });
  assert.equal(missingResource(candidate, "load.view")?.severity, "error");
});

test("an existing room target produces no missing-resource diagnostic under either policy", () => {
  const input = workspace({ "logic:0": "new.room(1); return;", "logic:1": "return;" });
  for (const allowMissingRooms of [undefined, true]) {
    const candidate = compileProjectSelection({
      ...input,
      keys: [],
      ...(allowMissingRooms === undefined ? {} : { allowMissingRooms }),
    });
    assert.equal(missingResource(candidate, "new.room"), undefined);
    assert.deepEqual(candidate.references.diagnostics, []);
  }
});

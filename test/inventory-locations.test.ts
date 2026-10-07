import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer, openContainer } from "../src/container/container.ts";
import { compileProjectDocuments } from "../src/authoring/projectDocuments.ts";
import { compileProjectSelection } from "../src/authoring/projectSelection.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { inspectProjectReferences } from "../src/authoring/projectReferences.ts";
import { readInventoryObjects } from "../src/authoring/inventory.ts";
import { PROFILES } from "../src/runtime/profile.ts";

const profileId = "2.936" as const;
function project(extra: Record<string, string>) {
  const documents = {
    "logic:0": "get(0); return;",
    words: "[]",
    bindings: "{}",
    inventory: JSON.stringify([{ name: "Key", startingRoom: 42 }]),
    ...extra,
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    profileId,
    documents,
  });
  return {
    documents,
    files: Object.fromEntries(compiled.files()),
    draft: new ProjectDraft(documents),
    profileId,
  };
}

test("an offstage inventory location is retained without a hard missing-LOGIC dependency", () => {
  const input = project({});
  const container = openContainer(new Map(Object.entries(input.files)));
  const references = inspectProjectReferences({ container, profile: PROFILES[profileId] });
  assert.equal(
    references.diagnostics.some((entry) => entry.severity === "error"),
    false,
  );
  assert.equal(references.dependencies["inventory"]?.includes("logic:42") ?? false, false);
  assert.equal(
    readInventoryObjects(container.files.get("OBJECT"), PROFILES[profileId])[0]!.startingRoom,
    42,
  );
});

test("selecting an inventory location edit leaves an unrelated broken LOGIC draft out", () => {
  const input = project({
    "logic:42": "return;",
    inventory: JSON.stringify([{ name: "Key", startingRoom: 0 }]),
  });
  input.draft.edit(
    "inventory",
    JSON.stringify([{ name: "Key", startingRoom: 42 }]),
    input.draft.capture().version("inventory"),
  );
  input.draft.edit("logic:42", "if (unfinished", input.draft.capture().version("logic:42"));
  const candidate = compileProjectSelection({ ...input, keys: ["inventory"] });
  assert.deepEqual(candidate.selection.keys, ["inventory"]);
  assert.equal(candidate.compiled.documents()["logic:42"], "return;");
  assert.equal(input.draft.capture().read("logic:42")!.content, "if (unfinished");
});

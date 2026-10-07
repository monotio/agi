import { test } from "node:test";
import assert from "node:assert/strict";
import { rebaseWorldDraft } from "../src/project/projectWorld.ts";

test("a world draft keeps its room edits and takes Launches from the saved project", () => {
  const before = JSON.stringify({ rooms: { "1": { title: "Home" } } });
  const after = JSON.stringify({
    rooms: { "1": { title: "Home" } },
    launches: { "1": { entries: [{ id: "good", name: "Fixed" }] } },
  });
  const draft = JSON.stringify({
    rooms: { "1": { title: "Recovery room" } },
    launches: { "1": { entries: [{ id: "bad", name: "Repair me" }] } },
  });
  assert.deepEqual(JSON.parse(String(rebaseWorldDraft(before, after, draft))), {
    rooms: { "1": { title: "Recovery room" } },
    launches: { "1": { entries: [{ id: "good", name: "Fixed" }] } },
  });
  const cleared = JSON.parse(String(rebaseWorldDraft(draft, before, draft))) as object;
  assert.equal("launches" in cleared, false);
});

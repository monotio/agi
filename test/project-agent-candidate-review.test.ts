import assert from "node:assert/strict";
import { test } from "node:test";
import { captureAgentWorkspace } from "../src/authoring/projectAgentCandidate.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import { readProjectDocuments } from "../src/authoring/projectDocuments.ts";
import { createStarterProject } from "../src/authoring/starterProject.ts";
import { executeAgentTool } from "../src/agent/tools.ts";
import { openContainer } from "../src/container/container.ts";

function workspace() {
  const project = createStarterProject("blank");
  const files = Object.fromEntries(project.files());
  const read = readProjectDocuments({
    files,
    profileId: project.profileId,
    bindings: project.bindings,
  });
  return { project, files, draft: new ProjectDraft(read.documents) };
}

test("a valid authored uppercase vocabulary does not change during an untouched agent run", () => {
  const { project, files, draft } = workspace();
  const words = '[["LOOK", 2]]';
  draft.edit("words", words, draft.capture().version("words"));
  const captured = captureAgentWorkspace({ draft, files, profileId: project.profileId });
  assert.equal(captured.compilable, true);
  const candidate = captured.openToolState();
  assert.deepEqual(candidate.finish("unchanged").changes(), []);
  assert.equal(captured.documents()["words"], words);
});

test("the existing music tool can produce a reviewable Sound proposal without losing its authored tempo", () => {
  const { project, files, draft } = workspace();
  const captured = captureAgentWorkspace({ draft, files, profileId: project.profileId });
  const candidate = captured.openToolState();
  const result = executeAgentTool(candidate.state, "write_music", {
    num: 9,
    tempo: 120,
    tracks: [{ channel: "melody", volume: 15, events: [{ note: "A4", beats: 1, repeat: 1 }] }],
  });
  assert.equal(result.success, true);
  assert.deepEqual(
    candidate.state.container.getResource("sound", 9),
    Uint8Array.of(
      8,
      0,
      15,
      0,
      17,
      0,
      19,
      0,
      30,
      0,
      15,
      142,
      144,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
      255,
    ),
  );
  const proposal = candidate.finish("new cue");
  assert.ok(proposal.changes().some(({ key }) => key === "sound:9"));
  assert.ok(
    proposal
      .changes()
      .some(({ content }) => typeof content === "string" && content.includes('"tempo":120')),
    "authored tempo must have an explicit reviewable document representation",
  );
  assert.equal(draft.capture().read("sound:9"), undefined);
  assert.equal(openContainer(project.files()).getResource("sound", 9), null);
});

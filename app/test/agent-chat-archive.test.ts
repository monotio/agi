import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProjectZip, buildPublicGameZip } from "../src/archive/projectArchive.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { createContainer } from "../../src/container/container.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import {
  writeProjectWorkspace,
  readProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import { readAgentChats } from "../../src/agent/chats.ts";
test("private archives preserve chats and notes while public games carry playable resources", async () => {
  const documents = { "logic:0": "return;", notes: "Keep the tone friendly.\n", words: "[]" };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const chats = readAgentChats({
    format: "monotio.agi.chats",
    version: 1,
    active: "first",
    chats: [
      {
        id: "first",
        title: "Welcome sign",
        provider: "stub",
        model: "offline-stub",
        transcript: [{ role: "user", text: "Private task" }],
        messages: [
          {
            id: "message",
            role: "user",
            text: "Predict in Meadow",
            context: "LOGIC 1\nReturn JSON",
          },
        ],
      },
    ],
  });
  const data = {
    projectId: requireProjectId("archive-chats"),
    title: "Chats",
    authoredAt: "",
    files: Object.fromEntries(compiled.files()),
    words: [] as [string, number][],
    chats,
    workspace: writeProjectWorkspace(documents),
  };
  const opened = await readGameZip(await buildProjectZip(data));
  assert.deepEqual(opened.project?.chats, chats);
  assert.equal(readProjectWorkspace(opened.project!.workspace!)["notes"], documents.notes);
  const publicGame = await readGameZip(buildPublicGameZip(data));
  assert.equal(publicGame.project, undefined);
  assert.ok(
    !Object.keys(publicGame.files).some((name) => name.includes("CHAT") || name.includes("NOTES")),
  );
});
test("notes and checkpoints declare versions and readers reject unknown chat fields", () => {
  const workspace = writeProjectWorkspace({ notes: "Friendly" });
  assert.equal(workspace.version, 1);
  assert.throws(() => readProjectWorkspace({ ...workspace, version: 2 }), /version/i);
  assert.throws(
    () => readAgentChats({ format: "monotio.agi.chats", version: 2, active: null, chats: [] }),
    /version/i,
  );
  assert.throws(
    () =>
      readAgentChats({
        format: "monotio.agi.chats",
        version: 1,
        active: null,
        chats: [],
        apiKey: "private",
      }),
    /field/i,
  );
});

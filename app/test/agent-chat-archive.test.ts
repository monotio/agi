import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildProjectZip,
  buildPublicGameZip,
  continuationTranscript,
} from "../src/archive/projectArchive.ts";
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

test("a reopened review keeps the Agent's test reasons", () => {
  const chats = (testReport: unknown) => ({
    format: "monotio.agi.chats",
    version: 1,
    active: "c",
    chats: [
      {
        id: "c",
        title: "Task",
        provider: "stub",
        model: "stub",
        transcript: [],
        messages: [{ id: "m", role: "assistant", text: "Done", testReport }],
      },
    ],
  });
  const report = "1 test fails: Lake start\n- Lake start: room 5 was deleted.";
  assert.equal(readAgentChats(chats(report)).chats[0]!.messages[0]!.testReport, report);
  assert.throws(() => readAgentChats(chats(1)), /message/i);
});

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider} compaction survives legacy and task ZIP conversations and same-model continuation`, async () => {
    const transcript =
      provider === "openai"
        ? [
            { role: "user", content: "Build" },
            { type: "compaction", id: "c", encrypted_content: "opaque-state" },
          ]
        : [
            { role: "user", content: "Build" },
            {
              role: "assistant",
              content: [
                { type: "compaction", content: "Summary", encrypted_content: "opaque-state" },
              ],
            },
          ];
    const compiled = compileProjectDocuments({
      files: Object.fromEntries(createContainer().files),
      documents: { "logic:0": "return;", words: "[]" },
      profileId: "2.936",
    });
    const chats = readAgentChats({
      format: "monotio.agi.chats",
      version: 1,
      active: "c",
      chats: [{ id: "c", title: "Task", provider, model: "test", transcript, messages: [] }],
    });
    for (const conversation of [{ provider, model: "test", transcript }, { chats }]) {
      const data = {
        projectId: requireProjectId(`compaction-${provider}`),
        title: "Compaction",
        authoredAt: "",
        files: Object.fromEntries(compiled.files()),
        words: [] as [string, number][],
        ...conversation,
      };
      const opened = await readGameZip(await buildProjectZip(data));
      const restored = opened.project!.chats?.chats[0]?.transcript ?? opened.project!.transcript;
      assert.deepEqual(restored, transcript);
      const replay = continuationTranscript(
        { provider, model: "test", transcript: restored },
        provider,
        "test",
      );
      assert.deepEqual(replay, transcript);
      const publicGame = await readGameZip(buildPublicGameZip(data));
      assert.equal(publicGame.project, undefined);
    }
  });
}

test("Gemini transcripts archive inlineData images with distinct displayNames and strip signatures across providers", async () => {
  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).toString("base64");
  const transcript = [
    {
      role: "user",
      parts: [
        { text: "Inspect this frame" },
        { inlineData: { mimeType: "image/png", data: pngBytes } },
      ],
    },
    {
      role: "model",
      parts: [
        { text: "Checking...", thought: true },
        {
          functionCall: { id: "c1", name: "read_room", args: { room: 1 } },
          thoughtSignature: "opaque-sig-1",
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "c1",
            name: "read_room",
            response: {
              success: true,
              images: [
                { caption: "first", image: { $ref: "room-a.png" } },
                { caption: "second", image: { $ref: "room-b.png" } },
              ],
            },
            parts: [
              { inlineData: { mimeType: "image/png", displayName: "room-a.png", data: pngBytes } },
              { inlineData: { mimeType: "image/png", displayName: "room-b.png", data: pngBytes } },
            ],
          },
        },
      ],
    },
    {
      role: "model",
      parts: [{ text: "Room 1 looks good." }],
    },
  ];
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents: { "logic:0": "return;", words: "[]" },
    profileId: "2.936",
  });
  const chats = readAgentChats({
    format: "monotio.agi.chats",
    version: 1,
    active: "g",
    chats: [
      {
        id: "g",
        title: "Gemini check",
        provider: "gemini",
        model: "gemini-4-neon",
        transcript,
        messages: [],
      },
    ],
  });
  const zip = await buildProjectZip({
    projectId: requireProjectId("gemini-archive"),
    title: "Gemini",
    authoredAt: "",
    files: Object.fromEntries(compiled.files()),
    words: [],
    chats,
  });
  const opened = await readGameZip(zip);
  const restored = opened.project!.chats!.chats[0]!.transcript;
  assert.deepEqual(restored, transcript);
  assert.deepEqual(
    continuationTranscript(
      { provider: "gemini", model: "gemini-4-neon", transcript: restored },
      "gemini",
      "gemini-4-neon",
    ),
    transcript,
  );
  const switchedToOpenAi = continuationTranscript(
    { provider: "gemini", model: "gemini-4-neon", transcript: restored },
    "openai",
    "gpt-6.2-sol",
  );
  assert.ok(!JSON.stringify(switchedToOpenAi).includes("opaque-sig-1"));
  assert.match(JSON.stringify(switchedToOpenAi), /Room 1 looks good/);
  const switchedToGemini = continuationTranscript(
    {
      provider: "openai",
      model: "gpt-6.2-sol",
      transcript: [{ role: "user", content: "Make a lighthouse" }],
    },
    "gemini",
    "gemini-4-neon",
  ) as { role: string; parts: { text: string }[] }[];
  assert.equal(switchedToGemini[0]?.role, "user");
  assert.match(switchedToGemini[0]?.parts[0]?.text ?? "", /Make a lighthouse/);
});

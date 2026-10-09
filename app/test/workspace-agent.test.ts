import { installIndexedDbFixture } from "./indexedDbFixture.ts";
const draftRecords = installIndexedDbFixture();
import { AgentRun } from "../src/agent/agentRun.ts";
import { MODEL_CAPABILITIES } from "../../src/agent/modelEffort.ts";
import { providerSse } from "../../test/provider-stream.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { borrowWorkspaceAgent, createWorkspaceAgent } from "../src/agent/workspaceAgent.ts";
import { useAuthoringController } from "../src/authoring/useAuthoringController.ts";
import { AgentSession } from "../src/agent/agentSession.ts";
import { buildProjectZip } from "../src/archive/projectArchive.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import type { CachedGameData, BootedGame } from "../src/project/gameTypes.ts";
import { migrateAgentChats, readAgentChats, type AgentChats } from "../../src/agent/chats.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import {
  readProjectWorkspace,
  writeProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import { createContainer } from "../../src/container/container.ts";
import { assembleLogic } from "../../src/logic/assembler.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import type { UnifiedConversation, LlmTurnResult } from "../src/agent/llmClient.ts";
import { capturedResourceDocuments } from "../src/agent/agentResultPreview.ts";
import { computeResourceRevision } from "../../src/authoring/resourceRevision.ts";
import { wordsTaskReply } from "../src/studio/workspace/wordsPrompts.ts";

let seq = 0;

for (const mode of ["review", "auto", "background"] as const) {
  for (const failure of ["exit", "tests"] as const) {
    test(`${mode} rejects final admission after finish fails ${failure}`, async () => {
      const { session } = fixture();
      await session.submit({
        proposal: session.model.propose(session.model.capture(), "Room", [
          { key: "logic:1", content: "return;" },
        ]),
        label: "Room",
        origin: "logic",
        author: "creator",
      });
      const before = session.model.capture().documentId;
      const commits = session.history.capture().commits.length;
      const results: { toolCallId: string; result: { success: boolean } }[] = [];
      const call =
        failure === "exit"
          ? {
              id: "edit",
              name: "update_plan",
              input: {
                rooms: [
                  {
                    num: 1,
                    title: "Start",
                    description: "Start",
                    exits: [{ name: "north", room: 2 }],
                  },
                ],
                facts: [],
                quests: [],
              },
            }
          : {
              id: "edit",
              name: "write_game_tests",
              input: {
                mode: "merge",
                names: null,
                tests: [
                  {
                    name: "Impossible score",
                    room: 1,
                    spawnX: null,
                    spawnY: null,
                    steps: [{ action: "wait", ticks: 1 }],
                    expect: { score: 99 },
                    cycleBudget: 100,
                  },
                ],
              },
            };
      let round = 0;
      const agent = createWorkspaceAgent({
        session,
        profileId: "2.936",
        config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
        conversation: () => ({
          setAvailableTools() {},
          getTranscript: () => [],
          async sendUserMessage() {
            return { toolCalls: [call] };
          },
          appendToolResults(entries) {
            results.push(...entries);
            assert.equal(
              entries.find((entry) => entry.toolCallId === "edit")?.result.success ?? true,
              true,
              JSON.stringify(entries),
            );
          },
          async complete() {
            return round++ === 0
              ? { toolCalls: [{ id: "finish", name: "finish", input: { notes: null } }] }
              : { text: "Done", toolCalls: [] };
          },
        }),
      });
      agent.autoApprove = mode === "auto";
      try {
        await assert.rejects(
          mode === "background" ? agent.background("Task", "Edit") : agent.send("Edit"),
          /Handover rejected/,
        );
        assert.equal(results.find((entry) => entry.toolCallId === "finish")?.result.success, false);
        assert.equal(session.model.capture().documentId, before);
        assert.equal(session.history.capture().commits.length, commits);
        assert.equal(agent.pending(), null);
        assert.match(agent.error ?? "", /Handover rejected/);
      } finally {
        session.dispose();
      }
    });
  }
}

test("successful workspace finish ends the tool batch and provider turn", async () => {
  const { session } = fixture();
  const results: {
    toolCallId: string;
    result: { success: boolean; error?: string | undefined };
  }[] = [];
  let completions = 0;
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation: () => ({
      setAvailableTools() {},
      getTranscript: () => [],
      async sendUserMessage() {
        return {
          toolCalls: [
            {
              id: "edit",
              name: "write_picture",
              input: { room: 1, source: "vis 2\nfill 0,0\nend\n" },
            },
            { id: "finish", name: "finish", input: { notes: null } },
            {
              id: "late",
              name: "write_picture",
              input: { room: 1, source: "vis 3\nfill 0,0\nend\n" },
            },
          ],
        };
      },
      appendToolResults(entries) {
        results.push(...entries);
      },
      async complete() {
        completions++;
        return { text: "Done", toolCalls: [] };
      },
    }),
  });
  try {
    await agent.send("Recolor");
    assert.equal(results.find((entry) => entry.toolCallId === "finish")?.result.success, true);
    assert.equal(results.find((entry) => entry.toolCallId === "late")?.result.success, false);
    assert.match(
      results.find((entry) => entry.toolCallId === "late")?.result.error ?? "",
      /successful finish/,
    );
    assert.equal(completions, 0);
    assert.equal(
      agent
        .pending()
        ?.changes()
        .find((change) => change.key === "picture:1")?.content,
      "vis 2\nfill 0,0\nend\n",
    );
  } finally {
    session.dispose();
  }
});

test("partial approval validates the selected candidate's handover", async () => {
  const { session } = fixture();
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Rooms", [
      { key: "logic:1", content: "return;" },
      { key: "logic:2", content: "return;" },
    ]),
    label: "Rooms",
    origin: "logic",
    author: "creator",
  });
  const before = session.model.capture().documentId;
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation: () => ({
      setAvailableTools() {},
      getTranscript: () => [],
      async sendUserMessage() {
        return {
          toolCalls: [
            {
              id: "proposal",
              name: "propose_changes",
              input: {
                label: "Connect",
                changes: [
                  {
                    key: "world",
                    content: JSON.stringify({
                      rooms: { "1": { title: "Start", description: "Start", exits: { north: 2 } } },
                      facts: {},
                      quests: {},
                    }),
                  },
                  { key: "logic:1", content: "new.room(2); return;" },
                ],
              },
            },
          ],
        };
      },
      appendToolResults() {},
      async complete() {
        return { text: "Connected", toolCalls: [] };
      },
    }),
  });
  try {
    await agent.send("Connect rooms");
    assert.ok(agent.pending());
    await assert.rejects(agent.approve(["world"]), /Handover rejected/);
    assert.equal(session.model.capture().documentId, before);
    await agent.approve();
    assert.notEqual(session.model.capture().documentId, before);
  } finally {
    session.dispose();
  }
});
test("offline editing reads native vocabulary and changes the attached room", async () => {
  const { session } = fixture();
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Native room", [
      {
        key: "logic:1",
        content: assembleLogic('if (said(2)) { print("Original response"); } return;', {
          dictionary: new Map(),
        }).payload,
      },
      { key: "words", content: buildWordsTok([{ word: "look", id: 2 }]) },
    ]),
    label: "Native room",
    origin: "logic",
    author: "creator",
  });
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
  });
  await agent.send("Typing look at sign should describe it.", "Current room 1");
  const changes = agent.pending()!.changes();
  assert.match(
    String(changes.find((change) => change.key === "logic:1")?.content),
    /Original response/,
  );
  assert.match(
    String(changes.find((change) => change.key === "logic:1")?.content),
    /said\("look", "sign"\)/,
  );
  assert.ok(
    JSON.parse(String(changes.find((change) => change.key === "words")?.content)).some(
      ([word]: [string, number]) => word === "sign",
    ),
  );
  session.dispose();
});
function fixture(
  chats?: AgentChats,
  roomGeneration = true,
  admissionGate?: () => Promise<void>,
  initial?: CachedGameData,
  beforeApprove?: () => Promise<void>,
) {
  let savedData: CachedGameData | undefined;
  const projectId = initial?.projectId ?? requireProjectId(`agent-test-${++seq}`);
  const documents = {
    "logic:0": "return;",
    "picture:1": "vis 1\nfill 0,0\nend\n",
    words: '[["look",1]]',
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const session = openProjectSession({
    data: initial ?? {
      projectId,
      title: "Test",
      roomGeneration,
      ...(chats ? { chats } : {}),
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [["look", 1]],
      workspace: writeProjectWorkspace(documents),
    },
    lifetime: initial ? "reopened" : "test",
    admission: {
      runToken: initial ? "reopened" : "test",
      async admit() {
        await admissionGate?.();
        return { status: "committed", expected: null, current: null, patchGeneration: 1 };
      },
    },
    async write(request) {
      savedData = {
        ...structuredClone(request.data),
        projectId: request.projectId,
        authoredAt: "",
      };
      return {
        commitId: request.commitId,
        workspaceId: request.workspaceId,
        candidateHash: "a",
        documents: request.documents,
        saved: {
          ...request.expected!,
          generation: request.expected!.generation + 1,
          buildId: request.buildId,
        },
      };
    },
  });
  const sent: string[] = [];
  const resumed: unknown[][] = [];
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    ...(beforeApprove ? { beforeApprove } : {}),
    conversation(_config, transcript): UnifiedConversation {
      resumed.push(structuredClone(transcript));
      const history = [...transcript];
      let instruction = "";
      return {
        setAvailableTools() {},
        async sendUserMessage(text) {
          instruction = text;
          sent.push(text);
          history.push({ role: "user", text });
          return {
            text: "Inspecting the project.",
            toolCalls: [{ id: "read", name: "read_project_context", input: {} }],
          };
        },
        appendToolResults(results) {
          history.push({ role: "assistant", text: JSON.stringify(results) });
        },
        async complete(): Promise<LlmTurnResult> {
          if (history.at(-1) && JSON.stringify(history.at(-1)).includes("Profile"))
            return {
              toolCalls: [
                {
                  id: "change",
                  name: "propose_changes",
                  input: {
                    label: "Welcome sign",
                    changes: instruction.includes("notes lesson")
                      ? [{ key: "notes", content: "Keep the tone friendly.\n" }]
                      : [
                          {
                            key: "logic:0",
                            content: instruction.includes("Make a sign")
                              ? 'print("Revised"); return;'
                              : 'print("Welcome"); return;',
                          },
                          { key: "words", content: '[["look",1],["sign",2]]' },
                          { key: "picture:1", content: "vis 4\nfill 0,0\nend\n" },
                        ],
                  },
                },
              ],
            };
          history.push({ role: "assistant", text: "Added a welcome sign." });
          return { text: "Added a welcome sign.", toolCalls: [] };
        },
        getTranscript() {
          return structuredClone(history);
        },
      };
    },
  });
  return { session, agent, sent, resumed, documents, projectId, saved: () => savedData! };
}
test("one coordinated review selects resources, records a chat checkpoint and undoes all admitted changes", async () => {
  const { session, agent, documents } = fixture();
  await agent.send("Add a welcome sign");
  assert.equal(session.history.capture().commits.length, 1);
  assert.deepEqual(
    agent
      .pending()!
      .changes()
      .map((c) => c.key),
    ["logic:0", "picture:1", "words"],
  );
  const messageId = agent.pending()!.messageId;
  await agent.approve(["logic:0", "picture:1"]);
  assert.equal(agent.reviewOutcome(messageId), "Applied");
  const commit = session.history.capture().commits.at(-1)!;
  assert.equal(commit.author, "agent");
  assert.equal(commit.label, "AI: Welcome sign");
  assert.equal(commit.chatId, agent.current().id);
  assert.ok(commit.messageId);
  assert.equal(session.model.capture().read("words")!.content, documents.words);
  await agent.undoMessage(commit.messageId!);
  assert.equal(session.model.capture().read("logic:0")!.content, documents["logic:0"]);
  assert.equal(session.model.capture().read("picture:1")!.content, documents["picture:1"]);
  session.dispose();
});
test("a committed approval closes review while its chat save is still pending", async () => {
  const { session, agent } = fixture();
  await agent.send("Add a welcome sign");
  const messageId = agent.pending()!.messageId;
  const saveChats = session.saveChats;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let saving!: () => void;
  const started = new Promise<void>((resolve) => (saving = resolve));
  session.saveChats = async (chats) => {
    saving();
    await gate;
    await saveChats(chats);
  };
  let reviewClosed = false;
  const off = agent.subscribe(() => {
    if (agent.pending() === null && agent.reviewOutcome(messageId) === "Applied")
      reviewClosed = true;
  });
  const approval = agent.approve();
  try {
    await started;
    assert.equal(reviewClosed, true, "committed review remains displayed during the chat save");
    assert.equal(agent.busy, true);
  } finally {
    release();
    await approval;
    off();
    session.dispose();
  }
});
test("reject, auto-approve and stale proposals preserve the manual base", async () => {
  const { session, agent } = fixture();
  await agent.send("Add sign");
  const rejected = agent.pending()!.messageId;
  await agent.reject();
  assert.equal(agent.reviewOutcome(rejected), "Rejected");
  assert.equal(session.history.capture().commits.length, 1);
  agent.autoApprove = true;
  await agent.send("Add sign");
  assert.equal(session.history.capture().commits.length, 2);
  const applied = agent.current().messages.find((message) => message.commit)!;
  assert.equal(agent.reviewOutcome(applied.id), "Applied automatically");
  agent.autoApprove = false;
  await agent.send("Make a sign");
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Typing", [
      { key: "logic:0", content: 'print("Manual"); return;' },
    ]),
    label: "Typing",
    origin: "logic",
    author: "creator",
  });
  assert.equal(agent.pending()!.stale(), true);
  await assert.rejects(agent.approve(), /changed/i);
  assert.equal(session.model.capture().read("logic:0")!.content, 'print("Manual"); return;');
  assert.ok(agent.pending());
  session.dispose();
});
for (const mode of ["review", "auto"] as const) {
  for (const refused of [false, true]) {
    test(
      mode +
        " approval saves creator drafts " +
        (refused ? "and holds review on a refused write" : "and updates approved agent changes"),
      async () => {
        const { session, agent, projectId } = fixture(undefined, true, undefined, undefined, () =>
          session.drafts().flush(),
        );
        const id = projectId;
        draftRecords.set(`lifetime/${id}`, {
          projectId: `lifetime/${id}`,
          epoch: "test",
          deleted: false,
        });
        await session.drafts().ready;
        let typed = false;
        agent.subscribe(() => {
          if (agent.pending() && !typed) {
            typed = true;
            session
              .drafts()
              .stage([{ key: "logic:0", content: 'print("Creator typing"); return;' }]);
          }
        });
        const set = draftRecords.set.bind(draftRecords);
        draftRecords.set = (key, value) => {
          if (refused && typeof key === "string" && key.startsWith("part-drafts/"))
            throw new Error("storage refused");
          return set(key, value);
        };
        try {
          agent.autoApprove = mode === "auto";
          await agent.send("Add sign");
          if (mode === "review") {
            if (refused) await assert.rejects(agent.approve(), /storage refused/);
            else await agent.approve();
          }
          assert.equal(Boolean(agent.pending()), refused);
          assert.equal(
            session.history.capture().commits.some((commit) => commit.author === "agent"),
            !refused,
          );
          assert.equal(session.drafts().changes()[0]?.content, 'print("Creator typing"); return;');
          assert.notEqual(
            session.model.capture().read("logic:0")!.content,
            'print("Creator typing"); return;',
          );
        } finally {
          draftRecords.set = set;
          session.dispose();
        }
      },
    );
  }
}
test("New chat isolates requests, resume retains transcript and background tasks keep the active chat", async () => {
  const { session, agent, resumed } = fixture();
  await agent.send("First secret task");
  const first = agent.current().id;
  agent.newChat();
  await agent.send("Second task");
  assert.deepEqual(resumed[1], []);
  const second = agent.current().id;
  agent.resume(first);
  await agent.send("Continue");
  assert.ok(JSON.stringify(resumed[2]).includes("First secret task"));
  agent.resume(second);
  await agent.background("Built room 3", "Build room 3");
  assert.equal(agent.current().id, second);
  assert.ok(agent.chats().some((chat) => chat.title === "Built room 3" && chat.background));
  session.dispose();
});
test("notes are read by every chat, agent updates are versioned, and Restore returns to before a message", async () => {
  const { session, agent, sent } = fixture();
  await agent.send("notes lesson");
  await agent.approve();
  const message = agent.current().messages.at(-1)!.id;
  agent.newChat();
  await agent.send("Read notes");
  assert.ok(sent.at(-1)!.includes("Keep the tone friendly."));
  await agent.restoreBefore(message);
  assert.equal(session.model.capture().read("notes"), undefined);
  session.dispose();
});
test("legacy transcripts and archived model conversations migrate without losing entries", () => {
  const chats = migrateAgentChats({
    provider: "stub",
    model: "stub",
    transcript: [{ role: "user", text: "Add a welcome sign" }],
    conversationHistory: [
      { provider: "stub", model: "old", transcript: [{ role: "user", text: "Earlier task" }] },
    ],
  });
  assert.equal(chats.chats.length, 2);
  assert.equal(chats.chats[0]!.title, "Add a welcome sign");
  assert.equal(chats.chats[1]!.archived, true);
  assert.equal(chats.chats[0]!.messages[0]!.text, "Add a welcome sign");
  const responses = migrateAgentChats({
    provider: "openai",
    model: "example",
    transcript: [
      { role: "user", content: [{ type: "input_text", text: "Add a welcome sign" }] },
      { role: "assistant", content: [{ type: "output_text", text: "Added a sign." }] },
    ],
  });
  assert.equal(responses.chats[0]!.title, "Add a welcome sign");
  assert.equal(responses.chats[0]!.messages[1]!.text, "Added a sign.");
});

test("model switch continues with a summary handoff and keeps thinking blocks away from the new model", async () => {
  const { session } = fixture();
  let model = "first";
  const offered: unknown[][] = [];
  const requests: string[] = [];
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "openai", model, apiKey: "" }),
    conversation(_config, transcript) {
      offered.push(transcript);
      const history = [...transcript];
      return {
        setAvailableTools() {},
        async sendUserMessage(text) {
          requests.push(text);
          history.push({ role: "user", content: text });
          if (text.includes("compaction summary pattern"))
            return { text: "Objective: add a sign. Next: revise the wording.", toolCalls: [] };
          history.push(
            { type: "reasoning", summary: [], encrypted_content: "private-thinking" },
            { role: "assistant", content: [{ type: "output_text", text: "Done" }] },
          );
          return { text: "Done", toolCalls: [] };
        },
        appendToolResults() {},
        async complete() {
          return { toolCalls: [] };
        },
        getTranscript() {
          return history;
        },
      };
    },
  });
  await agent.send("Add a sign");
  model = "second";
  await agent.send("Continue");
  assert.ok(requests.some((text) => text.includes("compaction summary pattern")));
  assert.ok(JSON.stringify(offered.at(-1)).includes("Objective: add a sign"));
  assert.ok(!JSON.stringify(offered.at(-1)).includes("private-thinking"));
  assert.ok(agent.current().summary);
  assert.ok(
    agent
      .chats()
      .some(
        (chat) => chat.archived && JSON.stringify(chat.transcript).includes("private-thinking"),
      ),
  );
  session.dispose();
});

test("whole-game tools stage Add depth and deduplicated notes in one project commit", async () => {
  const { session } = fixture();
  const picture = '# @item tree "Tree" art\nvis 2\nrect 20,20 30,30\nfill 25,25\n# @end\nend\n';
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Tree", [
      { key: "picture:1", content: picture },
    ]),
    label: "Tree",
    origin: "picture",
    author: "creator",
  });
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "offline-stub", apiKey: "" }),
    conversation() {
      let revision = "";
      let round = 0;
      return {
        setAvailableTools() {},
        async sendUserMessage() {
          return {
            toolCalls: [
              { id: "read", name: "read_picture", input: { num: 1, offset: null, limit: null } },
            ],
          };
        },
        appendToolResults(results) {
          assert.ok(
            results.every((entry) => entry.result.success),
            JSON.stringify(results),
          );
          if (results[0]?.toolCallId === "read")
            revision = String(results[0].result.details?.["revision"]);
        },
        async complete() {
          if (round++ === 0)
            return {
              toolCalls: [
                {
                  id: "depth",
                  name: "add_depth",
                  input: {
                    num: 1,
                    itemId: "tree",
                    expectedRevision: revision,
                    baseY: 30,
                    priorityBase: null,
                  },
                },
                {
                  id: "notes",
                  name: "write_notes",
                  input: { text: "Keep the tone friendly.\nKeep the tone friendly." },
                },
              ],
            };
          return { text: "Added depth.", toolCalls: [] };
        },
        getTranscript() {
          return [];
        },
      };
    },
  });
  await agent.send("Add depth to the tree");
  assert.deepEqual(
    agent
      .pending()!
      .changes()
      .map((change) => change.key),
    ["notes", "picture:1"],
  );
  await agent.approve();
  const source = session.model.capture().read("picture:1")!.content;
  assert.equal(typeof source, "string");
  assert.ok(String(source).includes("# @depth base=30"));
  assert.equal(session.model.capture().read("notes")!.content, "Keep the tone friendly.\n");
  await session.undo();
  assert.equal(session.model.capture().read("picture:1")!.content, picture);
  assert.equal(session.model.capture().read("notes"), undefined);
  session.dispose();
});

test("review belongs to its task chat when switching chats", async () => {
  const { session, agent } = fixture();
  await agent.send("Add sign");
  const first = agent.current().id;
  const pending = agent.pending();
  agent.newChat();
  assert.equal(agent.pending(), null);
  agent.resume(first);
  assert.equal(agent.pending(), pending);
  session.dispose();
});

test("auto-approve admits each proposal before the next tool round", async () => {
  const { session } = fixture();
  let round = 0;
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation() {
      return {
        setAvailableTools() {},
        async sendUserMessage() {
          return {
            toolCalls: [
              {
                id: "first",
                name: "propose_changes",
                input: {
                  label: "First",
                  changes: [{ key: "logic:0", content: 'print("First"); return;' }],
                },
              },
            ],
          };
        },
        appendToolResults(results) {
          assert.ok(
            results.every((entry) => entry.result.success),
            JSON.stringify(results),
          );
        },
        async complete() {
          assert.equal(session.history.capture().commits.length, round + 2);
          if (round++ === 0)
            return {
              toolCalls: [
                {
                  id: "second",
                  name: "propose_changes",
                  input: {
                    label: "Second",
                    changes: [{ key: "picture:1", content: "vis 5\nfill 0,0\nend\n" }],
                  },
                },
              ],
            };
          return { text: "Finished.", toolCalls: [] };
        },
        getTranscript() {
          return [];
        },
      };
    },
  });
  agent.autoApprove = true;
  await agent.send("Two changes");
  assert.equal(session.history.capture().commits.length, 3);
  assert.equal(agent.current().messages.filter((message) => message.commit).length, 2);
  assert.equal(session.model.capture().read("logic:0")!.content, 'print("First"); return;');
  session.dispose();
});

test("native resource tools and document proposals share one coordinated review", async () => {
  const { session } = fixture();
  let round = 0;
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation() {
      return {
        setAvailableTools() {},
        async sendUserMessage() {
          return {
            toolCalls: [
              { id: "notes", name: "write_notes", input: { text: "Friendly tone." } },
              { id: "read", name: "read_picture", input: { num: 1, offset: null, limit: null } },
            ],
          };
        },
        appendToolResults(results) {
          assert.ok(
            results.every((entry) => entry.result.success),
            JSON.stringify(results),
          );
        },
        async complete() {
          if (round++ === 0)
            return {
              toolCalls: [
                {
                  id: "pic",
                  name: "write_picture",
                  input: { room: 1, source: "vis 6\nfill 0,0\nend\n" },
                },
              ],
            };
          if (round === 2)
            return {
              toolCalls: [
                {
                  id: "logic",
                  name: "propose_changes",
                  input: {
                    label: "Together",
                    changes: [{ key: "logic:0", content: 'print("Together"); return;' }],
                  },
                },
              ],
            };
          return { toolCalls: [] };
        },
        getTranscript() {
          return [];
        },
      };
    },
  });
  await agent.send("Change picture and logic");
  assert.deepEqual(
    agent
      .pending()!
      .changes()
      .map((change) => change.key),
    ["logic:0", "notes", "picture:1"],
  );
  session.dispose();
});

test("background authoring hydrates current project documents before staging a room", async () => {
  const { session } = fixture();
  const { AgentSession } = await import("../src/agent/agentSession.ts");
  const { refreshProjectAgent, submitAgentState } = await import("../src/agent/projectTurn.ts");
  const author = new AgentSession({ provider: "stub", model: "stub", apiKey: "" }, () => {});
  await author.startGenesis("A garden");
  const { readProjectDocuments } = await import("../../src/authoring/projectDocuments.ts");
  const documents = readProjectDocuments({
    files: Object.fromEntries(author.state.getFiles()),
    profileId: "2.936",
  }).documents;
  await session.submit({
    proposal: session.model.propose(
      session.model.capture(),
      "Seed",
      Object.entries(documents).map(([key, content]) => ({ key, content })),
    ),
    label: "Seed",
    author: "creator",
    origin: "logic",
  });
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Typed", [
      { key: "logic:0", content: 'print("Creator text"); return;' },
    ]),
    label: "Typed",
    author: "creator",
    origin: "logic",
  });
  const base = refreshProjectAgent(session, author.state, "2.936");
  await author.handle({ op: "room", context: { room: 2, from: 1 } });
  await submitAgentState({
    session,
    base,
    state: author.state,
    profileId: "2.936",
    label: "Built room 2",
    chatId: "background",
    messageId: "result",
  });
  assert.equal(session.model.capture().read("logic:0")!.content, 'print("Creator text"); return;');
  assert.ok(session.model.capture().read("logic:2"));
  assert.equal(session.history.capture().commits.at(-1)!.chatId, "background");
  session.dispose();
});

test("Ask continues the current task chat with read-only tools and game notes", async () => {
  const { session } = fixture();
  let allowed: readonly string[] = [];
  let prompt = "";
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Notes", [
      { key: "notes", content: "Friendly hints." },
    ]),
    label: "Notes",
    author: "creator",
    origin: "logic",
  });
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation() {
      return {
        setAvailableTools(names) {
          allowed = names ?? [];
        },
        async sendUserMessage(text) {
          prompt = text;
          return { text: "Try looking around.", toolCalls: [] };
        },
        appendToolResults() {},
        async complete() {
          return { toolCalls: [] };
        },
        getTranscript() {
          return [{ role: "user", text: prompt }];
        },
      };
    },
  });
  const first = agent.current().id;
  assert.equal(
    await agent.ask("Where next?", "Room 1\nReturn concise hints."),
    "Try looking around.",
  );
  assert.equal(agent.current().id, first);
  assert.deepEqual(agent.current().messages[0], {
    id: agent.current().messages[0]!.id,
    request: agent.current().messages[0]!.request,
    role: "user",
    text: "Where next?",
    context: "Room 1\nReturn concise hints.",
  });
  assert.ok(prompt.includes("Friendly hints."));
  assert.ok(
    !allowed.includes("propose_changes") &&
      !allowed.includes("write_notes") &&
      allowed.includes("read_room"),
  );
  session.dispose();
});

test("Ask stores a formatted reply with raw context and keeps ordinary follow-ups readable", async () => {
  const { session } = fixture();
  const raw = '{"synonyms":["inspect"]}';
  let reply = raw;
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation() {
      return {
        setAvailableTools() {},
        async sendUserMessage() {
          return { text: reply, toolCalls: [] };
        },
        appendToolResults() {},
        async complete() {
          return { toolCalls: [] };
        },
        getTranscript() {
          return [{ role: "assistant", text: reply }];
        },
      };
    },
  });
  assert.equal(
    await agent.ask("Suggest words for look", "WORDS", (text) =>
      wordsTaskReply(text, { kind: "suggest", group: 100, words: ["look"] }),
    ),
    "Suggested inspect",
  );
  const message = agent.current().messages.at(-1)!;
  assert.deepEqual(message, {
    id: message.id,
    taskId: agent.current().messages[0]!.request!.id,
    spend: { amount: 0, budget: 5, priceKnown: false, incomplete: false },
    role: "assistant",
    text: "Suggested inspect",
    context: raw,
  });
  assert.deepEqual(session.chats().chats[0]!.messages.at(-1), message);
  assert.deepEqual(agent.current().transcript, [{ role: "assistant", text: raw }]);
  assert.deepEqual(agent.progress, ["Suggested inspect"]);
  reply = "Try looking around.";
  await agent.ask("Where next?");
  assert.equal(agent.current().messages.at(-1)!.text, reply);
  assert.equal(agent.current().messages.at(-1)!.context, undefined);
  session.dispose();
});

test("approval keeps its checkpoint when project observers refresh the review", async () => {
  const { session, agent } = fixture();
  await agent.send("Add sign");
  let refreshed = false;
  const off = agent.subscribe(() => {
    if (!refreshed && session.history.capture().commits.length === 2) {
      refreshed = true;
      agent.reject();
    }
  });
  await agent.approve();
  assert.ok(
    agent.current().messages.some((message) => message.commit === session.history.capture().cursor),
  );
  off();
  session.dispose();
});

test("Genesis records the created game as an agent History entry tied to its first chat", () => {
  const { session } = fixture({
    format: "monotio.agi.chats",
    version: 1,
    active: "genesis",
    chats: [
      {
        id: "genesis",
        title: "Created Test",
        provider: "stub",
        model: "stub",
        transcript: [],
        messages: [{ id: "created", role: "assistant", text: "Created Test" }],
      },
    ],
  });
  const first = session.history.capture().commits[0]!;
  assert.equal(first.author, "agent");
  assert.equal(first.label, "AI: Created Test");
  assert.equal(first.chatId, "genesis");
  assert.equal(first.messageId, "created");
  session.dispose();
});

test("imported projects require complete room references before offering an agent proposal", async () => {
  const { session } = fixture(undefined, false);
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation() {
      return {
        setAvailableTools() {},
        async sendUserMessage() {
          return {
            toolCalls: [
              {
                id: "missing",
                name: "propose_changes",
                input: {
                  label: "Missing room",
                  changes: [{ key: "logic:0", content: "new.room(3); return;" }],
                },
              },
            ],
          };
        },
        appendToolResults(results) {
          assert.equal(results[0]!.result.success, false);
        },
        async complete() {
          return { text: "Room 3 needs resources.", toolCalls: [] };
        },
        getTranscript() {
          return [];
        },
      };
    },
  });
  await agent.send("Add an exit");
  assert.equal(agent.pending(), null);
  assert.equal(session.history.capture().commits.length, 1);
  session.dispose();
});

test("settings, recordings and successive plan edits retain the owned writer and editor documents", async () => {
  let holding = false;
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admission = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { session } = fixture(undefined, true, async () => {
    if (holding) {
      entered();
      await blocked;
    }
  });
  const files = Object.fromEntries(session.model.capture().lastAdmissibleBuild!.files());
  const game: BootedGame = {
    installed: false,
    projectId: requireProjectId("settings-project"),
    title: "Test",
    revision: session.model.capture().lastAdmissibleBuild!.identity.revision,
    files,
    words: [["look", 1]],
  };
  const logs: string[] = [];
  const state = {
    phase: "running" as const,
    powerUp: {
      mode: "remix" as const,
      messages: [],
      open: false,
      needsConfig: false,
      busy: false,
      feedStart: 0,
      reply: "",
      room: 1,
      error: "",
    },
    agentTask: null,
    agentLog: [],
    profile: "2.936",
    worldTick: 0,
    planDurableRev: "",
  };
  const config = { provider: "stub" as const, model: "first", apiKey: "" };
  const controller = useAuthoringController({
    state,
    getProjectSession: () => session,
    getWorker: () => null,
    query: async () => assert.fail("Settings need no worker query"),
    logAgent: (_kind, text) => logs.push(text),
    readFrames: async () => [],
    pauseEngine: () => {},
    resumeEngine: () => {},
    getBootedGame: () => game,
    setBootedGame: () => {},
    flushAutosave: async () => {},
    getAutosaveWrite: async () => true,
    clearAutosave: () => {},
    awaitPatched: async () => assert.fail("Settings install no resources"),
  });
  controller.setSession(AgentSession.fromAuthoredData(config, () => {}, files, game.words));
  const proposal = session.model.propose(session.model.capture(), "Typing", [
    { key: "logic:0", content: 'print("Current typing"); return;' },
  ]);
  await session.submit({ proposal, label: "Typing", origin: "logic", author: "creator" });
  await controller.updateAiConfig({ ...config, model: "second" });
  assert.deepEqual(
    logs,
    [],
    "settings must use the owned writer instead of a parallel storage write",
  );
  assert.equal(state.powerUp.error, "");
  assert.equal(
    session.model.capture().read("logic:0")!.content,
    'print("Current typing"); return;',
  );
  const author = controller.getSession()!;
  const tests = new TextEncoder().encode('{"format":"monotio.agi.tests.v1","tests":[]}');
  await controller.commitTestsFile(game, author, tests);
  assert.equal(session.model.capture().read("tests")!.content, new TextDecoder().decode(tests));
  assert.equal(session.history.capture().commits.at(-1)!.label, "Recorded test");
  const exported = controller.assembleExportData(
    {
      projectId: game.projectId!,
      title: game.title,
      authoredAt: "",
      files,
      words: game.words,
    },
    game,
    author,
    files,
  );
  assert.deepEqual(exported.files["TESTS.JSON"], tests);
  const { refreshProjectAgent } = await import("../src/agent/projectTurn.ts");
  refreshProjectAgent(session, author.state, "2.936");
  holding = true;
  author.state.authoring.world.rooms["2"] = {
    title: "The Gallery",
    description: "A long hall with a locked door.",
    exits: {},
  };
  const nameSaved = controller.persistSessionState();
  await Promise.race([
    admission,
    nameSaved.then(() => assert.fail("Plan edit waits for admission")),
  ]);
  author.state.authoring.world.rooms["2"]!.description = "A long gallery of portraits.";
  const briefSaved = controller.persistSessionState();
  refreshProjectAgent(session, author.state, "2.936");
  release();
  const saved = await Promise.all([nameSaved, briefSaved]);
  const world = JSON.parse(String(session.model.capture().read("world")!.content));
  assert.equal(world.rooms["2"]?.title, "The Gallery");
  assert.equal(world.rooms["2"]?.description, "A long gallery of portraits.");
  assert.equal(saved[1], true, "the latest plan edit is durable");
  assert.equal(
    session.model.capture().read("logic:0")!.content,
    'print("Current typing"); return;',
  );
  session.dispose();
});

test("resuming a background task uses the current Review mode for a user follow-up", async () => {
  const { session, agent } = fixture();
  await agent.background("Built room 3", "Build room 3");
  const task = agent.chats().find((chat) => chat.background)!;
  const before = session.history.capture().commits.length;
  agent.resume(task.id);
  await agent.send("notes lesson");
  assert.equal(agent.autoApprove, false);
  assert.ok(agent.pending(), "a resumed background entry follows the user's Review mode");
  assert.equal(session.history.capture().commits.length, before);
  assert.equal(session.model.capture().read("notes"), undefined);
  await agent.approve();
  assert.equal(session.history.capture().commits.length, before + 1);
  session.dispose();
});

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider} cancellation in the tool notification prevents auto-approval`, async (t) => {
    const { session } = fixture();
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          providerSse(
            provider,
            provider === "openai"
              ? {
                  id: "r",
                  output: [
                    {
                      type: "function_call",
                      call_id: "n",
                      name: "write_notes",
                      arguments: JSON.stringify({ text: "Cancelled notes" }),
                    },
                    {
                      type: "function_call",
                      call_id: "p",
                      name: "propose_changes",
                      arguments: JSON.stringify({
                        label: "Cancelled",
                        changes: [{ key: "notes", content: "Cancelled notes" }],
                      }),
                    },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1 },
                }
              : {
                  id: "r",
                  type: "message",
                  role: "assistant",
                  stop_reason: "tool_use",
                  content: [
                    {
                      type: "tool_use",
                      id: "n",
                      name: "write_notes",
                      input: { text: "Cancelled notes" },
                    },
                    {
                      type: "tool_use",
                      id: "p",
                      name: "propose_changes",
                      input: {
                        label: "Cancelled",
                        changes: [{ key: "notes", content: "Cancelled notes" }],
                      },
                    },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const agent = createWorkspaceAgent({
      session,
      profileId: "2.936",
      config: () => ({
        provider,
        model: provider === "openai" ? "gpt-6-sol" : "claude-opus-5-5",
        apiKey: "offline",
      }),
    });
    agent.autoApprove = true;
    agent.subscribe(() => {
      if (agent.progress.at(-1) === "Propose changes") agent.cancel();
    });
    await assert.rejects(agent.send("Change notes"), /cancel/i);
    assert.equal(session.model.capture().read("notes"), undefined);
    assert.equal(session.history.capture().commits.length, 1);
    assert.equal(agent.pending(), null);
    session.dispose();
  });
}

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider} workspace charges production adapter usage exactly once`, async (t) => {
    const { session } = fixture();
    const model = provider === "openai" ? "gpt-6-sol" : "claude-opus-5-5";
    let spent = 0;
    const usage = t.mock.method(AgentRun.prototype, "recordStreamUsage");
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          providerSse(
            provider,
            provider === "openai"
              ? {
                  id: "r",
                  output: [
                    {
                      type: "message",
                      role: "assistant",
                      content: [{ type: "output_text", text: "Done." }],
                    },
                  ],
                  usage: { input_tokens: 1000, output_tokens: 100 },
                }
              : {
                  id: "r",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "text", text: "Done." }],
                  usage: { input_tokens: 1000, output_tokens: 100 },
                },
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const agent = createWorkspaceAgent({
      session,
      profileId: "2.936",
      config: () => ({ provider, model, apiKey: "offline" }),
    });
    agent.subscribe(() => {
      spent = Math.max(spent, agent.task?.spent ?? 0);
    });
    await agent.send("Describe the project");
    const rate = MODEL_CAPABILITIES[model]!.price!;
    assert.equal(usage.mock.callCount(), provider === "anthropic" ? 2 : 1);
    assert.equal(spent, (1000 * rate.input + 100 * rate.output) / 1e6);
    session.dispose();
  });
}

for (const provider of ["openai", "anthropic"] as const) {
  function reply(content: { name: string; input: Record<string, unknown> } | string) {
    return providerSse(
      provider,
      provider === "openai"
        ? {
            id: "r",
            output:
              typeof content === "string"
                ? [
                    {
                      type: "message",
                      role: "assistant",
                      content: [{ type: "output_text", text: content }],
                    },
                  ]
                : [
                    {
                      type: "function_call",
                      call_id: "p",
                      name: content.name,
                      arguments: JSON.stringify(content.input),
                    },
                  ],
          }
        : {
            id: "r",
            role: "assistant",
            type: "message",
            stop_reason: typeof content === "string" ? "end_turn" : "tool_use",
            content:
              typeof content === "string"
                ? [{ type: "text", text: content }]
                : [{ type: "tool_use", id: "p", name: content.name, input: content.input }],
          },
    );
  }
  function settings() {
    return {
      provider,
      model: provider === "openai" ? "gpt-6-sol" : "claude-opus-5-5",
      apiKey: "offline",
    };
  }
  test(`${provider} dropped response records a truthful interruption after staged notes`, async (t) => {
    const { session } = fixture();
    let requests = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          ++requests === 1 ? reply({ name: "write_notes", input: { text: "Staged lesson" } }) : "",
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const agent = createWorkspaceAgent({ session, profileId: "2.936", config: settings });
    await assert.rejects(agent.send("Write notes"), /stream|message|chunks/i);
    const text = JSON.stringify(agent.current().transcript);
    assert.match(text, /monotio.agi.user-action/);
    assert.match(text, /interruption/);
    assert.match(text, /discarded/);
    assert.equal(session.model.capture().read("notes"), undefined);
    assert.equal(agent.pending(), null);
    session.dispose();
  });
  test(`${provider} pending review survives reconstruction and decisions reach replay`, async (t) => {
    let { session, saved } = fixture();
    let requests = 0;
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        reply(
          ++requests === 1
            ? {
                name: "propose_changes",
                input: { label: "Notes", changes: [{ key: "notes", content: "Lesson" }] },
              }
            : "Ready.",
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const options = { session, profileId: "2.936" as const, config: settings };
    const first = createWorkspaceAgent(options);
    await first.send("Write a lesson");
    await session.flush();
    const stored = saved();
    const archived = await readGameZip(await buildProjectZip(stored));
    assert.deepEqual(archived.project?.chats, stored.chats);
    session = fixture(undefined, true, undefined, stored).session;
    const reopened = createWorkspaceAgent({ ...options, session });
    assert.ok(reopened.pending(), "pending proposal must reopen");
    assert.equal(reopened.pending()!.stale(), false);
    assert.ok(
      reopened.pending()!.proposal.base.lastAdmissibleBuild,
      "review previews need their saved base image",
    );
    assert.equal(reopened.current().pendingReview?.baseRevision, 0);
    await reopened.approve(["notes"]);
    assert.equal(reopened.current().pendingReview, undefined);
    assert.match(JSON.stringify(reopened.current().transcript), /approve/);
    const message = reopened.current().messages.find((entry) => entry.commit)!;
    await reopened.undoMessage(message.id);
    await reopened.restoreBefore(message.id);
    await reopened.send("What changed?");
    assert.match(JSON.stringify(bodies.at(-1)), /monotio.agi.user-action/);
    assert.match(JSON.stringify(bodies.at(-1)), /undo/);
    assert.match(JSON.stringify(bodies.at(-1)), /restore/);
    session.dispose();
  });
  test(`${provider} restored pending review detects a moved base and rejection is saved`, async (t) => {
    const { session } = fixture();
    let requests = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          reply(
            ++requests === 1
              ? {
                  name: "propose_changes",
                  input: { label: "Notes", changes: [{ key: "notes", content: "Lesson" }] },
                }
              : "Ready.",
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const options = { session, profileId: "2.936" as const, config: settings };
    const agent = createWorkspaceAgent(options);
    await agent.send("Write a lesson");
    await session.submit({
      proposal: session.model.propose(session.model.capture(), "Typing", [
        { key: "notes", content: "Human lesson" },
      ]),
      label: "Typing",
      origin: "logic",
      author: "creator",
    });
    const reopened = createWorkspaceAgent(options);
    assert.ok(reopened.pending());
    assert.equal(reopened.pending()!.stale(), true);
    await assert.rejects(reopened.approve(), /project changed/i);
    await reopened.reject();
    const again = createWorkspaceAgent(options);
    assert.equal(again.pending(), null);
    assert.match(JSON.stringify(again.current().transcript), /reject/);
    session.dispose();
  });
}

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider} chat session identity stays stable across turns and reconstruction`, async (t) => {
    const { session } = fixture();
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        providerSse(
          provider,
          provider === "openai"
            ? {
                id: `r${bodies.length}`,
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: "Done" }],
                  },
                ],
              }
            : {
                id: `r${bodies.length}`,
                role: "assistant",
                type: "message",
                content: [{ type: "text", text: "Done" }],
              },
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const options = {
      session,
      profileId: "2.936" as const,
      config: () => ({
        provider,
        model: provider === "openai" ? "gpt-6-sol" : "claude-opus-5-5",
        apiKey: "offline",
      }),
    };
    const first = createWorkspaceAgent(options);
    await first.send("Hello");
    await first.send("Continue");
    const resumed = createWorkspaceAgent(options);
    await resumed.send("Continue again");
    const keys = bodies.map((body) =>
      provider === "openai"
        ? body["prompt_cache_key"]
        : (body["metadata"] as { user_id?: string } | undefined)?.user_id,
    );
    assert.ok(keys[0]);
    assert.deepEqual(keys, [keys[0], keys[0], keys[0]]);
    assert.ok(resumed.current().sessionId);
    resumed.newChat();
    await resumed.send("Another task");
    const last = bodies.at(-1)!;
    assert.notEqual(
      provider === "openai"
        ? last["prompt_cache_key"]
        : (last["metadata"] as { user_id: string }).user_id,
      keys[0],
    );
    session.dispose();
  });
}

test("workspace presents commentary separately and stores the final answer", async (t) => {
  const { session } = fixture();
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        providerSse("openai", {
          id: "r",
          output: [
            {
              type: "message",
              id: "c",
              role: "assistant",
              phase: "commentary",
              content: [{ type: "output_text", text: "Checking." }],
            },
            {
              type: "message",
              id: "f",
              role: "assistant",
              phase: "final_answer",
              content: [{ type: "output_text", text: "Done." }],
            },
          ],
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "openai", model: "gpt-6-sol", apiKey: "offline" }),
  });
  await agent.send("Inspect");
  assert.deepEqual(agent.progress, ["Checking.", "Done."]);
  assert.equal(agent.current().messages.at(-1)?.text, "Done.");
  session.dispose();
});

function actions(transcript: unknown[]): Record<string, unknown>[] {
  return transcript.flatMap((item) => {
    const record = item as Record<string, unknown>;
    const text = record["text"] ?? record["content"];
    if (
      record["role"] !== "user" ||
      typeof text !== "string" ||
      !text.startsWith('{"format":"monotio.agi.user-action"')
    )
      return [];
    return [JSON.parse(text) as Record<string, unknown>];
  });
}
for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider} interruption distinguishes applied commits from discarded later staging`, async (t) => {
    const { session } = fixture();
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      const step = ++requests;
      const name = step === 1 ? "propose_changes" : "write_notes";
      const input =
        step === 1
          ? { label: "Kept", changes: [{ key: "notes", content: "Kept" }] }
          : { text: "Discarded" };
      return new Response(
        step > 2
          ? ""
          : providerSse(
              provider,
              provider === "openai"
                ? {
                    id: `r${step}`,
                    output: [
                      {
                        type: "function_call",
                        call_id: `p${step}`,
                        name,
                        arguments: JSON.stringify(input),
                      },
                    ],
                  }
                : {
                    id: `r${step}`,
                    role: "assistant",
                    type: "message",
                    stop_reason: "tool_use",
                    content: [{ type: "tool_use", id: `p${step}`, name, input }],
                  },
            ),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const agent = createWorkspaceAgent({
      session,
      profileId: "2.936",
      config: () => ({
        provider,
        model: provider === "openai" ? "gpt-6-sol" : "claude-opus-5-5",
        apiKey: "offline",
      }),
    });
    agent.autoApprove = true;
    await assert.rejects(agent.send("Write notes"), /stream|message|chunks/i);
    assert.equal(session.model.capture().read("notes")?.content, "Kept");
    const events = actions(agent.current().transcript);
    assert.equal(events[0]?.["decision"], "approve");
    assert.deepEqual(events[0]?.["resources"], ["notes"]);
    const interruption = events.at(-1)!;
    assert.deepEqual(interruption["discarded"], ["notes"]);
    assert.deepEqual(interruption["persisted"], [
      {
        resources: ["notes"],
        documentId: session.model.capture().documentId,
        commit: session.history.capture().cursor,
      },
    ]);
    assert.deepEqual(interruption["resultingRevision"], {
      documentId: session.model.capture().documentId,
      revision: session.model.capture().revision,
      commit: session.history.capture().cursor,
    });
    session.dispose();
  });
}

test("legacy chat migration retains the released provider session identity", () => {
  const chats = migrateAgentChats({
    provider: "openai",
    model: "gpt-6-sol",
    sessionId: "released-session",
    transcript: [{ role: "user", content: "Continue" }],
  });
  assert.equal(chats.chats[0]?.sessionId, "released-session");
});

test("restored reviews verify the saved base against its claimed identity", async () => {
  const { session, agent } = fixture();
  await agent.send("Add a welcome sign");
  const chats = session.chats();
  const pending = chats.chats[0]!.pendingReview!;
  const forged = {
    ...pending,
    base: writeProjectWorkspace({
      ...readProjectWorkspace(pending.base),
      "logic:0": 'print("Forged base"); return;',
    }),
  };
  chats.chats[0]!.pendingReview = forged;
  await session.saveChats(chats);
  const reopened = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
  });
  assert.equal(reopened.pending()!.stale(), true);
  await assert.rejects(reopened.approve(), /project changed/i);
  session.dispose();
});

for (const provider of ["openai", "anthropic"] as const) {
  test(`${provider} interruption retains the applied identity when a human edit follows approval`, async (t) => {
    const { session } = fixture();
    let appliedDocument = "";
    let appliedCommit = "";
    let human: Promise<unknown> | undefined;
    session.subscribe(() => {
      if (session.history.capture().commits.length === 2 && !appliedCommit) {
        appliedDocument = session.model.capture().documentId;
        appliedCommit = session.history.capture().cursor!;
        human = session.submit({
          proposal: session.model.propose(session.model.capture(), "Human", [
            { key: "words", content: '[["look",1],["human",2]]' },
          ]),
          label: "Human",
          origin: "words",
          author: "creator",
        });
      }
    });
    let requests = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          ++requests > 1
            ? ""
            : providerSse(
                provider,
                provider === "openai"
                  ? {
                      id: "r",
                      output: [
                        {
                          type: "function_call",
                          call_id: "p",
                          name: "propose_changes",
                          arguments: JSON.stringify({
                            label: "Kept",
                            changes: [{ key: "notes", content: "Kept" }],
                          }),
                        },
                      ],
                    }
                  : {
                      id: "r",
                      role: "assistant",
                      type: "message",
                      stop_reason: "tool_use",
                      content: [
                        {
                          type: "tool_use",
                          id: "p",
                          name: "propose_changes",
                          input: { label: "Kept", changes: [{ key: "notes", content: "Kept" }] },
                        },
                      ],
                    },
              ),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const agent = createWorkspaceAgent({
      session,
      profileId: "2.936",
      config: () => ({
        provider,
        model: provider === "openai" ? "gpt-6-sol" : "claude-opus-5-5",
        apiKey: "offline",
      }),
    });
    agent.autoApprove = true;
    await assert.rejects(agent.send("Write notes"), /stream|message|chunks/i);
    await human;
    assert.notEqual(session.model.capture().documentId, appliedDocument);
    assert.deepEqual(actions(agent.current().transcript).at(-1)?.["persisted"], [
      { resources: ["notes"], documentId: appliedDocument, commit: appliedCommit },
    ]);
    session.dispose();
  });
}

test("a completed $0.402 reply fits a $0.60 budget without reserving another request", async (t) => {
  const { session } = fixture();
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        providerSse("openai", {
          id: "r",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Done." }],
            },
          ],
          usage: { input_tokens: 201000, output_tokens: 0 },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "openai", model: "gpt-6-sol", apiKey: "offline", budgetUsd: 0.6 }),
  });
  let spent = 0;
  let paused = false;
  agent.subscribe(() => {
    spent = Math.max(spent, agent.task?.spent ?? 0);
    if (agent.task?.status === "paused") {
      paused = true;
      agent.cancel();
    }
  });
  try {
    await agent.send("Describe the project");
    assert.equal(paused, false);
    assert.equal(spent, 0.402);
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(agent.current().messages.at(-1)?.text, "Done.");
  } finally {
    session.dispose();
  }
});

test("a shared agent first opened for questions adopts the editor approval drain", async () => {
  const { session } = fixture();
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Room", [
      { key: "logic:1", content: 'print("Room"); return;' },
    ]),
    label: "Room",
    origin: "logic",
    author: "creator",
  });
  const options = {
    session,
    profileId: "2.936" as const,
    config: () => ({ provider: "stub" as const, model: "stub", apiKey: "" }),
  };
  const first = borrowWorkspaceAgent(options);
  let drains = 0;
  const panel = borrowWorkspaceAgent({
    ...options,
    beforeApprove: async () => {
      drains++;
      throw new Error("Pending editor buffer");
    },
  });
  assert.equal(panel, first);
  await panel.send("Add sign");
  assert.ok(panel.pending());
  await assert.rejects(panel.approve(), /Pending editor buffer/);
  assert.equal(drains, 1);
  assert.ok(panel.pending());
  session.dispose();
});

test("completed spend stays with its chat when another chat is opened", async () => {
  const { session } = fixture();
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "openai", model: "gpt-6-sol", apiKey: "placeholder" }),
    conversation(_config, transcript, run) {
      return {
        setAvailableTools() {},
        appendToolResults() {},
        getTranscript: () => transcript,
        async sendUserMessage() {
          return run.request(async () => {
            run.recordUsage({ input: 10000, cachedInput: 0, cacheWriteInput: 0, output: 5000 });
            return { text: "Ready.", toolCalls: [] };
          });
        },
        async complete() {
          return { text: "Ready.", toolCalls: [] };
        },
      };
    },
  });
  await agent.send("Describe the room.");
  const chat = agent.chats()[0]!;
  assert.equal(agent.task?.status, "idle");
  assert.equal(agent.task?.reportedSpent, 0.07);
  agent.newChat();
  const freshTask = agent.task;
  assert.equal(freshTask, null);
  agent.resume(chat.id);
  assert.equal(agent.task?.reportedSpent, 0.07);
  session.dispose();
});

for (const failed of [false, true])
  test(`background task keeps its identity and spend until final save ${failed ? "fails" : "finishes"}`, async () => {
    const { session } = fixture();
    let requests = 0;
    const agent = createWorkspaceAgent({
      session,
      profileId: "2.936",
      config: () => ({ provider: "openai", model: "gpt-6-sol", apiKey: "placeholder" }),
      conversation(_config, transcript, run) {
        return {
          setAvailableTools() {},
          appendToolResults() {},
          getTranscript: () => transcript,
          async sendUserMessage() {
            return run.request(async () => {
              requests++;
              run.recordUsage({
                input: requests * 10000,
                cachedInput: 0,
                cacheWriteInput: 0,
                output: requests * 5000,
              });
              return {
                text: requests === 1 ? "Foreground ready." : "Background ready.",
                toolCalls: [],
              };
            });
          },
          async complete() {
            return { text: "Ready.", toolCalls: [] };
          },
        };
      },
    });
    await agent.send("Describe this room.");
    const foreground = agent.current().id;
    const flush = session.flush;
    const saving = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    session.flush = async () => {
      if (
        agent
          .chats()
          .some((chat) => chat.background && chat.messages.some((message) => message.spend))
      ) {
        saving.resolve();
        await release.promise;
        if (failed) throw new Error("Conversation storage rejected the write.");
      }
      await flush();
    };
    const finished = agent.background("Next room", "Describe the next room.").then(
      () => null,
      (cause: unknown) => cause,
    );
    try {
      await saving.promise;
      const background = agent.chats().find((chat) => chat.background)!;
      const reply = background.messages.find((message) => message.role === "assistant")!;
      assert.equal(
        agent.current().id,
        foreground,
        "background work leaves the visible conversation selected",
      );
      assert.equal(agent.busy, true);
      assert.equal(
        agent.task?.reportedSpent,
        0.14,
        "busy controls keep the background request's reported spend",
      );
      assert.equal(
        agent.activeRequest?.id,
        reply.taskId,
        "busy controls retain the background request identity",
      );
      assert.equal(
        agent.canSteer,
        false,
        "a task saving its final reply no longer accepts corrections",
      );
      assert.equal(reply.spend?.amount, 0.14);
    } finally {
      release.resolve();
      const outcome = await finished;
      assert.equal(outcome instanceof Error, failed);
      session.flush = flush;
      session.dispose();
    }
    assert.equal(agent.busy, false);
    assert.equal(agent.activeRequest, null);
    assert.equal(
      agent.task?.reportedSpent,
      0.07,
      "completed background work restores the foreground task projection",
    );
    assert.equal(Boolean(agent.chatSaveError), failed);
  });

test("background work retains image spend and a new person request starts a fresh allowance", async () => {
  const { beginProviderTask, trackImageSpend } = await import("../src/agent/providerBudget.ts");
  const { session } = fixture();
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "", budgetUsd: 1 }),
  });
  beginProviderTask(1);
  trackImageSpend()(0.8);
  await agent.background("Next room", "Tell me about this room");
  agent.resume(agent.chats().find((chat) => chat.background)!.id);
  assert.equal(agent.task?.spent, 0.8);
  const settlePreviousImage = trackImageSpend();
  await agent.send("Tell me about this room");
  assert.equal(agent.task?.spent, 0);
  settlePreviousImage(0.1);
  assert.equal(agent.task?.spent, 0, "a late image response settles its original task");
  session.dispose();
});

test("selected art tools use the workspace review and one Undo", async () => {
  const { BRIDGE_SOURCE } = await import("../../test/studioAssistFixtures.ts");
  const { session } = fixture();
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Bridge", [
      { key: "picture:1", content: BRIDGE_SOURCE },
    ]),
    label: "Bridge",
    origin: "picture",
    author: "creator",
  });
  const before = session.model.capture().read("picture:1")!.content;
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
  });
  await agent.send(
    "bad: make this bridge walkable",
    "Current room 1\nSelection: PICTURE 1 · Bridge\nSelected item ids: bridge. Lens: depth.",
  );
  assert.equal(agent.pending()?.changes().length, 1);
  assert.equal(agent.pending()?.changes()[0]?.key, "picture:1");
  assert.equal(session.model.capture().read("picture:1")!.content, before);
  assert.ok(
    agent.current().transcript.some((entry) => JSON.stringify(entry).includes("locked-plane")),
  );
  await agent.approve();
  assert.notEqual(session.model.capture().read("picture:1")!.content, before);
  await session.undo();
  assert.equal(session.model.capture().read("picture:1")!.content, before);
  session.dispose();
});

test("evidence naming batches all binding kinds for review with byte-preserving renames", async () => {
  const { session } = fixture();
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Named code", [
      { key: "bindings", content: '{"old_name":{"kind":"flag","num":36}}' },
      {
        key: "logic:1",
        content:
          'set(old_name); if (isset(old_name)) { print(m1); } set.view(o1, 1); get(i0); return; #message 1 "A brass key"',
      },
      { key: "view:1", content: (await import("../../test/studioAssistFixtures.ts")).DOT_EGO },
      { key: "inventory", content: '[{"name":"Key","startingRoom":1}]' },
    ]),
    label: "Named code",
    origin: "logic",
    author: "creator",
  });
  const before = session.model.capture();
  const payload = before.lastAdmissibleBuild!.files();
  const names = [
    { kind: "flag", id: 36, name: "key_found", rename: "old_name" },
    { kind: "object", id: 1, name: "key_actor", rename: null },
    { kind: "inventory", id: 0, name: "brass_key", rename: null },
    { kind: "message", id: 1, name: "key_hint", rename: null },
  ].map((item) => ({
    ...item,
    logic: item.kind === "message" ? 1 : null,
    evidence: (item.kind === "flag" ? ["Changed", "Read"] : ["Used"]).map((role) => ({
      logic: 1,
      line: 1,
      role,
      text: String(before.read("logic:1")!.content),
      nearbyMessages: ["A brass key"],
    })),
  }));
  const namingResults: unknown[] = [];
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation: () => ({
      setAvailableTools() {},
      async sendUserMessage() {
        return {
          toolCalls: [
            { id: "names", name: "propose_names", input: { names } },
            {
              id: "reserve",
              name: "reserve_name",
              input: { name: "extra_state", kind: "flag", id: 37, bindings: null },
            },
            {
              id: "reuse",
              name: "reserve_name",
              input: { name: "key_found", kind: "flag", id: 36, bindings: null },
            },
          ],
        };
      },
      appendToolResults(results) {
        namingResults.push(...results);
      },
      async complete() {
        return { text: "Named the key from its code.", toolCalls: [] };
      },
      getTranscript() {
        return [];
      },
    }),
  });
  agent.autoApprove = true;
  await agent.send("Name the key from its code", "");
  assert.ok(agent.pending(), JSON.stringify(namingResults));
  assert.ok(
    String(
      agent
        .pending()!
        .changes()
        .find((c) => c.key === "bindings")?.content,
    ).includes("brass_key"),
  );
  assert.deepEqual(
    JSON.parse(
      String(
        agent
          .pending()!
          .changes()
          .find((change) => change.key === "bindings")!.content,
      ),
    ).key_found.evidence,
    names[0]!.evidence,
    "reusing a reservation retains its reviewed evidence",
  );
  assert.equal(session.model.capture().documentId, before.documentId);
  await agent.approve();
  assert.deepEqual(session.model.capture().lastAdmissibleBuild!.files(), payload);
  await session.undo();
  assert.equal(session.model.capture().read("bindings")!.content, before.read("bindings")!.content);
  session.dispose();
});

test("read-only agent inspects selected art and withdraw clears every pending edit", async () => {
  const { BRIDGE_SOURCE } = await import("../../test/studioAssistFixtures.ts");
  const { session } = fixture();
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Bridge", [
      { key: "picture:1", content: BRIDGE_SOURCE },
    ]),
    label: "Bridge",
    origin: "picture",
    author: "creator",
  });
  const context =
    "Current room 1\nSelection: PICTURE 1 · Bridge\nSelected item ids: bridge. Lens: depth.";
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
  });
  await agent.ask("impossible: make the ceiling walkable", context);
  assert.ok(
    agent.current().transcript.some((entry) => JSON.stringify(entry).includes("selectionArea")),
  );
  assert.equal(agent.pending(), null);
  await agent.send("withdraw: make this bridge walkable", context);
  assert.equal(agent.pending(), null);
  session.dispose();
});

test("selection context carries the live horizon and actor probe", async () => {
  const { BRIDGE_SOURCE, DOT_EGO } = await import("../../test/studioAssistFixtures.ts");
  const { session } = fixture();
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Bridge", [
      { key: "picture:1", content: BRIDGE_SOURCE },
      { key: "view:0", content: DOT_EGO },
    ]),
    label: "Bridge",
    origin: "picture",
    author: "creator",
  });
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    runtime: () => ({
      engine: {
        state: () => ({ room: 1, horizon: 112 }),
        objects: () => [
          { num: 0, view: 0, loop: 0, cel: 0, x: 64, y: 130, priority: 12, fixedPriority: false },
        ],
      },
    }),
  });
  await agent.ask(
    "impossible: change the selection",
    "Current room 1\nSelection: PICTURE 1 · Bridge\nSelected item ids: bridge. Lens: depth.",
  );
  const result = agent
    .current()
    .transcript.flatMap((entry) => {
      try {
        return [
          JSON.parse(String((entry as { text?: string }).text)) as {
            result?: { details?: Record<string, unknown> };
          },
        ];
      } catch {
        return [];
      }
    })
    .find((entry) => entry.result?.details?.["selectionArea"])?.result?.details;
  assert.equal((result?.["walkable"] as { overall: number })?.overall, 55 * 160 - 356);
  assert.equal((result?.["roomContext"] as { ghost?: { x: number } })?.ghost?.x, 64);
  session.dispose();
});

test("selected VIEW edits share review, preserve other cels and Undo", async () => {
  const { ROBOT_VIEW } = await import("../../test/studioAssistFixtures.ts");
  const { parseView } = await import("../../src/view/view.ts");
  const { session } = fixture();
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Robot", [
      { key: "view:2", content: ROBOT_VIEW },
    ]),
    label: "Robot",
    origin: "view",
    author: "creator",
  });
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
  });
  await agent.send(
    "Make the eyes blue",
    "Current room 1\nSelection: VIEW 2 · Robot\nSelected VIEW 2, loop 1, cel 0.",
  );
  const change = agent
    .pending()
    ?.changes()
    .find((change) => change.key === "view:2");
  assert.ok(change, JSON.stringify(agent.current().transcript));
  const result = parseView(change.content as Uint8Array);
  assert.deepEqual(
    result.loops[0]!.cels[1]!.pixels,
    parseView(ROBOT_VIEW).loops[0]!.cels[1]!.pixels,
  );
  await agent.approve();
  await session.undo();
  assert.deepEqual(session.model.capture().read("view:2")!.content, ROBOT_VIEW);
  session.dispose();
});

test("selected art carries reference handles and thumbnails once, then reuses the transcript", async () => {
  const { BRIDGE_SOURCE } = await import("../../test/studioAssistFixtures.ts");
  const { session } = fixture();
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Bridge", [
      { key: "picture:1", content: BRIDGE_SOURCE },
    ]),
    label: "Bridge",
    origin: "picture",
    author: "creator",
  });
  let attached = true;
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    runtime: () => ({
      referenceArt: async () => ({
        art: [
          {
            id: "art-0123456789",
            label: "Bridge reference",
            target: { kind: "room", num: 1 },
            note: "",
            attached,
            pixels: () => ({ width: 1, height: 1, rgba: new Uint8Array([0, 0, 170, 255]) }),
          },
        ],
      }),
    }),
  });
  const context =
    "Current room 1\nSelection: PICTURE 1 · Bridge\nSelected item ids: bridge. Lens: depth.";
  await agent.send("Match the reference", context);
  assert.match(
    agent.current().messages.at(-1)!.text,
    /I viewed art-0123456789.*one image \(72x72\)/,
  );
  const first = agent.current().transcript;
  attached = false;
  await agent.send("Match the reference", context);
  assert.deepEqual(agent.current().transcript.slice(0, first.length), first);
  const lastRequest = agent
    .current()
    .transcript.findLast((entry) => (entry as { role?: string }).role === "user") as {
    text: string;
    images: unknown[];
  };
  assert.equal(lastRequest.images.length, 0);
  assert.ok(!lastRequest.text.includes("### REFERENCE ART"));
  session.dispose();
});

test("the agent creates a Launch from a request, proposed for review with one Undo", async () => {
  const { session } = fixture();
  const capture = session.model.capture();
  await session.submit({
    proposal: session.model.propose(capture, "Add room 8", [
      { key: "logic:8", content: "return;" },
      { key: "picture:8", content: "vis 1\nfill 0,0\nend\n" },
    ]),
    label: "Add room 8",
    origin: "logic",
    author: "creator",
  });
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
  });

  await agent.send("make a launch for the vacuum death in Room 8", "Current room 8");
  const pending = agent.pending();
  assert.ok(pending, "a proposal is held for review");
  const changes = pending.changes();
  const worldChange = changes.find((change) => change.key === "world");
  assert.ok(worldChange, "the proposal changes the world document");
  const world = JSON.parse(String(worldChange.content));
  assert.ok(world.launches?.["8"], "room 8 has launches");
  const launch = world.launches["8"].entries[0];
  assert.equal(launch.name, "Vacuum death");
  assert.deepEqual(launch.cameFrom, { room: 7, edge: 4 });
  assert.deepEqual(launch.flags, { "77": true });
  assert.deepEqual(launch.variables, { "90": 123 });

  // Approve the proposal
  await agent.approve();
  const committedContent = session.model.capture().read("world")?.content;
  assert.ok(committedContent, "world document is committed");
  const committedWorld = JSON.parse(String(committedContent));
  assert.equal(committedWorld.launches?.["8"]?.entries[0]?.name, "Vacuum death");

  // One Undo removes the launch
  await session.undo();
  const undoneContent = session.model.capture().read("world")?.content;
  const undoneWorld = undoneContent ? JSON.parse(String(undoneContent)) : undefined;
  assert.equal(undoneWorld?.launches?.["8"], undefined, "one Undo removes the launched state");

  session.dispose();
});

test("applied review resolves exact historical resources and spend after reload and export", async () => {
  const { session, agent, saved } = fixture();
  await agent.send("Add a welcome sign");
  const pending = agent.current().pendingReview!;
  await agent.approve();
  await session.flush();
  const result = agent.reviewFor(pending.messageId)!;
  assert.equal(result.baseDocumentId, pending.baseDocumentId);
  assert.equal(result.baseRevision, pending.baseRevision);
  assert.deepEqual(result.base, pending.base);
  assert.deepEqual(result.candidate, pending.candidate);
  const { session: reopenedSession, agent: reopened } = fixture(
    undefined,
    true,
    undefined,
    saved(),
  );
  try {
    assert.deepEqual(reopened.reviewFor(pending.messageId), result);
    const message = reopened
      .current()
      .messages.find((message) => message.id === pending.messageId)!;
    assert.deepEqual(message.spend, { amount: 0, budget: 5, priceKnown: false, incomplete: false });
    assert.equal(
      message.review,
      undefined,
      "applied resources project history without copied workspaces",
    );
    const zip = await buildProjectZip(saved());
    const exported = await readGameZip(zip);
    assert.deepEqual(exported.project?.chats, saved().chats);
  } finally {
    session.dispose();
    reopenedSession.dispose();
  }
});

for (const admission of ["withdraw", "auto"] as const) {
  test(`Create captures the native version read before ${admission === "auto" ? "an auto-approved edit and after it" : "withdrawing staged edits"}`, async () => {
    const { session } = fixture();
    const before = session.model.capture().documentId;
    const nativeBefore = computeResourceRevision(
      Object.fromEntries(session.model.capture().lastAdmissibleBuild!.files()),
    );
    const advances: [string, string][] = [];
    const source = 'print("Native read"); return;';
    const agent = createWorkspaceAgent({
      session,
      profileId: "2.936",
      config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
      runtime: () => ({ advanceRevision: (before, after) => advances.push([before, after]) }),
      conversation: () => ({
        setAvailableTools() {},
        getTranscript: () => [],
        async sendUserMessage() {
          return {
            toolCalls: [
              {
                id: "before",
                name: "read_picture",
                input: { num: 1, offset: null, limit: null, include: "source" },
              },
              admission === "auto"
                ? {
                    id: "edit",
                    name: "propose_changes",
                    input: { label: "Change boot", changes: [{ key: "logic:0", content: source }] },
                  }
                : { id: "edit", name: "write_logic", input: { room: 0, source } },
              { id: "after", name: "read_logic", input: { num: 0, offset: null, limit: null } },
              ...(admission === "withdraw"
                ? [{ id: "withdraw", name: "withdraw_changes", input: { reason: null } }]
                : []),
            ],
          };
        },
        appendToolResults(results) {
          assert.ok(
            results.every(({ result }) => result.success),
            JSON.stringify(results),
          );
        },
        async complete() {
          return { text: "Captured", toolCalls: [] };
        },
      }),
    });
    agent.autoApprove = admission === "auto";
    try {
      await agent.send("Inspect boot changes");
      const result = agent.current().messages.at(-1)!.result;
      if (result?.kind !== "resources") assert.fail("Missing Create native captures");
      assert.deepEqual(result.resources, ["picture:1", "logic:0"]);
      assert.deepEqual(
        capturedResourceDocuments(result, "logic:0")["logic:0"],
        assembleLogic(source, { dictionary: new Map() }).payload,
      );
      if (admission === "withdraw") {
        assert.equal(session.model.capture().documentId, before);
        assert.deepEqual(advances, []);
      } else {
        assert.deepEqual(advances, [
          [nativeBefore, session.model.capture().lastAdmissibleBuild!.identity.revision],
        ]);
      }
    } finally {
      session.dispose();
    }
  });
}

test("Create captures native game-test definitions through serialization and reload", async () => {
  const { GAME_TESTS_FORMAT } = await import("../../src/agent/gameTestFormat.ts");
  const { session } = fixture();
  const tests = JSON.stringify({
    format: GAME_TESTS_FORMAT,
    tests: [{ name: "Stored wait", room: 1, steps: [{ action: "wait", ticks: 1 }] }],
  });
  await session.submit({
    proposal: session.model.propose(session.model.capture(), "Stored tests", [
      { key: "tests", content: tests },
      { key: "logic:1", content: "return;" },
    ]),
    label: "Stored tests",
    origin: "agent",
    author: "creator",
  });
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation: () => ({
      setAvailableTools() {},
      getTranscript: () => [],
      async sendUserMessage() {
        return {
          toolCalls: [
            { id: "tests", name: "read_game_tests", input: { names: null, offset: null } },
          ],
        };
      },
      appendToolResults(results) {
        assert.equal(results[0]!.result.success, true, JSON.stringify(results));
        assert.match(JSON.stringify(results[0]!.result), /Stored wait/);
      },
      async complete() {
        return { text: "Stored definitions", toolCalls: [] };
      },
    }),
  });
  try {
    await agent.send("Inspect stored tests");
    const chat = agent.current();
    const loaded = readAgentChats(
      JSON.parse(
        JSON.stringify({ format: "monotio.agi.chats", version: 1, active: chat.id, chats: [chat] }),
      ),
    );
    const result = loaded.chats[0]!.messages.at(-1)!.result;
    if (result?.kind !== "resources") assert.fail("Missing native test definitions capture");
    assert.deepEqual(result.resources, ["tests"]);
    assert.deepEqual(
      capturedResourceDocuments(result, "tests")["tests"],
      new TextEncoder().encode(tests),
    );
  } finally {
    session.dispose();
  }
});

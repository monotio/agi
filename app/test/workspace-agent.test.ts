import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceAgent } from "../src/agent/workspaceAgent.ts";
import { useAuthoringController } from "../src/authoring/useAuthoringController.ts";
import { AgentSession } from "../src/agent/agentSession.ts";
import type { BootedGame } from "../src/project/gameTypes.ts";
import { migrateAgentChats, type AgentChats } from "../../src/agent/chats.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { createContainer } from "../../src/container/container.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import type { UnifiedConversation, LlmTurnResult } from "../src/agent/llmClient.ts";
import { wordsTaskReply } from "../src/studio/workspace/wordsAgent.ts";

let seq = 0;
function fixture(chats?: AgentChats, roomGeneration = true) {
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
    data: {
      projectId: requireProjectId(`agent-test-${++seq}`),
      title: "Test",
      roomGeneration,
      ...(chats ? { chats } : {}),
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [["look", 1]],
      workspace: writeProjectWorkspace(documents),
    },
    lifetime: "test",
    admission: {
      runToken: "test",
      async admit() {
        return { status: "committed", expected: null, current: null, patchGeneration: 1 };
      },
    },
    async write(request) {
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
  return { session, agent, sent, resumed, documents };
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
  await agent.approve(["logic:0", "picture:1"]);
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
test("reject, auto-approve and stale proposals preserve the manual base", async () => {
  const { session, agent } = fixture();
  await agent.send("Add sign");
  agent.reject();
  assert.equal(session.history.capture().commits.length, 1);
  agent.autoApprove = true;
  await agent.send("Add sign");
  assert.equal(session.history.capture().commits.length, 2);
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
    config: () => ({ provider: "stub", model, apiKey: "" }),
    conversation(_config, transcript) {
      offered.push(transcript);
      const history = [...transcript];
      return {
        setAvailableTools() {},
        async sendUserMessage(text) {
          requests.push(text);
          history.push({ role: "user", text });
          if (text.includes("compaction summary pattern"))
            return { text: "Objective: add a sign. Next: revise the wording.", toolCalls: [] };
          history.push(
            { type: "reasoning", encrypted_content: "private-thinking" },
            { role: "assistant", text: "Done" },
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
    "Suggested inspect · shown in WORDS",
  );
  const message = agent.current().messages.at(-1)!;
  assert.deepEqual(message, {
    id: message.id,
    role: "assistant",
    text: "Suggested inspect · shown in WORDS",
    context: raw,
  });
  assert.deepEqual(session.chats().chats[0]!.messages.at(-1), message);
  assert.deepEqual(agent.current().transcript, [{ role: "assistant", text: raw }]);
  assert.deepEqual(agent.progress, ["Suggested inspect · shown in WORDS"]);
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

test("model settings preserve the owned project writer and current editor documents", async () => {
  const { session } = fixture();
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

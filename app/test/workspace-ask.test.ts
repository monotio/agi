import { installIndexedDbFixture } from "./indexedDbFixture.ts";
installIndexedDbFixture();
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceAgent, borrowWorkspaceAgent } from "../src/agent/workspaceAgent.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import type { AgentToolResult } from "../../src/agent/agentState.ts";
import type { UnifiedConversation, LlmTurnResult } from "../src/agent/llmClient.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import { createProjectInspection } from "../../src/agent/projectInspection.ts";
import { GAME_TESTS_FORMAT } from "../../src/agent/gameTestFormat.ts";

for (const encoding of ["text", "bytes"] as const) {
  test(`Ask uses the admitted ${encoding} test document over retained native metadata`, async () => {
    const files = Object.fromEntries(createStarterProject("starter").files());
    files["TESTS.JSON"] = new TextEncoder().encode(
      JSON.stringify({
        format: GAME_TESTS_FORMAT,
        tests: [{ name: "Old test", room: 1, steps: [{ action: "wait", ticks: 1 }] }],
      }),
    );
    const current = JSON.stringify({
      format: GAME_TESTS_FORMAT,
      tests: [{ name: "Current test", room: 1, steps: [{ action: "wait", ticks: 1 }] }],
    });
    const inspection = createProjectInspection({
      files,
      profileId: "2.936",
      documents: { tests: encoding === "text" ? current : new TextEncoder().encode(current) },
    });
    const result = await inspection.execute(
      "read_game_tests",
      { names: null, offset: null },
      { allowedTools: ["read_game_tests"] },
    );
    assert.equal(result.success, true);
    assert.match(JSON.stringify(result), /Current test/);
    assert.doesNotMatch(JSON.stringify(result), /Old test/);
    assert.equal(result.details?.["testDefinitionsOrigin"], "admitted");
  });
}

let sequence = 0;
function inspectionFixture(damaged = false, write?: (data: CachedGameData) => Promise<void>) {
  const project = createStarterProject("starter");
  const files = Object.fromEntries(project.files());
  if (damaged) {
    const directory = new Uint8Array(256 * 3).fill(255);
    directory.set(files["SNDDIR"]!);
    directory.set([1, 255, 255], 255 * 3);
    files["SNDDIR"] = directory;
  }
  return openProjectSession({
    data: {
      projectId: requireProjectId(`ask-test-${++sequence}`),
      title: "Inspection",
      authoredAt: "",
      files,
      words: [],
      roomGeneration: false,
    },
    lifetime: "ask",
    admission: {
      runToken: "ask",
      async admit() {
        assert.fail("Ask attempted engine admission");
      },
    },
    async write(request) {
      await write?.(request.data as CachedGameData);
      return {
        commitId: request.commitId,
        workspaceId: request.workspaceId,
        candidateHash: "a",
        documents: request.documents,
        saved: { ...request.expected!, generation: request.expected!.generation + 1 },
      };
    },
  });
}

function scriptedConversation(
  turns: readonly LlmTurnResult[],
  results: { toolCallId: string; result: AgentToolResult }[],
): UnifiedConversation {
  let index = 0;
  return {
    setAvailableTools() {},
    async sendUserMessage() {
      return turns[index++]!;
    },
    appendToolResults(entries) {
      results.push(...entries);
    },
    async complete() {
      return turns[index++]!;
    },
    getTranscript() {
      return [];
    },
  };
}

test("Ask reads a native game with an unreadable unused slot and refuses edits", async () => {
  const session = inspectionFixture(true);
  const draft = "// My unfinished room\nthis is invalid AGI source";
  await session.stage([{ key: "logic:1", content: draft }]);
  const before = session.model.capture();
  const history = session.history.capture();
  const results: { toolCallId: string; result: AgentToolResult }[] = [];
  const turns: LlmTurnResult[] = [
    {
      toolCalls: [{ id: "room", name: "read_room", input: { room: 1, state: null, frames: null } }],
    },
    {
      toolCalls: [
        { id: "broken", name: "read_sound", input: { num: 255 } },
        { id: "logic", name: "read_logic", input: { num: 0, offset: null, limit: null } },
        {
          id: "draft",
          name: "read_document",
          input: { key: "logic:1", offset: null, limit: null },
        },
        { id: "intent", name: "read_document", input: { key: "world", offset: null, limit: null } },
        { id: "write", name: "write_logic", input: { room: 0, source: "return;" } },
        {
          id: "proposal",
          name: "propose_changes",
          input: { label: "Change", changes: [{ key: "logic:0", content: "return;" }] },
        },
      ],
    },
    { text: "Read the sign for a clue.", toolCalls: [] },
  ];
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation: () => scriptedConversation(turns, results),
  });
  try {
    assert.equal(await agent.ask("How do I proceed?"), "Read the sign for a clue.");
    assert.deepEqual(
      results.map(({ toolCallId, result }) => [toolCallId, result.success]),
      [
        ["room", true],
        ["broken", false],
        ["logic", true],
        ["draft", true],
        ["intent", false],
        ["write", false],
        ["proposal", false],
      ],
    );
    assert.match(
      results.find((entry) => entry.toolCallId === "draft")!.result.message!,
      /My unfinished room/,
    );
    assert.equal(
      (
        results.find((entry) => entry.toolCallId === "draft")!.result.details!["origin"] as Record<
          string,
          unknown
        >
      )["kind"],
      "draft",
    );
    assert.equal(session.workingSnapshot().read("logic:1")!.content, draft);
    assert.equal(session.model.capture().documentId, before.documentId);
    assert.deepEqual(
      session.model.capture().lastAdmissibleBuild!.files(),
      before.lastAdmissibleBuild!.files(),
    );
    assert.deepEqual(session.history.capture(), history);
    assert.equal(agent.pending(), null);
  } finally {
    session.dispose();
  }
});

test("an interrupted Ask preserves the edit review already awaiting approval", async () => {
  const session = inspectionFixture();
  let conversation = 0;
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation() {
      if (conversation++ === 0)
        return scriptedConversation(
          [
            {
              toolCalls: [
                {
                  id: "proposal",
                  name: "propose_changes",
                  input: {
                    label: "Comment",
                    changes: [{ key: "logic:1", content: "// A comment\nreturn;" }],
                  },
                },
              ],
            },
            { text: "Review this comment.", toolCalls: [] },
          ],
          [],
        );
      return {
        ...scriptedConversation(
          [
            {
              toolCalls: [
                { id: "read", name: "read_logic", input: { num: 0, offset: null, limit: null } },
              ],
            },
          ],
          [],
        ),
        async complete() {
          throw new Error("Provider disconnected");
        },
      };
    },
  });
  try {
    await agent.send("Add a comment");
    const review = agent.pending();
    assert.ok(review);
    await assert.rejects(agent.ask("Explain the room"), /Provider disconnected/);
    assert.equal(agent.pending(), review);
    assert.equal(agent.current().pendingReview!.messageId, review.messageId);
    assert.equal(agent.busy, false);
  } finally {
    session.dispose();
  }
});

test("Ask retains its reply when conversation storage rejects and retries without a provider call", async () => {
  const session = inspectionFixture();
  let requests = 0;
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation() {
      requests++;
      return scriptedConversation([{ text: "Read the sign.", toolCalls: [] }], []);
    },
  });
  await session.flush();
  const saveChats = session.saveChats;
  session.saveChats = async () => {
    throw new Error("Storage refused");
  };
  try {
    assert.equal(await agent.ask("Where next?"), "Read the sign.");
    assert.equal(agent.chatSaveError, "Saving the conversation failed. Retry save.");
    assert.equal(agent.busy, false);
    session.saveChats = saveChats;
    await agent.retryChatSave();
    assert.equal(agent.chatSaveError, "");
    assert.equal(requests, 1);
    assert.equal(session.chats().chats.at(-1)!.messages.at(-1)!.text, "Read the sign.");
  } finally {
    session.dispose();
  }
});

test("shared conversation uses each request's current runtime and reports live origin", async () => {
  const session = inspectionFixture();
  const options = {
    session,
    profileId: "2.936" as const,
    config: () => ({ provider: "stub" as const, model: "stub", apiKey: "" }),
  };
  const results: { toolCallId: string; result: AgentToolResult }[] = [];
  const agent = borrowWorkspaceAgent({
    ...options,
    runtime: () => ({ engine: { state: async () => ({ room: 7 }), objects: async () => [] } }),
    conversation: () =>
      scriptedConversation(
        [
          {
            toolCalls: [
              {
                id: "room",
                name: "read_room",
                input: {
                  room: null,
                  state: { compact: true, variables: null, flags: null },
                  frames: null,
                },
              },
            ],
          },
          { text: "Current room inspected.", toolCalls: [] },
        ],
        results,
      ),
  });
  try {
    assert.equal(borrowWorkspaceAgent(options), agent);
    const files = Object.fromEntries(createStarterProject("starter").files());
    const directory = new Uint8Array(256 * 3).fill(255);
    directory.set(files["LOGDIR"]!);
    directory.set([1, 255, 255], 255 * 3);
    files["LOGDIR"] = directory;
    files["WORDS.TOK"] = Uint8Array.of(255);
    for (const room of [1, 2]) {
      await agent.ask("Where am I?", "", undefined, {
        profileId: "2.936",
        runtime: () => ({
          nativeFiles: async () => files,
          engine: { state: async () => ({ room, cycle: 42 }), objects: async () => [] },
        }),
      });
    }
    assert.deepEqual(
      results.map((entry) => entry.result.details?.["room"]),
      [1, 2],
    );
    assert.equal(
      results[0]!.result.details?.["origin"] &&
        (results[0]!.result.details!["origin"] as Record<string, unknown>)["kind"],
      "live",
    );
    assert.match(String(results[0]!.result.details?.["dictionaryError"]), /WORDS.TOK/);
  } finally {
    session.dispose();
  }
});

test("Ask holds its chat while persistence waits, and retains the answer after a rejected durable write", async () => {
  let rejectWrite = false;
  let lastSaved: CachedGameData | undefined;
  const waiting = Promise.withResolvers<void>();
  const writing = Promise.withResolvers<void>();
  let block = false;
  const session = inspectionFixture(false, async (data) => {
    if (block) {
      writing.resolve();
      await waiting.promise;
    }
    if (rejectWrite) throw new Error("Storage refused");
    lastSaved = structuredClone(data);
  });
  let requests = 0;
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation() {
      requests++;
      return scriptedConversation([{ text: "Read the sign.", toolCalls: [] }], []);
    },
  });
  await session.flush();
  block = true;
  rejectWrite = true;
  try {
    const answer = agent.ask("Where next?");
    await writing.promise;
    assert.equal(agent.busy, true);
    assert.throws(() => agent.newChat(), /Finish the current task/);
    waiting.resolve();
    assert.equal(await answer, "Read the sign.");
    assert.equal(agent.chatSaveError, "Saving the conversation failed. Retry save.");
    assert.equal(agent.busy, false);
    rejectWrite = false;
    await agent.retryChatSave();
    assert.equal(agent.chatSaveError, "");
    assert.equal(requests, 1);
    assert.equal(lastSaved!.chats!.chats.at(-1)!.messages.at(-1)!.text, "Read the sign.");
  } finally {
    waiting.resolve();
    session.dispose();
  }
});

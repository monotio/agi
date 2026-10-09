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
import { projectDocumentId } from "../../src/authoring/projectContent.ts";
import { readProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { readAgentChats } from "../../src/agent/chats.ts";
import {
  compileCapturedResource,
  capturedResourceDocuments,
} from "../src/agent/agentResultPreview.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { disassembleLogic } from "../../src/logic/disassembler.ts";
import { parseWordsTok } from "../../src/logic/words.ts";
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

test("one conversation captures each turn's authority and keeps stable request identities across navigation and reload", async () => {
  const session = inspectionFixture();
  const options = {
    session,
    profileId: "2.936" as const,
    config: () => ({ provider: "stub" as const, model: "stub", apiKey: "" }),
  };
  const results: { toolCallId: string; result: AgentToolResult }[] = [];
  const agent = borrowWorkspaceAgent({
    ...options,
    conversation: () =>
      scriptedConversation(
        [
          {
            toolCalls: [
              {
                id: "edit",
                name: "propose_changes",
                input: {
                  label: "Comment",
                  changes: [{ key: "logic:1", content: "// approved scope\nreturn;" }],
                },
              },
            ],
          },
          { text: "A reply.", toolCalls: [] },
        ],
        results,
      ),
  });
  try {
    await agent.submit({ instruction: "Change the game", mode: "play", context: "Current room 1" });
    await agent.submit({
      instruction: "Suggest commands",
      mode: "create",
      readOnly: true,
      context: "Words",
    });
    await agent.submit({ instruction: "Add a comment", mode: "create", context: "Words" });
    assert.deepEqual(
      results.map(({ result }) => result.success),
      [false, false, true],
    );
    assert.equal(borrowWorkspaceAgent(options), agent);
    const chat = agent.current();
    const requests = chat.messages.filter((message) => message.request);
    assert.deepEqual(
      requests.map((message) => message.request!.capability),
      ["inspect", "inspect", "edit"],
    );
    assert.equal(new Set(requests.map((message) => message.request!.id)).size, 3);
    for (const message of chat.messages.filter((message) => message.role === "assistant"))
      assert.ok(requests.some((request) => request.request!.id === message.taskId));
    const pending = agent.pending()!;
    await agent.reject();
    assert.equal(agent.reviewFor(pending.messageId)!.label, "Comment");
    assert.equal(agent.current().messages.at(-1)!.result!.kind, "changes");
    const reloaded = createWorkspaceAgent(options);
    assert.deepEqual(reloaded.current().messages, agent.current().messages);
    assert.deepEqual(reloaded.reviewFor(pending.messageId), agent.reviewFor(pending.messageId));
  } finally {
    session.dispose();
  }
});

test("queued followups retain Play authority and reach the provider once at the next boundary", async () => {
  const session = inspectionFixture();
  const released = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const prompts: string[] = [];
  const results: { toolCallId: string; result: AgentToolResult }[] = [];
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation: () => ({
      ...scriptedConversation([], results),
      async sendUserMessage(text) {
        prompts.push(text);
        if (prompts.length === 1) {
          entered.resolve();
          await released.promise;
          return { text: "Initial answer", toolCalls: [] };
        }
        return {
          toolCalls: [
            {
              id: "edit",
              name: "propose_changes",
              input: { label: "Forbidden", changes: [{ key: "logic:1", content: "return;" }] },
            },
          ],
        };
      },
      async complete() {
        return { text: "Still read-only", toolCalls: [] };
      },
    }),
  });
  try {
    const running = agent.submit({ instruction: "Explain", mode: "play" });
    await entered.promise;
    agent.steer("Change it now");
    const queued = agent.current().messages.at(-1)!;
    assert.equal(queued.delivery, "queued");
    assert.equal(queued.taskId, agent.activeRequest!.id);
    released.resolve();
    assert.equal(await running, "Still read-only");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1]!, /Change it now/);
    assert.equal(
      agent.current().messages.find((message) => message.id === queued.id)!.delivery,
      "received",
    );
    assert.equal(results[0]!.result.success, false);
    assert.equal(agent.pending(), null);
  } finally {
    released.resolve();
    session.dispose();
  }
});

test("native inspection results retain the inspected bytes after a later document change", async () => {
  const session = inspectionFixture();
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation: () =>
      scriptedConversation(
        [
          {
            toolCalls: [
              {
                id: "picture",
                name: "read_picture",
                input: { num: 1, offset: null, limit: null, include: "source" },
              },
            ],
          },
          { text: "The picture is shown.", toolCalls: [] },
        ],
        [],
      ),
  });
  try {
    await agent.submit({ instruction: "Show picture 1", mode: "play" });
    const result = agent.current().messages.at(-1)!.result;
    assert.equal(result?.kind, "resources");
    if (result?.kind !== "resources") assert.fail("Missing native resource result");
    assert.ok(result.snapshot);
    assert.equal(
      result.documentId,
      projectDocumentId(readProjectWorkspace(result.snapshot), sha256Hex),
    );
    assert.notEqual(result.documentId, agent.current().messages[0]!.request!.documentId);
    const before = structuredClone(result.snapshot);
    assert.deepEqual(result.resources, ["picture:1"]);
    await session.stage([{ key: "picture:1", content: "vis 4\nfill 0,0\nend" }]);
    assert.deepEqual(agent.current().messages.at(-1)!.result, result);
    assert.deepEqual(result.snapshot, before);
  } finally {
    session.dispose();
  }
});

test("a followup arriving during a tool runs after its result without replaying the tool", async () => {
  const session = inspectionFixture();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const requests: string[] = [];
  let tools = 0;
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    runtime: () => ({
      engine: {
        async state() {
          tools++;
          entered.resolve();
          await released.promise;
          return { room: 1 };
        },
        objects: async () => [],
      },
    }),
    conversation: () => ({
      setAvailableTools() {},
      async sendUserMessage(text) {
        requests.push(text);
        return requests.length === 1
          ? {
              toolCalls: [
                {
                  id: "read",
                  name: "read_room",
                  input: {
                    room: 1,
                    state: { compact: true, variables: null, flags: null },
                    frames: null,
                  },
                },
              ],
            }
          : { text: "Updated answer", toolCalls: [] };
      },
      appendToolResults() {},
      async complete() {
        assert.fail("Queued followup should be sent before completion");
      },
      getTranscript() {
        return [];
      },
    }),
  });
  try {
    const running = agent.submit({ instruction: "Inspect", mode: "play" });
    await entered.promise;
    agent.steer("Explain what that means");
    released.resolve();
    await running;
    assert.equal(tools, 1);
    assert.equal(requests.length, 2);
    assert.equal(
      agent.current().messages.find((message) => message.delivery)?.delivery,
      "received",
    );
  } finally {
    released.resolve();
    session.dispose();
  }
});

test("cancellation records an undelivered followup and save retry never resends it", async () => {
  const session = inspectionFixture();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let requests = 0;
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation: () => ({
      setAvailableTools() {},
      async sendUserMessage() {
        requests++;
        entered.resolve();
        await released.promise;
        return { text: "Late answer", toolCalls: [] };
      },
      appendToolResults() {},
      async complete() {
        return { toolCalls: [] };
      },
      getTranscript() {
        return [];
      },
    }),
  });
  try {
    const running = agent.submit({ instruction: "Inspect", mode: "play" });
    await entered.promise;
    agent.steer("Next step");
    agent.cancel();
    released.resolve();
    await assert.rejects(running, /cancelled/);
    assert.equal(agent.current().messages.at(-1)!.delivery, "cancelled");
    await agent.retryChatSave();
    assert.equal(requests, 1);
    assert.equal(session.chats().chats[0]!.messages.at(-1)!.delivery, "cancelled");
  } finally {
    released.resolve();
    session.dispose();
  }
});

for (const order of ["native-first", "draft-first"] as const) {
  test(`mixed native and draft LOGIC results preserve both dictionaries after reload (${order})`, async () => {
    const session = inspectionFixture();
    const words = [...createStarterProject("starter").sources.words].filter(
      ([, group]) => group !== 100,
    );
    words.push(["banana", 100]);
    await session.stage([
      { key: "words", content: JSON.stringify(words) },
      { key: "logic:0", content: 'if (said("banana")) { print("Draft"); } return;' },
    ]);
    const native = {
      id: "native",
      name: "read_logic",
      input: { num: 1, offset: null, limit: null },
    };
    const draft = {
      id: "draft",
      name: "read_document",
      input: { key: "logic:0", offset: null, limit: null },
    };
    const results: { toolCallId: string; result: AgentToolResult }[] = [];
    const agent = createWorkspaceAgent({
      session,
      profileId: "2.936",
      config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
      conversation: () =>
        scriptedConversation(
          [
            { toolCalls: order === "native-first" ? [native, draft] : [draft, native] },
            { text: "Both versions", toolCalls: [] },
          ],
          results,
        ),
    });
    try {
      await agent.submit({ instruction: "Show both logics", mode: "play" });
      assert.ok(
        results.every(({ result }) => result.success),
        JSON.stringify(results),
      );
      assert.equal(
        (
          results.find(({ toolCallId }) => toolCallId === "native")!.result.details!["origin"] as {
            kind: string;
          }
        ).kind,
        "admitted",
      );
      assert.equal(
        (
          results.find(({ toolCallId }) => toolCallId === "draft")!.result.details!["origin"] as {
            kind: string;
          }
        ).kind,
        "draft",
      );
      assert.match(
        String(
          results.find(({ toolCallId }) => toolCallId === "native")!.result.details!["source"],
        ),
        /said\("examine"\)/,
      );
      const chat = agent.current();
      const loaded = readAgentChats(
        JSON.parse(
          JSON.stringify({
            format: "monotio.agi.chats",
            version: 1,
            active: chat.id,
            chats: [chat],
          }),
        ),
      );
      const result = loaded.chats[0]!.messages.at(-1)!.result;
      if (result?.kind !== "resources") assert.fail("Missing captured resource result");
      for (const [key, word] of [
        ["logic:1", "examine"],
        ["logic:0", "banana"],
      ]) {
        const documents = capturedResourceDocuments(result, key!);
        const image = compileCapturedResource(documents, key!, PROFILES["2.936"]);
        assert.ok(image, `No preview for ${key}`);
        const capturedWords = documents["words"]!;
        const dictionary = new Map(
          typeof capturedWords === "string"
            ? (JSON.parse(capturedWords) as [string, number][])
            : parseWordsTok(capturedWords).map(({ word, id }) => [word, id] as const),
        );
        const source = disassembleLogic(image.getResource("logic", Number(key!.split(":")[1]))!, {
          dictionary,
          profile: PROFILES["2.936"],
        });
        assert.match(source, new RegExp(`said\\("${word}"\\)`));
      }
    } finally {
      session.dispose();
    }
  });
}

test("ordinary Create native inspection captures resource widgets", async () => {
  const session = inspectionFixture();
  const results: { toolCallId: string; result: AgentToolResult }[] = [];
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation: () =>
      scriptedConversation(
        [
          {
            toolCalls: [
              { id: "native", name: "read_logic", input: { num: 0, offset: null, limit: null } },
            ],
          },
          { text: "Boot logic", toolCalls: [] },
        ],
        results,
      ),
  });
  try {
    await agent.submit({ instruction: "Show boot logic", mode: "create" });
    assert.equal(results[0]!.result.success, true);
    const result = agent.current().messages.at(-1)!.result;
    assert.equal(result?.kind, "resources");
    if (result?.kind !== "resources") assert.fail("Missing Create native resource result");
    assert.deepEqual(result.resources, ["logic:0"]);
  } finally {
    session.dispose();
  }
});

import { installIndexedDbFixture } from "./indexedDbFixture.ts";
const records = installIndexedDbFixture();
import assert from "node:assert/strict";
import { test } from "node:test";
import { createInstalledConversation } from "../src/agent/installedConversation.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { computeResourceRevision } from "../../src/authoring/resourceRevision.ts";
import { loadGameConversation } from "../src/project/gameStorage.ts";
import type { AgentToolResult } from "../../src/agent/agentState.ts";

function fixture(locator: string) {
  const files = Object.fromEntries(createStarterProject("starter").files());
  const directory = new Uint8Array(256 * 3).fill(255);
  directory.set(files["SNDDIR"]!);
  directory.set([1, 255, 255], 255 * 3);
  files["SNDDIR"] = directory;
  return {
    locator,
    game: {
      installed: true,
      title: "Installed",
      files,
      words: [],
      revision: computeResourceRevision(files),
    },
    config: () => ({ provider: "stub" as const, model: "stub", apiKey: "" }),
    runtime: () => ({}),
  };
}

test("installed conversations retain stable identities and native bytes through chat lifecycle and reload", async () => {
  const options = fixture("installed-chats");
  const bytes = structuredClone(options.game.files);
  let requests = 0;
  const results: { toolCallId: string; result: AgentToolResult }[] = [];
  const owner = await createInstalledConversation({
    ...options,
    conversation: () => ({
      setAvailableTools() {},
      async sendUserMessage() {
        requests++;
        return {
          toolCalls: [
            { id: "read", name: "read_logic", input: { num: 0, offset: null, limit: null } },
            {
              id: "edit",
              name: "propose_changes",
              input: { label: "Forbidden", changes: [{ key: "logic:0", content: "return;" }] },
            },
          ],
        };
      },
      appendToolResults(entries) {
        results.push(...entries);
      },
      async complete() {
        return { text: "Inspected safely.", toolCalls: [] };
      },
      getTranscript() {
        return [];
      },
    }),
  });
  try {
    await owner.agent.submit({ instruction: "Inspect and edit", mode: "create" });
    assert.equal(requests, 1);
    assert.deepEqual(
      results.map(({ result }) => result.success),
      [true, false],
    );
    const first = owner.agent.current();
    owner.agent.newChat("Second");
    await owner.agent.retryChatSave();
    owner.agent.resume(first.id);
    await owner.agent.retryChatSave();
    const reopened = await createInstalledConversation(options);
    try {
      assert.deepEqual(reopened.agent.current().messages, first.messages);
      assert.equal(reopened.agent.chats().length, 2);
      const second = reopened.agent.chats().find((chat) => chat.id !== first.id)!;
      reopened.agent.deleteChat(second.id);
      await reopened.agent.retryChatSave();
      assert.equal((await loadGameConversation(options.locator))!.chats!.chats.length, 1);
    } finally {
      reopened.dispose();
    }
    assert.deepEqual(options.game.files, bytes);
  } finally {
    owner.dispose();
  }
});

test("a second installed page cannot overwrite a newer conversation", async () => {
  const options = fixture("installed-competing");
  const first = await createInstalledConversation(options);
  await first.agent.retryChatSave();
  const second = await createInstalledConversation(options);
  try {
    await first.agent.submit({ instruction: "First page", mode: "play" });
    const kept = await loadGameConversation(options.locator);
    await second.agent.submit({ instruction: "Second page", mode: "play" });
    assert.match(second.agent.chatSaveError, /Retry save/);
    assert.deepEqual(await loadGameConversation(options.locator), kept);
    assert.equal(second.agent.current().messages[0]!.text, "Second page");
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("installed save rejection retains the reply and retry does not repeat the provider request", async () => {
  const options = fixture("installed-failed-write");
  let requests = 0;
  const owner = await createInstalledConversation({
    ...options,
    conversation: () => ({
      setAvailableTools() {},
      async sendUserMessage() {
        requests++;
        return { text: "A retained answer.", toolCalls: [] };
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
  await owner.agent.retryChatSave();
  const set = records.set;
  records.set = function (key, value) {
    if (key === `conversation/${options.locator}`) throw new Error("Storage refused");
    return set.call(this, key, value);
  };
  try {
    assert.equal(
      await owner.agent.submit({ instruction: "Explain", mode: "play" }),
      "A retained answer.",
    );
    assert.match(owner.agent.chatSaveError, /Retry save/);
    records.set = set;
    await owner.agent.retryChatSave();
    assert.equal(requests, 1);
    assert.equal(
      (await loadGameConversation(options.locator))!.chats!.chats[0]!.messages.at(-1)!.text,
      "A retained answer.",
    );
  } finally {
    records.set = set;
    owner.dispose();
  }
});

test("disposing an installed surface while its completed reply commits preserves the conversation", async () => {
  const options = fixture("installed-close-write");
  const owner = await createInstalledConversation(options);
  await owner.agent.retryChatSave();
  const set = records.set;
  let closed = false;
  records.set = function (key, value) {
    if (key === `conversation/${options.locator}`) {
      closed = true;
      owner.dispose();
    }
    return set.call(this, key, value);
  };
  try {
    await owner.agent.submit({ instruction: "Explain", mode: "play" });
    assert.equal(closed, true);
    const stored = (await loadGameConversation(options.locator))!.chats!;
    assert.equal(stored.chats[0]!.messages.at(-1)!.role, "assistant");
    assert.deepEqual(stored.chats[0]!.messages, owner.agent.current().messages);
  } finally {
    records.set = set;
    owner.dispose();
  }
});

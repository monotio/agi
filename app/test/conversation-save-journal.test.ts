import { installWebLocksFixture } from "./webLocksFixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentChat, AgentChats } from "../../src/agent/chats.ts";
import {
  conversationJournalKey,
  mergeConversationChats,
  resumeConversationJournals,
  writeConversationJournal,
} from "../src/project/conversationSaveJournal.ts";

installWebLocksFixture();

function chat(id: string, ...texts: string[]): AgentChat {
  return {
    id,
    title: id,
    provider: "stub",
    model: "stub",
    transcript: [],
    messages: texts.map((text, index) => ({
      id: `${id}-${index}`,
      role: index % 2 ? "assistant" : "user",
      text,
    })),
  };
}
function chats(active: string | null, ...entries: AgentChat[]): AgentChats {
  return { format: "monotio.agi.chats", version: 1, active, chats: entries };
}
const texts = (value: AgentChats) =>
  Object.fromEntries(value.chats.map((entry) => [entry.id, entry.messages.map((m) => m.text)]));

test("a journal over its own base replaces the stored chats exactly", () => {
  const base = chats("a", chat("a", "Hi"));
  const journal = chats("a", chat("a", "Hi", "Hello"));
  assert.deepEqual(mergeConversationChats(base, base, journal), journal);
});

test("a write that landed before the page closed merges to the same chats", () => {
  const base = chats("a", chat("a", "Hi"));
  const journal = chats("a", chat("a", "Hi", "Hello"), chat("b", "New"));
  assert.deepEqual(mergeConversationChats(journal, base, journal), journal);
});

test("an older base still takes the journal's continuation of a newer stored chat", () => {
  const base = chats("a", chat("a", "Hi"));
  const stored = chats("a", chat("a", "Hi", "Hello"));
  const journal = chats("a", chat("a", "Hi", "Hello", "More", "Answer"));
  assert.deepEqual(texts(mergeConversationChats(stored, base, journal)), texts(journal));
});

test("deletions apply only to chats the other side left unchanged", () => {
  const base = chats("a", chat("a", "Keep"), chat("b", "Old"), chat("c", "Old"));
  // The closed page deleted b and c; another page has since continued c and deleted a.
  const stored = chats("c", chat("b", "Old"), chat("c", "Old", "Continued"));
  const journal = chats("a", chat("a", "Keep", "Answer"));
  const merged = mergeConversationChats(stored, base, journal);
  assert.deepEqual(texts(merged), { c: ["Old", "Continued"], a: ["Keep", "Answer"] });
  assert.equal(merged.active, "a");
});

test("diverged continuations keep both, with the closed page's copy active", () => {
  const base = chats("a", chat("a", "Hi"));
  const stored = chats("a", chat("a", "Hi", "Elsewhere"));
  const journal = chats("a", {
    ...chat("a", "Hi"),
    messages: [...chat("a", "Hi").messages, { id: "closed-1", role: "assistant", text: "Here" }],
  });
  const merged = mergeConversationChats(stored, base, journal);
  assert.equal(merged.chats.length, 2);
  assert.deepEqual(merged.chats[0], stored.chats[0]);
  const copy = merged.chats[1]!;
  assert.notEqual(copy.id, "a");
  assert.deepEqual(copy.messages, journal.chats[0]!.messages);
  assert.equal(merged.active, copy.id);
});

test("an unreadable or newer journal stays in place and does not block opening", async () => {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  } as Storage;
  const newer = conversationJournalKey("installed:game", "newer");
  const broken = conversationJournalKey("installed:game", "broken");
  const readable = conversationJournalKey("installed:game", "readable");
  const entry = { base: null, chats: chats("a", chat("a", "Hi")) };
  writeConversationJournal(storage, readable, entry);
  values.set(newer, values.get(readable)!.replace('"version":1', '"version":2'));
  values.set(broken, "{");
  const applied: unknown[] = [];
  await resumeConversationJournals(storage, "installed:game", async (value) => {
    applied.push(value);
  });
  assert.deepEqual(applied, [entry]);
  assert.deepEqual([...values.keys()].sort(), [broken, newer].sort());
});

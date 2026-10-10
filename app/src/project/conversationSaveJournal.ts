/**
 * Installed games keep their conversation in IndexedDB. Each page journals its
 * newest unacknowledged chats synchronously in browser storage, under a key it
 * owns through the project journal's lock, so an answer survives the tab
 * closing before the IndexedDB write commits. Opening the conversation again
 * merges journals whose pages have closed.
 */
import { readAgentChats, type AgentChat, type AgentChats } from "../../../src/agent/chats.ts";
import type { ConversationUpdate } from "./gameStorage.ts";
import { decodeJournalValue, encodeJournalValue } from "./projectJournalCapture.ts";
import { withUnownedJournal } from "./projectSaveJournal.ts";

const PREFIX = "monotio_agi.conversation-writes.";

export interface ConversationJournalEntry {
  /** The stored chats this page last saw acknowledged; null before the first save. */
  readonly base: AgentChats | null;
  readonly chats: AgentChats;
}

export function conversationJournalKey(locator: string, owner: string): string {
  return `${PREFIX}${locator}.${owner}`;
}

export function writeConversationJournal(
  storage: Storage,
  key: string,
  entry: ConversationJournalEntry,
): void {
  storage.setItem(key, JSON.stringify({ version: 1, entry: encodeJournalValue(entry) }));
}

function readEntry(raw: string): ConversationJournalEntry | undefined {
  try {
    const journal = JSON.parse(raw) as { version?: unknown; entry?: unknown };
    if (journal.version !== 1) return undefined;
    const entry = decodeJournalValue(journal.entry) as ConversationJournalEntry;
    return {
      base: entry.base === null ? null : readAgentChats(entry.base),
      chats: readAgentChats(entry.chats),
    };
  } catch {
    return undefined;
  }
}

/** The record fields an installed conversation derives from its active chat. */
export function conversationUpdateOf(chats: AgentChats): ConversationUpdate {
  const active = chats.chats.find((chat) => chat.id === chats.active);
  return {
    chats,
    provider: active?.provider ?? "stub",
    model: active?.model ?? "stub",
    transcript: active?.transcript ?? [],
    ...(active?.sessionId ? { sessionId: active.sessionId } : {}),
    chat: active?.messages ?? [],
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** `longer` continues `shorter` when it holds the same messages first. */
function continues(longer: AgentChat, shorter: AgentChat): boolean {
  return (
    shorter.messages.length <= longer.messages.length &&
    shorter.messages.every((message, index) => message.id === longer.messages[index]!.id)
  );
}

/**
 * Three-way merge of a closed page's chats into the stored ones. A chat only
 * one side changed takes that side; a chat both changed takes the longer
 * continuation, or keeps both when they diverged. Nothing either side added
 * is dropped.
 */
export function mergeConversationChats(
  stored: AgentChats | null,
  base: AgentChats | null,
  journal: AgentChats,
): AgentChats {
  if (same(stored?.chats ?? null, base?.chats ?? null)) return readAgentChats(journal);
  const before = new Map(base?.chats.map((chat) => [chat.id, chat]));
  const ours = new Map(journal.chats.map((chat) => [chat.id, chat]));
  const theirs = new Set(stored?.chats.map((chat) => chat.id));
  const chats: AgentChat[] = [];
  let active = journal.active;
  for (const kept of stored?.chats ?? []) {
    const mine = ours.get(kept.id);
    const original = before.get(kept.id);
    if (mine === undefined) {
      if (original === undefined || !same(kept, original)) chats.push(kept);
    } else if (same(mine, kept) || (original !== undefined && same(mine, original)))
      chats.push(kept);
    else if ((original !== undefined && same(kept, original)) || continues(mine, kept))
      chats.push(mine);
    else if (continues(kept, mine)) chats.push(kept);
    else {
      const id = `chat-recovered-${crypto.randomUUID()}`;
      chats.push(kept, { ...mine, id, sessionId: crypto.randomUUID() });
      if (active === mine.id) active = id;
    }
  }
  for (const mine of journal.chats) {
    if (theirs.has(mine.id)) continue;
    const original = before.get(mine.id);
    if (original === undefined || !same(mine, original)) chats.push(mine);
  }
  const present = (id: string | null | undefined) =>
    id != null && chats.some((chat) => chat.id === id) ? id : undefined;
  return readAgentChats({
    format: "monotio.agi.chats",
    version: 1,
    active: present(active) ?? present(stored?.active) ?? chats[0]?.id ?? null,
    chats,
  });
}

const recovering = new Map<string, Promise<void>>();

/** Apply the journals of closed pages for `locator`, one owner at a time. */
export function resumeConversationJournals(
  storage: Storage,
  locator: string,
  apply: (entry: ConversationJournalEntry) => Promise<void>,
): Promise<void> | undefined {
  const active = recovering.get(locator);
  if (active) return active;
  const prefix = `${PREFIX}${locator}.`;
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    // Owner tokens contain no dots; locators may.
    if (key?.startsWith(prefix) && !key.slice(prefix.length).includes(".")) keys.push(key);
  }
  if (keys.length === 0) return undefined;
  const run = (async () => {
    for (const key of keys.sort())
      await withUnownedJournal(key, async () => {
        const raw = storage.getItem(key);
        // An unreadable or newer journal stays in place for an app that can read it.
        const entry = raw === null ? undefined : readEntry(raw);
        if (entry === undefined) return;
        await apply(entry);
        if (storage.getItem(key) === raw) storage.removeItem(key);
      });
  })().finally(() => recovering.delete(locator));
  recovering.set(locator, run);
  return run;
}

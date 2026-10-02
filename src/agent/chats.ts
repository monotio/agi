/** Task conversations are private project data; credentials never enter this schema. */
interface AgentChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly context?: string;
  readonly beforeCommit?: string;
  readonly commit?: string;
}
export interface AgentChat {
  readonly id: string;
  title: string;
  provider: string;
  model: string;
  transcript: unknown[];
  messages: AgentChatMessage[];
  background?: boolean;
  archived?: boolean;
  summary?: string;
}
export interface AgentChats {
  readonly format: "monotio.agi.chats";
  readonly version: 1;
  active: string | null;
  chats: AgentChat[];
}
export function chatTitle(text: string): string {
  return text.trim().split(/\n/)[0]?.slice(0, 72) || "New chat";
}
function transcriptMessages(transcript: unknown[], prefix: string): AgentChatMessage[] {
  const messages: AgentChatMessage[] = [];
  for (const [index, item] of transcript.entries()) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const role = record["role"];
    if (role !== "user" && role !== "assistant") continue;
    const content = record["text"] ?? record["content"];
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (block) =>
                  block &&
                  ["text", "input_text", "output_text"].includes(block.type) &&
                  typeof block.text === "string",
              )
              .map((block) => block.text)
              .join("\n")
          : "";
    if (text.trim()) messages.push({ id: `${prefix}-${index}`, role, text });
  }
  return messages;
}
function requestText(transcript: unknown[]): string {
  return (
    transcriptMessages(transcript, "title").find((message) => message.role === "user")?.text ?? ""
  );
}
export function readAgentChats(value: unknown): AgentChats {
  if (!value || typeof value !== "object") throw new Error("Invalid game chats.");
  const raw = value as AgentChats;
  if (Object.keys(raw).some((key) => !["format", "version", "active", "chats"].includes(key)))
    throw new Error("Unknown game chats field.");
  if (raw.format !== "monotio.agi.chats" || raw.version !== 1)
    throw new Error("Unsupported game chats version.");
  if (!Array.isArray(raw.chats) || (raw.active !== null && typeof raw.active !== "string"))
    throw new Error("Invalid game chats.");
  const ids = new Set<string>();
  for (const chat of raw.chats) {
    if (
      !chat ||
      typeof chat.id !== "string" ||
      ids.has(chat.id) ||
      typeof chat.title !== "string" ||
      !["stub", "openai", "anthropic"].includes(chat.provider) ||
      typeof chat.model !== "string" ||
      !Array.isArray(chat.transcript) ||
      !Array.isArray(chat.messages)
    )
      throw new Error("Invalid game chat.");
    ids.add(chat.id);
    const messageIds = new Set<string>();
    for (const message of chat.messages) {
      if (
        !message ||
        typeof message.id !== "string" ||
        messageIds.has(message.id) ||
        !["user", "assistant"].includes(message.role) ||
        typeof message.text !== "string" ||
        Object.keys(message).some(
          (key) => !["id", "role", "text", "context", "beforeCommit", "commit"].includes(key),
        ) ||
        (message.context !== undefined && typeof message.context !== "string") ||
        (message.commit !== undefined &&
          (typeof message.commit !== "string" || typeof message.beforeCommit !== "string")) ||
        (message.beforeCommit !== undefined && message.commit === undefined)
      )
        throw new Error("Invalid chat message.");
      messageIds.add(message.id);
    }
    if (
      (chat.background !== undefined && typeof chat.background !== "boolean") ||
      (chat.archived !== undefined && typeof chat.archived !== "boolean") ||
      (chat.summary !== undefined && typeof chat.summary !== "string")
    )
      throw new Error("Invalid game chat.");
    if (
      Object.keys(chat).some(
        (key) =>
          ![
            "id",
            "title",
            "provider",
            "model",
            "transcript",
            "messages",
            "background",
            "archived",
            "summary",
          ].includes(key),
      )
    )
      throw new Error("Unknown game chat field.");
  }
  if (raw.active !== null && !ids.has(raw.active)) throw new Error("Active game chat is missing.");
  return structuredClone(raw);
}
export function migrateAgentChats(data: {
  chats?: AgentChats | undefined;
  title?: string;
  provider?: string | undefined;
  model?: string | undefined;
  transcript?: unknown[] | undefined;
  conversationHistory?: { provider: string; model: string; transcript: unknown[] }[] | undefined;
}): AgentChats {
  if (data.chats !== undefined) return readAgentChats(data.chats);
  const chats: AgentChat[] = [];
  if (data.transcript?.length)
    chats.push({
      id: "legacy-current",
      title: chatTitle(requestText(data.transcript)) || `Created ${data.title ?? "game"}`,
      provider: data.provider ?? "stub",
      model: data.model ?? "stub",
      transcript: structuredClone(data.transcript),
      messages: transcriptMessages(data.transcript, "legacy-current"),
    });
  for (const [i, entry] of (data.conversationHistory ?? []).entries())
    chats.push({
      id: `legacy-archive-${i}`,
      title: chatTitle(requestText(entry.transcript)),
      provider: entry.provider,
      model: entry.model,
      transcript: structuredClone(entry.transcript),
      messages: transcriptMessages(entry.transcript, `legacy-archive-${i}`),
      archived: true,
    });
  return { format: "monotio.agi.chats", version: 1, active: chats[0]?.id ?? null, chats };
}

/** Merge automatic task entries without changing the user's active conversation. */
export function appendAgentTasks(
  data: Parameters<typeof migrateAgentChats>[0],
  entries: readonly AgentChat[],
): AgentChats {
  const store = migrateAgentChats(data);
  for (const entry of entries)
    if (!store.chats.some((chat) => chat.id === entry.id)) store.chats.push(structuredClone(entry));
  return readAgentChats(store);
}

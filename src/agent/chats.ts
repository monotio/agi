import {
  readProjectWorkspace,
  type PortableProjectWorkspace,
} from "../authoring/projectWorkspace.ts";
import { PROFILES, type ProfileId } from "../runtime/profile.ts";
import { validateTranscript } from "./transcript.ts";

/** Task conversations are private project data; credentials never enter this schema. */
export interface AgentRequest {
  readonly id: string;
  readonly mode: "play" | "create";
  readonly capability: "inspect" | "edit";
  readonly profileId: ProfileId;
  readonly documentId: string;
  readonly revision: number;
  readonly context: string;
}
export type AgentResult =
  | {
      readonly kind: "changes";
      readonly documentId: string;
      readonly resources: readonly string[];
      readonly status: "pending" | "applied" | "rejected";
    }
  | {
      readonly kind: "resources";
      readonly documentId: string;
      readonly resources: readonly string[];
      readonly snapshot?: PortableProjectWorkspace;
      readonly profileId?: ProfileId;
    }
  | { readonly kind: "commands"; readonly commands: readonly string[] }
  | {
      readonly kind: "table";
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  | {
      readonly kind: "diagnostics";
      readonly items: readonly { readonly message: string; readonly resource?: string }[];
    };
export interface AgentChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly context?: string;
  readonly request?: AgentRequest;
  readonly taskId?: string;
  readonly delivery?: "queued" | "received" | "cancelled";
  readonly result?: AgentResult;
  readonly spend?: {
    readonly amount: number;
    readonly budget?: number;
    readonly priceKnown: boolean;
    readonly incomplete: boolean;
  };
  readonly review?: PendingAgentReview;
  readonly beforeCommit?: string;
  readonly commit?: string;
}
export interface PendingAgentReview {
  readonly label: string;
  readonly messageId: string;
  readonly baseRevision: number;
  readonly baseDocumentId: string;
  readonly baseCommit: string;
  readonly base: PortableProjectWorkspace;
  readonly baseImage?: PortableProjectWorkspace;
  readonly candidate: PortableProjectWorkspace;
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
  pendingReview?: PendingAgentReview;
  sessionId?: string;
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
function onlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function validateRequest(value: AgentRequest): void {
  if (
    !value ||
    typeof value.id !== "string" ||
    !["play", "create"].includes(value.mode) ||
    !["inspect", "edit"].includes(value.capability) ||
    !Object.hasOwn(PROFILES, value.profileId) ||
    typeof value.documentId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.documentId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.context !== "string" ||
    !onlyKeys(value, [
      "id",
      "mode",
      "capability",
      "profileId",
      "documentId",
      "revision",
      "context",
    ]) ||
    (value.mode === "play" && value.capability !== "inspect")
  )
    throw new Error("Invalid agent request.");
}
function validateResult(value: AgentResult): void {
  let valid = false;
  if (value && typeof value === "object") {
    switch (value.kind) {
      case "changes":
      case "resources":
        valid =
          typeof value.documentId === "string" &&
          /^[a-f0-9]{64}$/.test(value.documentId) &&
          strings(value.resources) &&
          onlyKeys(
            value,
            value.kind === "changes"
              ? ["kind", "documentId", "resources", "status"]
              : ["kind", "documentId", "resources", "snapshot", "profileId"],
          ) &&
          (value.kind !== "changes" || ["pending", "applied", "rejected"].includes(value.status));
        break;
      case "commands":
        valid = strings(value.commands) && onlyKeys(value, ["kind", "commands"]);
        break;
      case "table":
        valid =
          strings(value.columns) &&
          Array.isArray(value.rows) &&
          value.rows.every((row) => strings(row) && row.length === value.columns.length) &&
          onlyKeys(value, ["kind", "columns", "rows"]);
        break;
      case "diagnostics":
        valid =
          Array.isArray(value.items) &&
          value.items.every(
            (item) =>
              item &&
              typeof item.message === "string" &&
              (item.resource === undefined || typeof item.resource === "string") &&
              onlyKeys(item, ["message", "resource"]),
          ) &&
          onlyKeys(value, ["kind", "items"]);
        break;
    }
  }
  if (!valid) throw new Error("Invalid agent result.");
  if (value.kind === "resources") {
    if (value.snapshot !== undefined) readProjectWorkspace(value.snapshot);
    if (value.profileId !== undefined && !Object.hasOwn(PROFILES, value.profileId))
      throw new Error("Invalid result profile.");
  }
}
function validateReview(pending: PendingAgentReview, messageIds: Set<string>): void {
  if (
    !pending ||
    typeof pending.label !== "string" ||
    typeof pending.messageId !== "string" ||
    !messageIds.has(pending.messageId) ||
    !Number.isSafeInteger(pending.baseRevision) ||
    pending.baseRevision < 0 ||
    typeof pending.baseDocumentId !== "string" ||
    !/^[a-f0-9]{64}$/.test(pending.baseDocumentId) ||
    typeof pending.baseCommit !== "string" ||
    !onlyKeys(pending, [
      "label",
      "messageId",
      "baseRevision",
      "baseDocumentId",
      "baseCommit",
      "base",
      "baseImage",
      "candidate",
    ])
  )
    throw new Error("Invalid pending agent review.");
  readProjectWorkspace(pending.base);
  if (pending.baseImage !== undefined) readProjectWorkspace(pending.baseImage);
  readProjectWorkspace(pending.candidate);
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
    validateTranscript(chat.transcript, chat.provider);
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
          (key) =>
            ![
              "id",
              "role",
              "text",
              "context",
              "beforeCommit",
              "commit",
              "request",
              "taskId",
              "delivery",
              "result",
              "spend",
              "review",
            ].includes(key),
        ) ||
        (message.context !== undefined && typeof message.context !== "string") ||
        (message.commit !== undefined &&
          (typeof message.commit !== "string" || typeof message.beforeCommit !== "string")) ||
        (message.beforeCommit !== undefined && message.commit === undefined)
      )
        throw new Error("Invalid chat message.");
      if (
        message.delivery !== undefined &&
        !["queued", "received", "cancelled"].includes(message.delivery)
      )
        throw new Error("Invalid message delivery.");
      if (message.request !== undefined) validateRequest(message.request);
      if (message.taskId !== undefined && typeof message.taskId !== "string")
        throw new Error("Invalid task identity.");
      if (message.result !== undefined) validateResult(message.result);
      if (message.spend !== undefined) {
        const spend = message.spend;
        if (
          !spend ||
          !Number.isFinite(spend.amount) ||
          spend.amount < 0 ||
          typeof spend.priceKnown !== "boolean" ||
          typeof spend.incomplete !== "boolean" ||
          (spend.budget !== undefined && (!Number.isFinite(spend.budget) || spend.budget <= 0)) ||
          !onlyKeys(spend, ["amount", "budget", "priceKnown", "incomplete"])
        )
          throw new Error("Invalid message spend.");
      }
      if (message.review !== undefined) validateReview(message.review, new Set([message.id]));
      messageIds.add(message.id);
    }
    if (chat.pendingReview !== undefined) {
      validateReview(chat.pendingReview, messageIds);
    }
    if (
      (chat.background !== undefined && typeof chat.background !== "boolean") ||
      (chat.archived !== undefined && typeof chat.archived !== "boolean") ||
      (chat.summary !== undefined && typeof chat.summary !== "string") ||
      (chat.sessionId !== undefined &&
        (typeof chat.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(chat.sessionId)))
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
            "pendingReview",
            "sessionId",
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
  sessionId?: string | undefined;
  conversationHistory?: { provider: string; model: string; transcript: unknown[] }[] | undefined;
}): AgentChats {
  if (data.chats !== undefined) return readAgentChats(data.chats);
  const chats: AgentChat[] = [];
  if (data.transcript?.length)
    chats.push({
      id: "legacy-current",
      ...(data.sessionId === undefined ? {} : { sessionId: data.sessionId }),
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
  return readAgentChats({
    format: "monotio.agi.chats",
    version: 1,
    active: chats[0]?.id ?? null,
    chats,
  });
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

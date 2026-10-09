import type { AgentChat, AgentResult } from "../../../src/agent/chats.ts";

function text(value: string): string {
  return value
    .replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, "[image]")
    .replace(/base64 window at offset[^\n]*/g, "[binary window]");
}

function resultSummary(result: AgentResult): unknown {
  switch (result.kind) {
    case "resources":
      return { kind: result.kind, documentId: result.documentId, resources: result.resources };
    case "changes":
      return {
        kind: result.kind,
        documentId: result.documentId,
        resources: result.resources,
        status: result.status,
      };
    case "commands":
      return { kind: result.kind, commands: result.commands.map(text) };
    case "table":
      return {
        kind: result.kind,
        columns: result.columns.map(text),
        rows: result.rows.map((row) => row.map(text)),
      };
    case "diagnostics":
      return {
        kind: result.kind,
        items: result.items.map((item) => ({
          message: text(item.message),
          ...(item.resource === undefined ? {} : { resource: item.resource }),
        })),
      };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Only semantic tool outcomes cross providers; tool payloads remain in the saved transcript. */
function outcome(value: unknown): unknown {
  const parsed = parse(value);
  const item = record(parsed);
  if (!item) return typeof parsed === "string" ? { message: text(parsed) } : undefined;
  if (item["result"] !== undefined) return outcome(item["result"]);
  if (typeof item["success"] !== "boolean") return undefined;
  const details = record(item["details"]);
  const metadata: Record<string, unknown> = {};
  for (const key of [
    "key",
    "resource",
    "kind",
    "length",
    "offset",
    "nextOffset",
    "sha256",
    "revision",
  ])
    if (["string", "number"].includes(typeof details?.[key])) metadata[key] = details![key];
  return {
    success: item["success"],
    ...(typeof item["message"] === "string" && details?.["kind"] !== "bytes"
      ? { message: text(item["message"]) }
      : {}),
    ...(typeof item["error"] === "string" ? { error: text(item["error"]) } : {}),
    ...(Object.keys(metadata).length ? { resource: metadata } : {}),
  };
}

function toolText(content: unknown): unknown[] {
  if (typeof content === "string") {
    const summary = outcome(content);
    return summary === undefined ? [] : [summary];
  }
  if (!Array.isArray(content)) return [];
  return content.flatMap((value) => {
    const block = record(value);
    if (!block || !["text", "input_text", "output_text"].includes(String(block["type"]))) return [];
    return toolText(block["text"]);
  });
}

function assistantText(value: string): string {
  const wrapped = record(parse(value));
  if (typeof wrapped?.["toolCallId"] === "string" && record(wrapped["result"]))
    return JSON.stringify(outcome(wrapped["result"]) ?? {});
  return text(value);
}

function toolRecords(transcript: readonly unknown[]): unknown[] {
  const calls = new Map<string, { tool: string; resources: unknown[] }>();
  const outcomes: unknown[] = [];
  function call(item: Record<string, unknown>, id: unknown, input: unknown): void {
    if (typeof id !== "string" || typeof item["name"] !== "string") return;
    const args = record(parse(input));
    const resources = ["key", "target", "num", "room"].flatMap((key) =>
      ["string", "number"].includes(typeof args?.[key]) ? [args![key]] : [],
    );
    calls.set(id, { tool: item["name"], resources });
  }
  function output(id: unknown, content: unknown): void {
    const summaries = toolText(content);
    if (summaries.length)
      outcomes.push({ ...(typeof id === "string" ? calls.get(id) : {}), outcomes: summaries });
  }
  for (const value of transcript) {
    const item = record(value);
    if (!item) continue;
    if (item["type"] === "function_call") call(item, item["call_id"], item["arguments"]);
    else if (item["type"] === "function_call_output") output(item["call_id"], item["output"]);
    else if (Array.isArray(item["content"])) {
      for (const value of item["content"]) {
        const block = record(value);
        if (block?.["type"] === "tool_use") call(block, block["id"], block["input"]);
        else if (block?.["type"] === "tool_result") output(block["tool_use_id"], block["content"]);
      }
    } else if (typeof item["text"] === "string") {
      const wrapped = record(parse(item["text"]));
      if (wrapped?.["result"] !== undefined) output(wrapped["toolCallId"], item["text"]);
    }
  }
  return outcomes;
}

/** Handoff input is conversational text and outcomes, never UI or persistence records. */
export function agentHandoffContext(chat: AgentChat): string {
  const messages = chat.messages.map((message) => ({
    role: message.role,
    text: message.role === "assistant" ? assistantText(message.text) : text(message.text),
    ...(message.context === undefined ? {} : { context: text(message.context) }),
    ...(message.request === undefined
      ? {}
      : {
          request: {
            mode: message.request.mode,
            capability: message.request.capability,
            documentId: message.request.documentId,
            context: text(message.request.context),
          },
        }),
    ...(message.delivery === undefined ? {} : { delivery: message.delivery }),
    ...(message.result === undefined ? {} : { result: resultSummary(message.result) }),
    ...(message.review === undefined ? {} : { review: { label: text(message.review.label) } }),
  }));
  return `Task messages:\n${JSON.stringify(messages)}\nTool outcomes:\n${JSON.stringify(toolRecords(chat.transcript))}\nPrevious summary:\n${text(chat.summary ?? "")}`;
}

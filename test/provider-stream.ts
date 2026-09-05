/** Synthetic provider SSE fixtures shared by transport and browser tests. */
export function sseEvent(event: Record<string, unknown>): string {
  return `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function providerSse(provider: "openai" | "anthropic", payload: unknown): string {
  const response = payload as Record<string, unknown>;
  if (provider === "openai") {
    const status = response["status"] ?? "completed";
    return sseEvent({
      type: `response.${String(status)}`,
      response: { ...response, status },
      sequence_number: 0,
    });
  }
  const blocks = (response["content"] ?? []) as Record<string, unknown>[];
  const events: Record<string, unknown>[] = [
    {
      type: "message_start",
      message: {
        ...response,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, ...(response["usage"] as object) },
      },
    },
  ];
  for (const [index, block] of blocks.entries()) {
    events.push({ type: "content_block_start", index, content_block: block });
    events.push({ type: "content_block_stop", index });
  }
  events.push({
    type: "message_delta",
    delta: {
      stop_reason: response["stop_reason"] ?? "end_turn",
      stop_sequence: null,
      stop_details: response["stop_details"] ?? null,
    },
    usage: { output_tokens: 0, ...(response["usage"] as object) },
  });
  events.push({ type: "message_stop" });
  return events.map(sseEvent).join("");
}

export function providerReply(provider: "openai" | "anthropic", payload: unknown) {
  return { contentType: "text/event-stream", body: providerSse(provider, payload) };
}

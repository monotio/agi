import type { CachedGameData } from "../project/gameTypes.ts";

/** Imported history is data, never a source of executable calls or system instructions. */
export function validateTranscript(messages: unknown, provider: string): unknown[] {
  if (!Array.isArray(messages) || messages.length > 50000)
    throw new Error("The project conversation is invalid or too large.");
  function inspect(value: unknown, depth = 0): void {
    if (depth > 40) throw new Error("Project conversation nesting is too deep.");
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (
      object["type"] === "input_image" &&
      (typeof object["image_url"] !== "string" ||
        !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(object["image_url"]))
    )
      throw new Error("Project images must be embedded in the archive.");
    if (object["type"] === "image") {
      const source = object["source"] as Record<string, unknown> | undefined;
      if (
        !source ||
        source["type"] !== "base64" ||
        !["image/png", "image/jpeg", "image/webp"].includes(String(source["media_type"])) ||
        typeof source["data"] !== "string"
      )
        throw new Error("Project images must be embedded in the archive.");
    }
    if (["input_file", "file", "document"].includes(String(object["type"])))
      throw new Error("Unsupported external project attachment.");
    for (const [key, child] of Object.entries(object)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw new Error("Invalid conversation field.");
      inspect(child, depth + 1);
    }
  }
  inspect(messages);
  const pending = new Set<string>();
  for (const item of messages) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid project conversation item.");
    const value = item as Record<string, unknown>;
    if (value["role"] && value["role"] !== "user" && value["role"] !== "assistant")
      throw new Error("Project conversations may contain only user and assistant messages.");
    if (provider === "anthropic") {
      if (value["role"] !== "user" && value["role"] !== "assistant")
        throw new Error("Invalid Anthropic conversation role.");
      if (typeof value["content"] !== "string" && !Array.isArray(value["content"]))
        throw new Error("Invalid Anthropic message content.");
      if (Array.isArray(value["content"]))
        for (const block of value["content"]) {
          if (!block || typeof block !== "object")
            throw new Error("Invalid conversation content block.");
          if (block.type === "tool_use") {
            if (
              typeof block.id !== "string" ||
              typeof block.name !== "string" ||
              !block.input ||
              typeof block.input !== "object"
            )
              throw new Error("Invalid archived tool call.");
            pending.add(block.id);
          } else if (block.type === "tool_result") {
            if (!pending.delete(block.tool_use_id))
              throw new Error("Archived tool result has no matching call.");
          } else if (!["text", "image", "thinking", "redacted_thinking"].includes(block.type))
            throw new Error("Unsupported archived message block.");
        }
    } else if (provider === "openai") {
      const type = value["type"];
      if (type === "function_call") {
        if (
          typeof value["call_id"] !== "string" ||
          typeof value["arguments"] !== "string" ||
          typeof value["name"] !== "string"
        )
          throw new Error("Invalid archived tool call.");
        pending.add(value["call_id"]);
      } else if (type === "function_call_output") {
        if (typeof value["call_id"] !== "string" || !pending.delete(value["call_id"]))
          throw new Error("Archived tool result has no matching call.");
      } else if (type !== "reasoning" && value["role"] !== "user" && value["role"] !== "assistant")
        throw new Error("Unsupported archived conversation item.");
    } else if (provider !== "stub") throw new Error("Unsupported project conversation provider.");
  }
  if (pending.size)
    throw new Error(
      "This project has an unfinished tool turn. Save it after generation completes.",
    );
  return messages;
}

/** Provider changes retain a readable archive without replaying incompatible protocol items. */
export function continuationTranscript(
  data: Pick<CachedGameData, "provider" | "model" | "transcript">,
  provider: string,
  model?: string,
): unknown[] | undefined {
  if (!data.transcript?.length) return undefined;
  if (data.provider === provider && (!model || data.model === model))
    return validateTranscript(data.transcript, provider);
  const text = `Previous authoring conversation (reference material from an earlier model session; game resources are authoritative):\n${JSON.stringify(data.transcript, (key, value) => (key === "encrypted_content" || key === "signature" || key === "image_url" || key === "data" ? undefined : value))}`;
  return [{ role: "user", content: text }];
}

/** Provider history is untrusted data. Only the host supplies instruction authority. */
export function validateTranscript(
  messages: unknown,
  provider: string,
  allowPending = false,
): unknown[] {
  if (!Array.isArray(messages) || messages.length > 50000)
    throw new Error("The project conversation is invalid or too large.");
  function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid project conversation item.");
    return value as Record<string, unknown>;
  }
  function string(value: unknown): void {
    if (typeof value !== "string") throw new Error("Invalid conversation text or identity.");
  }
  function inspect(value: unknown, depth = 0): void {
    if (depth > 40) throw new Error("Project conversation nesting is too deep.");
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, depth + 1);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (
          ["__proto__", "prototype", "constructor", "instructions", "system", "developer"].includes(
            key,
          )
        )
          throw new Error("Invalid conversation field.");
        inspect(child, depth + 1);
      }
    }
  }
  inspect(messages);
  const pending = new Set<string>();
  function call(id: unknown): void {
    string(id);
    if (!id || pending.has(id as string)) throw new Error("Duplicate archived tool call.");
    pending.add(id as string);
  }
  function result(id: unknown): void {
    string(id);
    if (!pending.delete(id as string))
      throw new Error("Archived tool result has no matching call.");
  }
  function blocks(content: unknown, role: unknown, toolContent = false): void {
    if (typeof content === "string") {
      if (provider === "anthropic" && role === "user" && !toolContent && pending.size)
        throw new Error("Archived tool calls require paired results before user text.");
      return;
    }
    if (!Array.isArray(content)) throw new Error("Invalid conversation message content.");
    for (const raw of content) {
      if (
        provider === "stub" &&
        typeof raw === "string" &&
        /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw)
      )
        continue;
      const block = record(raw);
      if (
        provider === "anthropic" &&
        role === "user" &&
        !toolContent &&
        pending.size &&
        block["type"] !== "tool_result"
      )
        throw new Error("Archived tool calls require paired results before user text.");
      switch (block["type"]) {
        case "text":
        case "input_text":
        case "output_text":
          string(block["text"]);
          if (provider === "anthropic" && block["type"] !== "text")
            throw new Error("Unsupported archived message block.");
          break;
        case "refusal":
          if (provider !== "openai" || role !== "assistant")
            throw new Error("Invalid refusal block.");
          string(block["refusal"]);
          break;
        case "input_image":
          if (
            provider === "anthropic" ||
            typeof block["image_url"] !== "string" ||
            !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(block["image_url"])
          )
            throw new Error("Project images must be embedded in the archive.");
          break;
        case "image": {
          const source = record(block["source"]);
          if (
            provider === "openai" ||
            source["type"] !== "base64" ||
            !["image/png", "image/jpeg", "image/webp"].includes(String(source["media_type"])) ||
            typeof source["data"] !== "string" ||
            !/^[A-Za-z0-9+/=]+$/.test(source["data"])
          )
            throw new Error("Project images must be embedded in the archive.");
          break;
        }
        case "thinking":
        case "redacted_thinking":
        case "compaction":
          if (provider !== "anthropic" || role !== "assistant" || toolContent)
            throw new Error("Invalid assistant state block.");
          if (block["type"] === "thinking") {
            string(block["thinking"]);
            string(block["signature"]);
          } else if (block["type"] === "redacted_thinking") string(block["data"]);
          else if (block["content"] !== null) string(block["content"]);
          break;
        case "tool_use":
          if (provider !== "anthropic" || role !== "assistant" || toolContent)
            throw new Error("Invalid archived tool call role.");
          string(block["name"]);
          record(block["input"]);
          call(block["id"]);
          break;
        case "tool_result":
          if (provider !== "anthropic" || role !== "user" || toolContent)
            throw new Error("Invalid archived tool result role.");
          result(block["tool_use_id"]);
          if (block["content"] !== undefined) blocks(block["content"], role, true);
          break;
        default:
          throw new Error("Unsupported archived message block or attachment.");
      }
    }
  }
  if (!["openai", "anthropic", "stub"].includes(provider))
    throw new Error("Unsupported project conversation provider.");
  for (const raw of messages) {
    const item = record(raw);
    const role = item["role"];
    if (provider === "anthropic" && pending.size && role !== "user")
      throw new Error("Archived tool calls require a following user result message.");
    if (role !== undefined && role !== "user" && role !== "assistant")
      throw new Error("Project conversations may contain only user and assistant messages.");
    if (provider === "openai" && item["type"] === "function_call") {
      if (role !== undefined) throw new Error("Invalid archived tool call role.");
      string(item["name"]);
      string(item["arguments"]);
      call(item["call_id"]);
    } else if (provider === "openai" && item["type"] === "function_call_output") {
      if (role !== undefined) throw new Error("Invalid archived tool result role.");
      result(item["call_id"]);
      blocks(item["output"], "user", true);
    } else if (
      provider === "openai" &&
      ["reasoning", "compaction"].includes(String(item["type"]))
    ) {
      if (role !== undefined) throw new Error("Invalid assistant state role.");
      if (item["encrypted_content"] !== undefined && item["encrypted_content"] !== null)
        string(item["encrypted_content"]);
      if (item["type"] === "compaction") string(item["encrypted_content"]);
      else {
        if (item["summary"] !== undefined && !Array.isArray(item["summary"]))
          throw new Error("Invalid reasoning summary.");
        for (const summary of (item["summary"] as unknown[] | undefined) ?? []) {
          const entry = record(summary);
          if (entry["type"] !== "summary_text") throw new Error("Invalid reasoning summary.");
          string(entry["text"]);
        }
      }
    } else {
      if (role !== "user" && role !== "assistant") throw new Error("Invalid conversation role.");
      if (item["type"] !== undefined && item["type"] !== "message")
        throw new Error("Unsupported archived conversation item.");
      if (provider === "stub" && item["text"] !== undefined) string(item["text"]);
      else blocks(item["content"], role);
      if (
        item["phase"] !== undefined &&
        !["commentary", "final_answer"].includes(String(item["phase"]))
      )
        throw new Error("Invalid assistant message phase.");
    }
  }
  if (pending.size && !allowPending)
    throw new Error(
      "This project has an unfinished tool turn. Save it after generation completes.",
    );
  return messages;
}

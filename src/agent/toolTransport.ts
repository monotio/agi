import type { AgentToolImage, AgentToolResult, ToolDefinition } from "./tools.ts";

export interface ToolContent {
  text: string;
  images: readonly AgentToolImage[];
}

export type OpenAiToolBlock =
  { type: "input_text"; text: string } | { type: "input_image"; detail: "high"; image_url: string };
export type AnthropicToolBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } };

export function splitToolResult(result: AgentToolResult): ToolContent {
  const { images, audio, ...metadata } = result;
  // Current authoring connections accept text and images. A local audio preview
  // must not leak WAV bytes into JSON or be mistaken for model listening.
  if (audio?.length) {
    metadata.details = {
      ...metadata.details,
      audioPreviews: audio.map(({ caption, mimeType, wav }) => ({
        caption,
        mimeType,
        bytes: wav.byteLength,
        delivery: "Local listening preview; audio is not sent to the model.",
      })),
    };
  }
  // Read tools expose source as both human-readable text and structured data.
  // The model needs it once; local callers retain the full tool result.
  const source = metadata.details?.["source"];
  if (typeof source === "string" && metadata.message?.includes(source)) {
    const details = { ...metadata.details };
    delete details["source"];
    metadata.details = details;
  }
  const text = JSON.stringify(metadata, (_key, value: unknown) => {
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      throw new Error("Binary tool data belongs in image attachments, not model text");
    }
    return value;
  });
  return { text, images: images ?? [] };
}

export function openAiToolContent(content: ToolContent): OpenAiToolBlock[] {
  const blocks: OpenAiToolBlock[] = [{ type: "input_text", text: content.text }];
  for (const image of content.images) {
    blocks.push({ type: "input_text", text: image.caption });
    blocks.push({
      type: "input_image",
      detail: "high",
      image_url: `data:image/png;base64,${imageBase64(image.png)}`,
    });
  }
  return blocks;
}

export function anthropicToolContent(content: ToolContent): AnthropicToolBlock[] {
  const blocks: AnthropicToolBlock[] = [{ type: "text", text: content.text }];
  for (const image of content.images) {
    blocks.push({ type: "text", text: image.caption });
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: imageBase64(image.png) },
    });
  }
  return blocks;
}

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: ToolDefinition["parameters"];
}

/**
 * Converts the shared catalog for the Anthropic Messages API. The schemas are
 * sent as written; tool handlers, assembler and container validate arguments.
 * Never set `strict: true` here: Anthropic compiles strict tools into a
 * constrained grammar with limits this catalog exceeds — numeric, string and
 * array constraints are rejected outright, at most 20 tools may be strict, at
 * most 16 parameters may be nullable or union-typed, and even 8 of these tools
 * overflow the compiled grammar (observed September 2026, e.g. request
 * req_011CekXFu7mEkGe69ybWwf5D). OpenAI strict mode keeps the same catalog.
 */
export function anthropicToolDefinitions(
  tools: readonly ToolDefinition[],
): AnthropicToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  is_error: boolean;
  content: AnthropicToolBlock[];
}

/**
 * Builds the Anthropic tool_result block for a tool outcome. The API rejects
 * `is_error: true` unless every block is text ("all content must be type
 * `text` if `is_error` is true"), so a failure that returns images (a failed
 * playtest with frames) keeps its images and relies on the JSON text's
 * `success: false`; text-only failures keep the flag.
 */
export function anthropicToolResult(
  toolUseId: string,
  result: AgentToolResult,
): AnthropicToolResultBlock {
  const content = splitToolResult(result);
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    is_error: !result.success && content.images.length === 0,
    content: anthropicToolContent(content),
  };
}

/** Debugging keeps byte counts; the actual image remains in the provider request. */
export function serializeAgentLog(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    ArrayBuffer.isView(item) || item instanceof ArrayBuffer
      ? { binaryBytes: item.byteLength }
      : item,
  );
}

/** RFC 4648 encoding without Node or browser globals, including subarray views. */
function imageBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const chunks: string[] = [];
  let chunk = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const bits = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    chunk +=
      alphabet[(bits >>> 18) & 63]! +
      alphabet[(bits >>> 12) & 63]! +
      (i + 1 < bytes.length ? alphabet[(bits >>> 6) & 63]! : "=") +
      (i + 2 < bytes.length ? alphabet[bits & 63]! : "=");
    if (chunk.length >= 32768) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  chunks.push(chunk);
  return chunks.join("");
}

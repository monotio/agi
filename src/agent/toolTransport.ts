import type { AgentToolImage, AgentToolResult } from "./tools.ts";

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
  const { images, ...metadata } = result;
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

/**
 * Scripted reference scenarios for the stub provider (`stubScript` in
 * LlmConfig): no key, no network, the production turn loop and tools. Tests
 * and the reference eval's dry run drive them.
 *
 * - "reference-region" reads the request's manifest, views a grid-labelled
 *   region of the attached reference (the first listed one otherwise) with
 *   view_reference, and replies with the colours it found there.
 * - "reference-never" replies that the work matches the reference without
 *   viewing anything: the under-fetch the watch and the eval flag.
 *
 * The transcript records what each request carried, images as caption and
 * PNG size only, so a test can check that no full image rode the request.
 */
import type { AgentToolImage, AgentToolResult } from "../../../src/agent/agentState.ts";
import type { LlmTurnResult, ReferenceStubScript, UnifiedConversation } from "./llmClient.ts";

/** A manifest line: id first, the working size in the fourth field. */
const MANIFEST_LINE = /^(art-[0-9a-f]{10}) · [^\n]*?· (\d+)x(\d+) · [^\n]*$/gm;
/** The corner the region scenario views, in reference pixels. */
const REGION_EDGE = 64;
/**
 * User messages a script answers. A task that keeps asking (a room build
 * nudging for resources the script cannot write) ends in an error instead.
 */
const SCRIPT_MESSAGES = 3;

/** PNG width and height from the IHDR header. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return png.length >= 24
    ? { width: view.getUint32(16), height: view.getUint32(20) }
    : { width: 0, height: 0 };
}

function describeImages(images: readonly AgentToolImage[] | undefined) {
  return (images ?? []).map((image) => ({
    caption: image.caption,
    bytes: image.png.length,
    ...pngSize(image.png),
  }));
}

export function createReferenceStub(script: ReferenceStubScript): UnifiedConversation {
  const transcript: unknown[] = [];
  let calls = 0;
  let messages = 0;
  let last: AgentToolResult | undefined;
  const say = (text: string): LlmTurnResult => {
    transcript.push({ role: "assistant", text });
    return { text, toolCalls: [] };
  };
  return {
    setAvailableTools() {
      // The host dispatcher is the authority; the script only calls what the manifest names.
    },
    async sendUserMessage(text, images) {
      transcript.push({ role: "user", text, images: describeImages(images) });
      if (++messages > SCRIPT_MESSAGES)
        throw new Error("The reference stub's script has ended; it cannot finish this task.");
      const lines = [...text.matchAll(MANIFEST_LINE)];
      if (!lines.length) return say("No reference art came with this request.");
      if (script === "reference-never") return say("The change matches the reference art.");
      const line =
        lines.find((match) => match[0].includes("attached to this request")) ?? lines[0]!;
      const call = {
        id: `stub-${++calls}`,
        name: "view_reference",
        input: {
          id: line[1]!,
          size: "full",
          region: {
            x: 0,
            y: 0,
            w: Math.min(REGION_EDGE, Number(line[2])),
            h: Math.min(REGION_EDGE, Number(line[3])),
          },
          grid: true,
        },
      };
      transcript.push({ role: "assistant", toolCalls: [call] });
      return { toolCalls: [call] };
    },
    appendToolResults(results) {
      for (const { toolCallId, result } of results) {
        transcript.push({
          role: "tool",
          toolCallId,
          success: result.success,
          text: result.success ? result.message : result.error,
          images: describeImages(result.images),
        });
        last = result;
      }
    },
    async complete() {
      if (!last?.success)
        return say(`I could not view the reference: ${last?.error ?? "no result"}`);
      return say(
        `The top-left corner of ${String(last.details?.["id"])} is ${String(last.details?.["colours"])}; I used those colours.`,
      );
    },
    recordInterruption(text) {
      transcript.push({ role: "user", text, images: [] });
    },
    getTranscript() {
      return structuredClone(transcript);
    },
  };
}

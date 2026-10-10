import type { ProjectContent } from "../../../src/authoring/projectContent.ts";
import { readImageReferences } from "../../../src/creative/imageAttachments.ts";
import type { AgentToolResult } from "../../../src/agent/agentState.ts";

/** Resource identities come from tool arguments and validated tool results, never prose. */
export function inspectedResourceKeys(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  result: AgentToolResult,
): string[] {
  if (!result.success) return [];
  if (tool === "read_document" && typeof input["key"] === "string") return [input["key"]];
  const native: Record<string, string> = {
    read_logic: "logic",
    read_picture: "picture",
    read_view: "view",
    read_sound: "sound",
  };
  if (native[tool] && Number.isInteger(input["num"])) return [`${native[tool]}:${input["num"]}`];
  const metadata: Record<string, string> = {
    read_words: "words",
    read_objects: "inventory",
    read_game_tests: "tests",
  };
  if (metadata[tool]) return [metadata[tool]];
  return [];
}

/** Draft previews retain metadata and any referenced image targets and attachments. */
export function resourceRenderingDependencies(
  documents: Readonly<Record<string, ProjectContent>>,
  resource: string,
): Readonly<Record<string, ProjectContent>> {
  const keys = new Set(["words", "inventory", "bindings", "world", "music"]);
  let imageDocument: string | undefined;
  try {
    if (resource === "images" || resource.startsWith("picture:")) {
      const references = readImageReferences(documents);
      const trace = references.traces[resource];
      const images =
        resource === "images"
          ? references.images
          : trace
            ? { [trace.image]: references.images[trace.image]! }
            : {};
      const traces = resource === "images" ? references.traces : trace ? { [resource]: trace } : {};
      imageDocument = JSON.stringify({ ...references, images, traces });
      for (const target of Object.keys(traces)) keys.add(target);
      for (const image of Object.values(images)) {
        keys.add(`attachment:${image.encoded}`);
        keys.add(`attachment:${image.raster}`);
      }
    }
  } catch {
    // A malformed image document remains readable as text.
  }
  return {
    ...Object.fromEntries(
      [...keys].filter((key) => documents[key] !== undefined).map((key) => [key, documents[key]!]),
    ),
    ...(imageDocument === undefined ? {} : { images: imageDocument }),
  };
}

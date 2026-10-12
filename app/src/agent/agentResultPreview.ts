import type { AgentResult } from "../../../src/agent/chats.ts";
import { readProjectWorkspace } from "../../../src/authoring/projectWorkspace.ts";
import { compileProjectDocuments } from "../../../src/authoring/projectDocuments.ts";
import { openContainer } from "../../../src/container/container.ts";
import type { ProjectContent } from "../../../src/authoring/projectContent.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import type { GameContainer } from "../../../src/types.ts";
import { disassembleLogic } from "../../../src/logic/disassembler.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";

/** A sibling draft failure cannot replace or hide this resource's captured bytes. */
export function compileCapturedResource(
  captured: Readonly<Record<string, ProjectContent>>,
  key: string,
  profile: AgiProfile,
): GameContainer | undefined {
  const content = captured[key];
  if (content === undefined || (!/^(logic|picture|view|sound):\d+$/.test(key) && key !== "images"))
    return undefined;
  const documents: Record<string, ProjectContent> =
    key === "images" ? { ...captured } : { [key]: content };
  if (typeof content === "string" && key.startsWith("logic:")) {
    for (const dependency of ["words", "inventory", "bindings"]) {
      if (captured[dependency] !== undefined) documents[dependency] = captured[dependency];
    }
  }
  if (typeof content === "string" && key.startsWith("sound:") && captured["music"] !== undefined)
    documents["music"] = captured["music"];
  try {
    return openContainer(
      compileProjectDocuments({ files: {}, profileId: profile.id, documents }).files(),
      { profile },
    );
  } catch {
    return undefined;
  }
}

/** Older results carry one snapshot; newer reads pin dependencies independently. */
export function capturedResourceDocuments(
  result: Extract<AgentResult, { kind: "resources" }>,
  key: string,
): Readonly<Record<string, ProjectContent>> {
  const snapshot = result.resourceSnapshots?.[key] ?? result.snapshot;
  return snapshot ? readProjectWorkspace(snapshot) : {};
}

/**
 * The text a review shows for a document: its source, or for a LOGIC kept as
 * compiled bytes, the reading the LOGIC editor shows, with the game's words.
 * A diff of an imported game's LOGIC then marks only the lines that changed.
 */
export function reviewText(
  key: string,
  content: ProjectContent | null | undefined,
  documents: Readonly<Record<string, ProjectContent>>,
  profile: AgiProfile,
): string | undefined {
  if (typeof content === "string") return content;
  if (!(content instanceof Uint8Array) || !/^logic:\d+$/.test(key)) return undefined;
  const words = documents["words"];
  let dictionary: Map<string, number> | undefined;
  try {
    dictionary = new Map(
      typeof words === "string"
        ? (JSON.parse(words) as [string, number][])
        : words
          ? parseWordsTok(words).map(({ word, id }) => [word, id])
          : [],
    );
  } catch {
    /* Numeric word identities remain available. */
  }
  try {
    return disassembleLogic(content, { profile, ...(dictionary ? { dictionary } : {}) });
  } catch (error) {
    return `// The logic does not disassemble: ${error instanceof Error ? error.message : String(error)}`;
  }
}

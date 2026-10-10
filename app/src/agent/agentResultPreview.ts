import type { AgentResult } from "../../../src/agent/chats.ts";
import { readProjectWorkspace } from "../../../src/authoring/projectWorkspace.ts";
import { compileProjectDocuments } from "../../../src/authoring/projectDocuments.ts";
import { openContainer } from "../../../src/container/container.ts";
import type { ProjectContent } from "../../../src/authoring/projectContent.ts";
import type { AgiProfile } from "../../../src/runtime/profile.ts";
import type { GameContainer } from "../../../src/types.ts";

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

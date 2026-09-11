import { createAgentSessionState, type AgentSessionState } from "../../../src/agent/tools.ts";
import { validateAuthoringState } from "../../../src/agent/authoringState.ts";
import { openContainer } from "../../../src/container/container.ts";
import { RESOURCE_KINDS, type ResourceKind } from "../../../src/types.ts";
import { validateRoomInventory } from "../../../src/agent/inventory.ts";

/** A candidate tool call owns its container and every mutable authoring map. */
export function forkAgentState(source: AgentSessionState): AgentSessionState {
  const next = createAgentSessionState(openContainer(source.getFiles()));
  Object.assign(next, { profile: source.profile });
  Object.assign(next.sources, structuredClone(source.sources));
  next.authoring = validateAuthoringState(source.authoring);
  next.wordsPayload = source.wordsPayload?.slice();
  next.objectPayload = source.objectPayload?.slice();
  next.testsPayload = source.testsPayload?.slice();
  next.genesisComplete = source.genesisComplete;
  // Diagnostic artifacts are session-scoped and append-only: forks share them
  // so a projected result stays retrievable no matter which candidate ran.
  Object.assign(next, { diagnostics: source.diagnostics });
  for (const [num, count] of source.pictureRounds) next.pictureRounds.set(num, count);
  return next;
}

function payload(
  state: AgentSessionState,
  kind: ResourceKind,
  num: number,
): Uint8Array | null | "corrupt" {
  try {
    return state.container.getResource(kind, num);
  } catch {
    return "corrupt";
  }
}

/** Compare actual compiled resources, independent of a tool's name or its claimed effects. */
export function changedResources(
  before: AgentSessionState,
  after: AgentSessionState,
): { kind: ResourceKind; num: number; payload: Uint8Array }[] {
  const changes: { kind: ResourceKind; num: number; payload: Uint8Array }[] = [];
  for (const kind of RESOURCE_KINDS)
    for (let num = 0; num < 256; num++) {
      const previous = payload(before, kind, num);
      const current = payload(after, kind, num);
      if (previous === current) continue;
      if (current === "corrupt" || !current)
        throw new Error(`Tool produced an invalid or removed ${kind} ${num}.`);
      if (
        previous === "corrupt" ||
        !previous ||
        previous.length !== current.length ||
        current.some((byte, index) => byte !== previous[index])
      )
        changes.push({ kind, num, payload: current });
    }
  return changes;
}

/** Room tools may create this room and fresh dependencies, while preserving the existing game. */
export function validateRoomCandidate(
  original: AgentSessionState,
  before: AgentSessionState,
  candidate: AgentSessionState,
  room: number,
): void {
  for (const resource of changedResources(before, candidate)) {
    const allowed =
      resource.kind === "logic" || resource.kind === "picture"
        ? resource.num === room
        : payload(original, resource.kind, resource.num) === null;
    if (!allowed)
      throw new Error(
        "Room preparation may write only the requested room, new views/sounds, vocabulary, and appended inventory items.",
      );
  }
  for (const [word, id] of original.sources.words)
    if (candidate.sources.words.get(word) !== id)
      throw new Error("Room preparation must preserve existing vocabulary IDs.");
  const objects = candidate.getFiles().get("OBJECT");
  if (objects) validateRoomInventory(original.getFiles().get("OBJECT"), objects, candidate.profile);
  else if (original.getFiles().has("OBJECT"))
    throw new Error("Room preparation cannot remove the inventory table.");
}

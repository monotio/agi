/** Context shared by parts-list opens and requests from Help or references. */
import type { AgiProfile } from "../../../../src/runtime/profile.ts";
import type { ProjectContent } from "../../../../src/authoring/projectContent.ts";
import { readBindingsDocument } from "../../../../src/authoring/projectDocuments.ts";
import { createAuthoringState } from "../../../../src/agent/authoringState.ts";
import { studioRoomSource, studioSpriteSource } from "../../world/studioSource.ts";

export function workspaceStudioContext(
  files: ReadonlyMap<string, Uint8Array>,
  documents: Readonly<Record<string, ProjectContent>>,
  profile: AgiProfile,
  rooms: readonly { room: number; title: string }[],
) {
  const resources = { files: Object.fromEntries(files), profile };
  const authoring = createAuthoringState();
  const bindings = documents["bindings"];
  if (typeof bindings === "string") authoring.bindings = readBindingsDocument(bindings);
  const world = documents["world"];
  if (typeof world === "string") authoring.world = JSON.parse(world) as typeof authoring.world;
  const logics = Object.entries(documents).flatMap(([key, value]) =>
    key.startsWith("logic:") && typeof value === "string" ? [[Number(key.slice(6)), value]] : [],
  );
  const roomContexts = new Map<number, ReturnType<typeof studioRoomSource>>();
  return {
    room: (room: number) => {
      let context = roomContexts.get(room);
      if (!context) {
        context = studioRoomSource(resources, room, rooms, undefined, {
          authoring,
          sources: { logics },
        });
        roomContexts.set(room, context);
      }
      return context;
    },
    sprite: (view: number, first?: number) => studioSpriteSource(resources, view, first),
  };
}

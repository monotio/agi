/**
 * What Room Studio opens on: one picture's stored bytes, the interpreter
 * profile that reads them, and the agent's picture text when it can be
 * trusted. The bytes, and the container files handed on for the actor
 * probe's VIEWs, come from the same booted-resource snapshot the world map
 * scans and renders its thumbnails from.
 */
import { openContainer } from "../../../src/container/container.ts";
import { authoredPictureSource, type AgentSessionState } from "../../../src/agent/tools.ts";
import { detectProfile, type AgiProfile } from "../../../src/runtime/profile.ts";
import type { ScannedResources } from "../useRoomMap.ts";

export interface StudioPictureSource {
  readonly bytes: Uint8Array;
  /** The agent's picture text, only while it compiles to exactly these bytes. */
  readonly authoredSource?: string | undefined;
  readonly profile: AgiProfile;
  /** The booted container files the bytes were read from (the actor probe's VIEWs). */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/** One picture's Studio input; null when the booted game has no such picture. */
export function studioPictureSource(
  resources: Pick<ScannedResources, "files" | "profile">,
  picture: number,
  session: AgentSessionState | undefined,
): StudioPictureSource | null {
  const files = new Map(Object.entries(resources.files));
  let bytes: Uint8Array | undefined;
  try {
    bytes = openContainer(files).getResource("picture", picture) ?? undefined;
  } catch {
    return null;
  }
  if (!bytes) return null;
  // authoredPictureSource trusts the text only while it compiles to the
  // session's resource; that resource must also be the very bytes booted.
  const stored = session?.container.getResource("picture", picture);
  const authoredSource =
    session && stored && sameBytes(stored, bytes)
      ? authoredPictureSource(session, picture)
      : undefined;
  return {
    bytes: bytes.slice(),
    authoredSource,
    profile: resources.profile ?? detectProfile(files),
    files,
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

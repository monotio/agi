/**
 * What Room Studio opens on: one picture's stored bytes, the interpreter
 * profile that reads them, and the authored picture text when it can be
 * trusted. The bytes, and the container files handed on for the actor
 * probe's VIEWs, come from the same booted-resource snapshot the world map
 * scans and renders its thumbnails from. The text is the live session's, or,
 * for a game played without one (a catalog game such as the tutorial, or its
 * remix), the stored project's authoring sources.
 */
import { openContainer } from "../../../src/container/container.ts";
import { authoredPictureSource, type AgentSessionState } from "../../../src/agent/tools.ts";
import { sourceCompilesTo } from "../../../src/picture/source.ts";
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

/**
 * One picture's Studio input; null when the booted game has no such picture.
 * `stored` is the booted project's stored authoring state, read only when no
 * session is live.
 */
export function studioPictureSource(
  resources: Pick<ScannedResources, "files" | "profile">,
  picture: number,
  session: AgentSessionState | undefined,
  stored?: Record<string, unknown> | undefined,
): StudioPictureSource | null {
  const files = new Map(Object.entries(resources.files));
  let bytes: Uint8Array | undefined;
  try {
    bytes = openContainer(files).getResource("picture", picture) ?? undefined;
  } catch {
    return null;
  }
  if (!bytes) return null;
  const profile = resources.profile ?? detectProfile(files);
  let authoredSource: string | undefined;
  if (session) {
    // authoredPictureSource trusts the text only while it compiles to the
    // session's resource; that resource must also be the very bytes booted.
    const resource = session.container.getResource("picture", picture);
    if (resource && sameBytes(resource, bytes))
      authoredSource = authoredPictureSource(session, picture);
  } else {
    // The same trust rule, against the booted bytes themselves.
    const text = storedPictureText(stored, picture);
    if (text !== undefined && sourceCompilesTo(text, bytes, profile)) authoredSource = text;
  }
  return { bytes: bytes.slice(), authoredSource, profile, files };
}

/** A stored authoring state's text for one picture (`sources.pictures`: [number, text] pairs). */
function storedPictureText(
  authoringState: Record<string, unknown> | undefined,
  picture: number,
): string | undefined {
  const sources = authoringState?.["sources"] as { pictures?: unknown } | undefined;
  if (!Array.isArray(sources?.pictures)) return undefined;
  for (const entry of sources.pictures as unknown[])
    if (Array.isArray(entry) && entry[0] === picture && typeof entry[1] === "string")
      return entry[1];
  return undefined;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

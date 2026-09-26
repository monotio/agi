/**
 * What the Studios open on. Room Studio: one picture's stored bytes, the
 * interpreter profile that reads them, and the authored picture text when it
 * can be trusted. The bytes, and the container files handed on for the actor
 * probe's VIEWs, come from the same booted-resource snapshot the world map
 * scans and renders its thumbnails from. The text is the live session's, or,
 * for a game played without one (a catalog game such as the tutorial, or its
 * remix), the stored project's authoring sources. Sprite Studio: one VIEW's
 * bytes from the same snapshot, the rooms whose logic names it
 * (spriteUsage.ts) and the pictures they draw.
 */
import { openContainer } from "../../../src/container/container.ts";
import { authoredPictureSource, type AgentSessionState } from "../../../src/agent/tools.ts";
import { sourceCompilesTo } from "../../../src/picture/source.ts";
import { detectProfile, type AgiProfile } from "../../../src/runtime/profile.ts";
import type { ScannedResources } from "../useRoomMap.ts";
import type { SpriteRoom } from "../shell/useCreateWorkspace.ts";
import { scanContainerExits, type StaticRoomScan } from "../../../src/agent/roomMap.ts";
import { roomPictureUse } from "../../../src/agent/roomPictures.ts";
import { openSprite, type SpriteCel } from "../../../src/studio/sprite/spriteDocument.ts";
import {
  scanViewUsage,
  viewUsage,
  type ViewUsage,
  type ViewUsageIndex,
} from "../../../src/studio/sprite/spriteUsage.ts";

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

/** The VIEW usage scan of one set of booted files, with the room scans it came from. */
interface ViewScan {
  readonly index: ViewUsageIndex;
  readonly scans: ReadonlyMap<number, StaticRoomScan>;
  readonly shared: ReadonlySet<number>;
  readonly pictures: ReadonlySet<number>;
  /** Every VIEW in the files, ascending: its description and first cel when it decodes. */
  readonly views: readonly ViewSummary[];
}

/** One VIEW as the Resources tab and the World panel list it. */
export interface ViewSummary {
  readonly view: number;
  readonly description?: string | undefined;
  /** Loop 0, cel 0 as displayed; undefined when the view does not decode. */
  readonly thumb?: SpriteCel | undefined;
  readonly usage: ViewUsage;
}

/** One scan per booted files object: the World panel and Resources tab ask often. */
const viewScans = new WeakMap<object, ViewScan>();

/** Which logics name which VIEWs, and which rooms draw which pictures, in the booted files. */
export function viewScan(resources: Pick<ScannedResources, "files" | "profile">): ViewScan {
  const cached = viewScans.get(resources.files);
  if (cached) return cached;
  const files = new Map(Object.entries(resources.files));
  const profile = resources.profile ?? detectProfile(files);
  const logics = new Map<number, Uint8Array>();
  const pictures = new Set<number>();
  const payloads = new Map<number, Uint8Array>();
  try {
    const container = openContainer(files);
    for (let num = 0; num < 256; num++) {
      const logic = container.getResource("logic", num);
      if (logic) logics.set(num, logic);
      if (container.getResource("picture", num)) pictures.add(num);
      const view = container.getResource("view", num);
      if (view) payloads.set(num, view);
    }
  } catch {
    // A container that cannot enumerate offers no views.
  }
  const { scans, shared } = scanContainerExits(logics, profile);
  const index = scanViewUsage(logics, profile);
  const views = [...payloads].map(([view, payload]): ViewSummary => {
    const usage = viewUsage(index, view);
    try {
      const document = openSprite(payload, profile);
      return { view, description: document.description, thumb: document.loops[0]?.cels[0], usage };
    } catch {
      return { view, usage };
    }
  });
  const scan = { index, scans, shared, pictures, views };
  viewScans.set(resources.files, scan);
  return scan;
}

/** The VIEWs a room's logic (or a logic it calls) names as constants and the game holds, ascending. */
export function roomViews(
  resources: Pick<ScannedResources, "files" | "profile">,
  room: number,
): ViewSummary[] {
  return viewScan(resources).views.filter((summary) => summary.usage.rooms.includes(room));
}

/** What Sprite Studio opens on: one VIEW's stored bytes, where it is used, and rooms to stand it in. */
export interface StudioSpriteSource {
  readonly bytes: Uint8Array;
  readonly profile: AgiProfile;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly usage: ViewUsage;
  readonly rooms: readonly SpriteRoom[];
}

/**
 * One VIEW's Sprite Studio input; null when the booted game has no such
 * view. The rooms offered for the in-room preview are the rooms that use
 * the view and provably draw a picture (roomPictureUse), `first` (the room
 * the game stands in) leading when it is one of them. `staged` stands in for
 * the stored bytes (a character-sheet candidate not in the game yet).
 */
export function studioSpriteSource(
  resources: Pick<ScannedResources, "files" | "profile">,
  view: number,
  first?: number,
  staged?: Uint8Array,
): StudioSpriteSource | null {
  const files = new Map(Object.entries(resources.files));
  let bytes = staged;
  try {
    bytes ??= openContainer(files).getResource("view", view) ?? undefined;
  } catch {
    return null;
  }
  if (!bytes) return null;
  const profile = resources.profile ?? detectProfile(files);
  const scan = viewScan(resources);
  const usage = viewUsage(scan.index, view);
  const rooms = usage.rooms.flatMap((room): SpriteRoom[] => {
    const use = roomPictureUse(room, scan);
    const picture = use.pictures.find((entry) => entry.exists)?.picture;
    return picture === undefined ? [] : [{ room, picture }];
  });
  rooms.sort((a, b) => (a.room === first ? -1 : b.room === first ? 1 : a.room - b.room));
  return { bytes: bytes.slice(), profile, files, usage, rooms };
}

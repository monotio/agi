/**
 * What the Studios open on. Room Studio: one picture's stored bytes, the
 * interpreter profile that reads them, and the authored picture text when it
 * can be trusted. The bytes, and the container files handed on for the actor
 * probe's VIEWs, come from the same booted-resource snapshot the world map
 * scans and renders its thumbnails from. The text is the live session's, or,
 * for a game played without one (a catalog game such as the tutorial, or its
 * remix), the stored project's authoring sources. Sprite Studio: one VIEW's
 * bytes from the same snapshot, the rooms whose logic names it
 * (viewUsage.ts) and the pictures they draw. Room Studio's Walk view also
 * reads the room's LOGIC: its annotated text under the same trust rule
 * (it must assemble to the booted bytes), the bindings and plan it names,
 * and the game's stored tests.
 */
import { openContainer } from "../../../src/container/container.ts";
import {
  assembleAuthoredLogic,
  authoredPictureSource,
  type AgentSessionState,
} from "../../../src/agent/agentState.ts";
import {
  createAuthoringState,
  validateAuthoringState,
  type AuthoringState,
} from "../../../src/agent/authoringState.ts";
import { parseGameTests, type GameTest } from "../../../src/agent/gameTestFormat.ts";
import { disassembleLogic } from "../../../src/logic/disassembler.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import { sourceCompilesTo } from "../../../src/picture/source.ts";
import { detectProfile, type AgiProfile } from "../../../src/runtime/profile.ts";
import type { ScannedResources } from "./useRoomMap.ts";
import type { SpriteRoom } from "../shell/useCreateWorkspace.ts";
import { scanContainerExits, type StaticRoomScan } from "../../../src/agent/roomMap.ts";
import { roomPictureUse } from "../../../src/agent/roomPictures.ts";
import { openSprite, type SpriteCel } from "../../../src/view/spriteDocument.ts";
import {
  scanViewUsage,
  viewUsage,
  type ViewUsage,
  type ViewUsageIndex,
} from "../../../src/agent/viewUsage.ts";

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

/** A stored authoring state's text for one resource (`sources.pictures`/`logics`: [number, text] pairs). */
function storedPictureText(
  authoringState: Record<string, unknown> | undefined,
  picture: number,
  kind: "pictures" | "logics" = "pictures",
): string | undefined {
  const sources = authoringState?.["sources"] as Record<string, unknown> | undefined;
  const entries = sources?.[kind];
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries as unknown[])
    if (Array.isArray(entry) && entry[0] === picture && typeof entry[1] === "string")
      return entry[1];
  return undefined;
}

/** A room the Walk view can send a door to: the World map's rooms. */
export interface StudioRoomChoice {
  readonly room: number;
  readonly title: string;
}

/**
 * What Room Studio's Walk view reads about the room framing the picture:
 * its logic, the names and plan the logic uses, and the game's tests.
 */
export interface StudioRoomSource {
  readonly room: number;
  /** The room's LOGIC bytes as booted; null when the game has no logic for it. */
  readonly logicBytes: Uint8Array | null;
  /**
   * The annotated logic text, only while it assembles to exactly
   * `logicBytes` with `authoring`'s bindings and the game's dictionary. Rule
   * edits need it; without it the room's exits are read-only.
   */
  readonly logicSource?: string | undefined;
  /** The logic as text to read ("Edit as text…"): the trusted text, else a disassembly. */
  readonly logicText: string;
  /** The game's bindings and world plan. */
  readonly authoring: AuthoringState;
  /** The game's dictionary (WORDS.TOK) for assembling the logic. */
  readonly words: ReadonlyMap<string, number>;
  /** Stored game tests (TESTS.JSON): an exit test covers a door. */
  readonly tests: readonly GameTest[];
  /** Rooms a door can lead to, by number. */
  readonly rooms: readonly StudioRoomChoice[];
}

/**
 * The room's Walk view input from the booted files: the logic bytes, the
 * text trusted to describe them (the live session's, else the stored
 * project's), bindings, plan, dictionary and tests.
 */
export function studioRoomSource(
  resources: Pick<ScannedResources, "files" | "profile">,
  room: number,
  rooms: readonly StudioRoomChoice[],
  session: AgentSessionState | undefined,
  stored?: Record<string, unknown> | undefined,
): StudioRoomSource {
  const files = new Map(Object.entries(resources.files));
  const profile = resources.profile ?? detectProfile(files);
  let logicBytes: Uint8Array | null;
  try {
    logicBytes = openContainer(files).getResource("logic", room);
  } catch {
    logicBytes = null;
  }
  let authoring: AuthoringState;
  try {
    authoring = session
      ? validateAuthoringState(session.authoring)
      : validateAuthoringState(stored?.["authoring"]);
  } catch {
    authoring = createAuthoringState();
  }
  const dictionary = files.get("WORDS.TOK");
  const words = new Map(
    session
      ? session.sources.words
      : dictionary
        ? parseWordsTok(dictionary).map(({ word, id }) => [word, id] as const)
        : [],
  );
  const text = session
    ? session.sources.logics.get(room)
    : storedPictureText(stored, room, "logics");
  let logicSource: string | undefined;
  if (text !== undefined && logicBytes) {
    try {
      const compiled = assembleAuthoredLogic({ profile, authoring, sources: { words } }, text);
      if (sameBytes(compiled.payload, logicBytes)) logicSource = text;
    } catch {
      logicSource = undefined;
    }
  }
  let logicText = logicSource ?? "";
  if (logicSource === undefined && logicBytes) {
    try {
      logicText = disassembleLogic(logicBytes, { profile, dictionary: words });
    } catch (error) {
      logicText = `// The logic does not disassemble: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  let tests: readonly GameTest[];
  try {
    tests = parseGameTests(files.get("TESTS.JSON"), profile).tests;
  } catch {
    tests = [];
  }
  // The map's rooms, titled from the plan where the map has no title, and the plan's other rooms.
  const planned = authoring.world.rooms;
  const choices = new Map(
    rooms.map((choice) => [
      choice.room,
      { room: choice.room, title: choice.title || planned[String(choice.room)]?.title || "" },
    ]),
  );
  for (const [key, plan] of Object.entries(planned)) {
    const num = Number(key);
    if (Number.isInteger(num) && num > 0 && num < 256 && !choices.has(num))
      choices.set(num, { room: num, title: plan.title });
  }
  return {
    room,
    logicBytes: logicBytes && logicBytes.slice(),
    logicSource,
    logicText,
    authoring,
    words,
    tests,
    rooms: [...choices.values()].sort((a, b) => a.room - b.room),
  };
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

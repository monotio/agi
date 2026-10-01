import type { AgentChats } from "../../../src/agent/chats.ts";
import type { PortableProjectHistory } from "../../../src/authoring/projectHistoryCodec.ts";
import type { PortableProjectWorkspace } from "../../../src/authoring/projectWorkspace.ts";
import type { PortableProjectRecovery } from "../../../src/authoring/projectRecovery.ts";
import type { LibraryMetadata } from "./gameMetadata.ts";
import type { StoredReference } from "../references/referenceArt.ts";
import type { ScreenObjectState } from "../../../src/runtime/engine.ts";
import { projectId } from "../../../src/gameIdentity.ts";
import { cellChar } from "../../../src/runtime/textSurface.ts";
import { detectKnownGameByHashes } from "../../../src/games/knownGames.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { GameIdentity, ProjectId, ResourceRevision } from "../../../src/gameIdentity.ts";
import type { ProgressTarget } from "./progressTarget.ts";

/**
 * One library entry's stable id (an imported game, a created adventure, a
 * copy, a remix) and the digest of its playable bytes — the branded identity
 * contract lives in src/gameIdentity.ts; these re-exports keep the app's
 * existing import sites.
 */
export type { ProjectId, ResourceRevision };

export interface CachedGameMeta {
  library?: LibraryMetadata | undefined;
  projectId: ProjectId;
  templateId?: string | undefined;
  generation?: number | undefined;
  title: string;
  authoredAt: string;
  provider?: string | undefined;
  model?: string | undefined;
  sessionId?: string | undefined;
  imported?: boolean | undefined;
  roomGeneration?: boolean | undefined;
}

/**
 * The kept creative-catalog revision this body was published with. The
 * sibling `creative/<projectId>` record is authoritative; the marker only
 * pins which kept revision the body claims, so a missing or moved catalog
 * refuses creative reads instead of pretending empty.
 */
export interface CreativeMarker {
  readonly kept: number;
}

export interface CachedGameData extends CachedGameMeta {
  /** Immutable edit History, separate from player rewind recordings. */
  projectHistory?: PortableProjectHistory | undefined;
  files: Record<string, Uint8Array>;
  words: [string, number][];
  chats?: AgentChats | undefined;
  transcript?: unknown[] | undefined;
  authoringState?: Record<string, unknown> | undefined;
  conversationHistory?: { provider: string; model: string; transcript: unknown[] }[] | undefined;
  /** Player-supplied reference art; project data, never playable bytes. */
  references?: StoredReference[] | undefined;
  /** Unfinished portable work, never installed as kept playable resources. */
  recoveryDraft?: PortableProjectRecovery | undefined;
  /** Exact kept authoring documents; source agreement is checked on editable open. */
  workspace?: PortableProjectWorkspace | undefined;
  /** Kept creative catalog pin; present only on bodies published with creative assets. */
  creative?: CreativeMarker | undefined;
}

export interface BootedGame {
  /** Captured before worker boot; deletion invalidates this history writer. */
  historyLifetime?: string | null;
  /**
   * The physical progress address this game writes under: save slots, the
   * autosave record and the resume pointer take its `locator`, and stored
   * records embed its `identity`. Ephemeral binding data resolved from the
   * boot's evidence (progressBinding.ts), never persisted; a fresh boot or
   * a revision change rebinds it.
   */
  progressTarget?: ProgressTarget | undefined;
  readonly installed: boolean;
  readonly title: string;
  revision: ResourceRevision;
  files: Record<string, Uint8Array>;
  words: [string, number][];
  readonly hash?: string | undefined;
  readonly alias?: string | undefined;
  readonly folder?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  /** An installed remix's declared immediate parent, captured at boot. */
  readonly parent?: GameIdentity | undefined;
  authoredGame?: CachedGameData | undefined;
  /**
   * The stored project holds a newer save than the running game: a Keep
   * saved but not installed, or a write from elsewhere. Nothing writes this
   * game's files to storage until it reloads from storage, which boots a
   * fresh BootedGame without the mark.
   */
  behindStorage?: true | undefined;
  /**
   * The stored project this game runs was removed (in another tab). It is
   * behind storage for good: no reload brings it back. Nothing — checkpoint,
   * save slot, timeline, map or project write — is stored for it; the game
   * plays on in memory and can still be downloaded.
   */
  removed?: true | undefined;
}

export interface InstalledGameDescriptor {
  readonly hash: string;
  readonly alias: string;
  readonly title: string;
  readonly author?: string | undefined;
  readonly walkthroughLabel?: string | undefined;
  readonly wordsSha256?: string | undefined;
  readonly objectSha256?: string | undefined;
  /** Full bundle revision of the served file set — walkthrough offers key on it. */
  readonly revision?: ResourceRevision | undefined;
  readonly folder?: string | undefined;
  /** The interpreter a GAME.JSON export declared; detection decides without one. */
  readonly profile?: ProfileId | undefined;
  /** A remix's declared immediate parent; absent on plain editions and originals. */
  readonly parent?: GameIdentity | undefined;
}

export interface CurrentGame {
  readonly installed: boolean;
  readonly title: string;
  /** The world is unfinished: exits may lead to rooms not built yet. */
  readonly workInProgress: boolean;
  readonly revision: ResourceRevision;
  readonly hash?: string | undefined;
  readonly alias?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly folder?: string | undefined;
  /** An installed remix's declared immediate parent, captured at boot. */
  readonly parent?: GameIdentity | undefined;
  /**
   * The physical progress address this game resolves to, bound when the
   * card's storage evidence was captured. Ephemeral — never persisted.
   */
  readonly progressTarget?: ProgressTarget | undefined;
}

/**
 * One storage identity for a game's progress: installed editions scope by
 * folder (two folders can share a WORDS.TOK hash), authored projects by id.
 * The key doubles as a `ProjectId` in stored records, so a folder name
 * outside the project-id alphabet falls back to the edition's content hash.
 * Save slots, autosaves and the last-game pointer must all resolve to this.
 */
export function gameStorageKey(game: {
  installed: boolean;
  folder?: string | null | undefined;
  hash?: string | null | undefined;
  alias?: string | null | undefined;
  projectId?: string | null | undefined;
}): string {
  if (!game.installed) return game.projectId ?? "";
  const folder = game.folder ?? "";
  if (projectId(folder) !== null) return folder;
  return game.hash ?? game.alias ?? "";
}

/**
 * The catalogued edition among descriptors that answer to one spelling (a
 * convenience hash, alias or folder query): ports share a WORDS.TOK
 * vocabulary hash, so the vocabulary's (WORDS.TOK, OBJECT)-fingerprinted
 * edition — the release walkthroughs and profiles were verified against —
 * is the candidate set. A descriptor that supplies a full bundle revision
 * different from that edition's pinned target is a derivative, not the
 * original, and is excluded; descriptors without revision evidence keep the
 * pair resolution they shipped with (ports pin no revision: the pair is
 * their recognition). Null when no single candidate stands out — the caller
 * refuses the ambiguity rather than choosing first.
 */
export function preferCatalogedEdition<
  T extends {
    wordsSha256?: string | undefined;
    objectSha256?: string | undefined;
    revision?: string | undefined;
  },
>(matches: readonly T[]): T | null {
  const cataloged = matches.filter((m) => {
    if (m.wordsSha256 === undefined) return false;
    const detected = detectKnownGameByHashes(m.wordsSha256, m.objectSha256);
    if (detected === null || detected !== detectKnownGameByHashes(m.wordsSha256)) return false;
    return (
      m.revision === undefined ||
      detected.targetRevision === undefined ||
      m.revision.toLowerCase() === detected.targetRevision.toLowerCase()
    );
  });
  return cataloged.length === 1 ? cataloged[0]! : null;
}

/**
 * Resolve a query spelling to an installed instance's folder. The folder is
 * the explicit instance selector: its exact case-sensitive spelling wins
 * over everything, and a folded spelling counts only when it names a single
 * folder — a case-insensitive filesystem convenience, never a merge of two
 * distinct folders. Hash, alias, revision and vocabulary spellings resolve
 * only when one instance answers — with the catalogued exact edition
 * preferred when revision evidence names it. An ambiguous spelling never
 * lands on an arbitrary folder: the query returns unresolved, and the boot
 * edge (resolveFixtureTarget, or the fixture server's resolveFixtureFolder)
 * refuses it with the ambiguity error.
 */
export function findInstalledFolder(
  installedGames: readonly (string | InstalledGameDescriptor)[] | null | undefined,
  query: string,
): string {
  const entries = installedGames ?? [];
  const exact = entries.find((g) => (typeof g === "string" ? g === query : g.folder === query));
  if (exact !== undefined) {
    return typeof exact === "string" ? exact : exact.folder!;
  }
  const norm = query.toLowerCase();
  const folded = entries.filter((g) =>
    typeof g === "string" ? g.toLowerCase() === norm : g.folder?.toLowerCase() === norm,
  );
  if (folded.length > 1) return query;
  if (folded.length === 1) {
    const instance = folded[0]!;
    return typeof instance === "string" ? instance : instance.folder!;
  }
  const matches = entries.filter(
    (g): g is InstalledGameDescriptor =>
      typeof g !== "string" &&
      (g.hash.toLowerCase() === norm ||
        g.alias.toLowerCase() === norm ||
        g.wordsSha256?.toLowerCase() === norm ||
        g.revision?.toLowerCase() === norm),
  );
  if (matches.length === 0) return query;
  if (matches.length > 1) {
    const cataloged = preferCatalogedEdition(matches);
    return cataloged?.folder ?? query;
  }
  return matches[0]!.folder ?? query;
}

export interface Frame {
  visual: Uint8Array;
  priority: Uint8Array;
  /** 40x25 [char, attr] text cells. */
  text: Uint8Array;
  /** Text row where picture row 0 is presented. */
  picRow: number;
  /** Interpreter cycle this frame completed, when the worker reports it. */
  cycle?: number;
  /** Container patch revision at capture; part of the frame's identity. */
  patchGeneration?: number;
  /**
   * Per-pixel owning screen object (num + 1, 0 = background); present only
   * while the worker's ownership debug channel is armed.
   */
  ownership?: Uint16Array;
  /** Live screen-object table; present only while the objects channel is armed. */
  objects?: ScreenObjectState[];
  /**
   * Picture-only visual + priority (no screen objects); present only while the
   * picture debug channel is armed — the exploded view layers this as the wall.
   */
  picVisual?: Uint8Array;
  picPriority?: Uint8Array;
  /**
   * Logical pixels the show.obj preview cel wrote; present only while that
   * modal is open. Lets a layered renderer treat the preview as its own
   * identifiable layer instead of unowned band-15 pixels.
   */
  preview?: Uint8Array;
}

/** Decodes 40x25 [char, attr] text buffer into 25 display rows. */
export function decodeTextRows(text: Uint8Array): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 25; r++) {
    let line = "";
    for (let c = 0; c < 40; c++) {
      const ch = text[(r * 40 + c) * 2]!;
      line += cellChar(ch);
    }
    rows.push(line);
  }
  return rows;
}

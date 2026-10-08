/**
 * The authoring session's state and the light helpers that read it: the
 * source store beside the container, the OBJECT file builder, and the
 * trusted-source checks. Kept apart from the tool registry (tools.ts) so the
 * Play boot path — a project export, a Studio Keep, the Studio's source
 * reader — can use them without loading the authoring tools.
 */
import { compileProjectLogic } from "../authoring/projectLogic.ts";
import { buildObjectFile } from "../authoring/inventory.ts";
export { buildObjectFile } from "../authoring/inventory.ts";
import { parseWordsTok } from "../logic/words.ts";
import { sourceCompilesTo } from "../picture/source.ts";
import { createAuthoringState, type AuthoringState } from "./authoringState.ts";
import type { SoundSourceBody } from "../sound/source.ts";
import type { BuildViewInput } from "../view/view.ts";
import type { GameContainer } from "../types.ts";
import { createContainer } from "../container/container.ts";
import { detectProfile, type AgiProfile, type ProfileId } from "../runtime/profile.ts";

/**
 * A rendered image returned alongside a tool result. Provider-neutral on
 * purpose: the engine never knows whether it is talking to Anthropic content
 * blocks or OpenAI Responses items; the app's llmClient adapts.
 */
export interface AgentToolImage {
  /** Encoded image bytes; rendered tool images default to PNG. */
  readonly png: Uint8Array;
  readonly mime?: "image/png" | "image/jpeg" | "image/webp";
  /** What the picture shows, for the accompanying text. */
  readonly caption: string;
}

export interface AgentToolResult {
  readonly success: boolean;
  readonly error?: string | undefined;
  readonly message?: string | undefined;
  readonly adjustments?: readonly string[] | undefined;
  readonly details?: Record<string, unknown> | undefined;
  /** Images the model should look at. Adapted per provider by the caller. */
  readonly images?: readonly AgentToolImage[] | undefined;
  /** Local listening previews; provider adapters explicitly omit unsupported audio. */
  readonly audio?: readonly AgentToolAudio[] | undefined;
}

interface AgentToolAudio {
  readonly wav: Uint8Array;
  readonly mimeType: "audio/wav";
  readonly caption: string;
}

export interface AgentSourceStore {
  logics: Map<number, string>;
  /** Picture DSL source, keyed by picture number — what the agent wrote. */
  pictures: Map<number, string>;
  views: Map<number, BuildViewInput>;
  words: Map<string, number>;
  objects?: { name: string; startingRoom: number }[] | undefined;
  /**
   * Authored sound source keyed by resource number: the legacy
   * SoundTrackInput[] body or a tagged `agi.sound-document` v1 envelope
   * (src/sound/source.ts). Entries serialize and hydrate as the same
   * `[num, body]` JSON pairs either way.
   */
  sounds: Map<number, SoundSourceBody>;
}

export interface AgentSessionState {
  authoring: AuthoringState;
  readonly sources: AgentSourceStore;
  readonly container: GameContainer;
  readonly profile: AgiProfile;
  wordsPayload?: Uint8Array | undefined;
  objectPayload?: Uint8Array | undefined;
  /** Stored game tests (TESTS.JSON) written this session; see gameTests.ts. */
  testsPayload?: Uint8Array | undefined;
  genesisComplete: boolean;
  /**
   * Full tool results evicted from the model-facing projection, retrievable by
   * read_diagnostic for this session only. Shared across candidate forks;
   * never serialized into files.
   */
  readonly diagnostics: Map<string, AgentToolResult>;
  /**
   * Reusable game-test verdicts keyed by resource-set + test-definition +
   * profile + seed content identity. Session-scoped, shared across forks.
   */
  readonly testEvidence: Map<string, { outcome: unknown; result: AgentToolResult }>;
  /**
   * write_picture calls made per picture number this session. The harness
   * reports the revision number for continuity across edits.
   */
  readonly pictureRounds: Map<number, number>;
  getFiles(): Map<string, Uint8Array>;
}

/**
 * `profile` is the game's interpreter override, when the player chose one;
 * without it the profile is detected from the container's files.
 */
export function createAgentSessionState(
  existingContainer?: GameContainer,
  profile?: ProfileId | AgiProfile,
  dictionaryWords?: ReadonlyMap<string, number>,
): AgentSessionState {
  const container = existingContainer ?? createContainer();
  if (!existingContainer) container.putFile("OBJECT", buildObjectFile([]));
  const dictionary = container.files.get("WORDS.TOK");
  const wordsPayload: Uint8Array | undefined = undefined;
  const objectPayload: Uint8Array | undefined = undefined;
  return {
    authoring: createAuthoringState(),
    sources: {
      logics: new Map(),
      pictures: new Map(),
      views: new Map(),
      words: dictionaryWords
        ? new Map(dictionaryWords)
        : new Map(dictionary ? parseWordsTok(dictionary).map(({ word, id }) => [word, id]) : []),
      sounds: new Map(),
    },
    container,
    profile: detectProfile(container.files, profile),
    wordsPayload,
    objectPayload,
    testsPayload: undefined,
    genesisComplete: false,
    diagnostics: new Map<string, AgentToolResult>(),
    testEvidence: new Map<string, { outcome: unknown; result: AgentToolResult }>(),
    pictureRounds: new Map<number, number>(),
    getFiles() {
      const files = new Map<string, Uint8Array>(container.files);
      if (this.wordsPayload) {
        files.set("WORDS.TOK", this.wordsPayload);
      }
      if (this.objectPayload) {
        files.set("OBJECT", this.objectPayload);
      }
      if (this.testsPayload) files.set("TESTS.JSON", this.testsPayload);
      return files;
    },
  };
}

/**
 * The picture text the agent wrote this session, only while it still compiles to
 * the stored resource bytes. An imported or stale source that disagrees with the
 * container is ignored so reads and edits never resurrect discarded work.
 */
export function authoredPictureSource(session: AgentSessionState, num: number): string | undefined {
  const authored = session.sources.pictures.get(num);
  const payload = session.container.getResource("picture", num);
  if (authored === undefined || !payload) return undefined;
  return sourceCompilesTo(authored, payload, session.profile) ? authored : undefined;
}

/**
 * Assemble logic the agent wrote, with its named bindings. The bindings the
 * source does not define itself are prepended as #define lines; an error
 * position is mapped back to the agent's own line, which is what it reads.
 */
export function assembleAuthoredLogic(
  session: Pick<AgentSessionState, "profile"> & {
    readonly authoring: Pick<AuthoringState, "bindings">;
    readonly sources: Pick<AgentSourceStore, "words">;
  },
  source: string,
) {
  return compileProjectLogic(source, {
    profile: session.profile,
    bindings: session.authoring.bindings,
    dictionary: session.sources.words,
  }).assembly;
}

/**
 * The logic text the agent wrote this session, only while it still compiles to
 * the stored resource bytes.
 */
export function authoredLogicSource(session: AgentSessionState, num: number): string | undefined {
  const authored = session.sources.logics.get(num);
  const payload = session.container.getResource("logic", num);
  if (authored === undefined || !payload) return undefined;
  try {
    const compiled = assembleAuthoredLogic(session, authored).payload;
    if (compiled.length !== payload.length) return undefined;
    for (let index = 0; index < compiled.length; index++)
      if (compiled[index] !== payload[index]) return undefined;
    return authored;
  } catch {
    return undefined;
  }
}

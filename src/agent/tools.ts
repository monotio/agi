/**
 * Authoring agent tool definitions, schemas, and deterministic execution handlers.
 *
 * Framework-free TypeScript, zero dependencies. Runs in browser, Web Worker,
 * and Node. When the LLM calls these tools, they run the real engine compiler
 * and renderer, returning exact diagnostics on syntax/bounds errors so the
 * model can self-correct in its agent loop.
 */

import { CORE_AGENT_TOOLS } from "./coreToolDefinitions.ts";
import { normalizeToolArguments, validateToolArguments } from "./schemaValidate.ts";
import { assembleLogic } from "../logic/assembler.ts";
import { buildWordsTok, parseWordsTok, type WordEntry } from "../logic/words.ts";
import { renderPicture, type PictureFillDiagnostic } from "../picture/renderer.ts";
import {
  compilePictureSource,
  PictureSourceSyntaxError,
  readPictureSource,
} from "../picture/source.ts";
import { computePictureMetrics, DEFAULT_HORIZON } from "../picture/metrics.ts";
import {
  actorLayoutFeedback,
  colourGrid,
  editReport,
  formatLayoutDiff,
  formatPriorityDiagnostics,
  layoutDiff,
  PICTURE_COMPARISON_LEGEND,
  pictureComparisonPng,
} from "./pictureFeedback.ts";
import { viewFeedback } from "./viewFeedback.ts";
import { normalizeAuthoredLogic } from "./logicText.ts";
import { readInventoryObjects } from "./inventory.ts";
import { decodeInventoryFile } from "../runtime/inventoryFile.ts";
import {
  createAuthoringState,
  resourceRevision,
  resourceSetRevision,
  type AuthoringState,
} from "./authoringState.ts";
import {
  AUTHORING_TOOLS,
  editableSource,
  executeAuthoringTool,
  sourceContextRevision,
} from "./authoringTools.ts";
import { SPRITE_TOOLS, actorSpecFromFacings, executeSpriteTool } from "./spriteTools.ts";
import { SOUND_TOOLS, executeSoundTool } from "./soundTools.ts";
import { PICTURE_TOOLS, executePictureTool } from "./pictureTools.ts";
import {
  COMMAND_REFERENCE_TOOL,
  readCommandReference,
  relatedCommands,
} from "./commandReference.ts";
import { ROOM_TOOLS, executeRoomTool } from "./roomTools.ts";
import { AUTHORING_GUIDE_TOOL, readAuthoringGuide } from "./authoringGuide.ts";
import {
  GAME_TEST_TOOLS,
  executeGameTestTool,
  rerunAffectedTests,
  runGameTests,
  type TouchedResource,
} from "./gameTests.ts";
import { playtestRoom, validateGenesis } from "./playtest.ts";
import { serializeAgentLog } from "./toolTransport.ts";
import { disassembleLogic } from "../logic/disassembler.ts";
import {
  buildView,
  parseView,
  type BuildCelInput,
  type BuildLoopInput,
  type BuildViewInput,
} from "../view/view.ts";
import {
  createPictureSurface,
  RESOURCE_KINDS,
  type GameContainer,
  type ResourceKind,
} from "../types.ts";
import { createContainer } from "../container/container.ts";
import { detectProfile, DEFAULT_V2_PROFILE, type AgiProfile } from "../runtime/profile.ts";
import { describeKeyWord } from "../runtime/keys.ts";
import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  MAX_FRAMES,
  SHEET_GAP,
  frameToPng,
  framesToContactSheet,
  textRows,
  type AgentFrame,
  type EngineStateSource,
  type FramePlane,
  type FrameSource,
} from "./frames.ts";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
  };
}

/**
 * A rendered image returned alongside a tool result. Provider-neutral on
 * purpose: the engine never knows whether it is talking to Anthropic content
 * blocks or OpenAI Responses items; the app's llmClient adapts.
 */
export interface AgentToolImage {
  /** PNG bytes, with pixel art scaled by nearest neighbour. */
  readonly png: Uint8Array;
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

export interface AgentToolAudio {
  readonly wav: Uint8Array;
  readonly mimeType: "audio/wav";
  readonly caption: string;
}

export interface SoundNoteInput {
  note?: number | string | null | undefined;
  duration: number;
  freqDivisor?: number | null | undefined;
  attenuation?: number | null | undefined;
}

export interface SoundTrackInput {
  notes: SoundNoteInput[];
}

const NOTE_SEMITONES: Record<string, number> = {
  c: 0,
  "c#": 1,
  db: 1,
  d: 2,
  "d#": 3,
  eb: 3,
  e: 4,
  f: 5,
  "f#": 6,
  gb: 6,
  g: 7,
  "g#": 8,
  ab: 8,
  a: 9,
  "a#": 10,
  bb: 10,
  b: 11,
};

/**
 * Parses a note representation (MIDI number 1..127 or string e.g. "C4", "A4", "F#5") into a MIDI note number.
 * Returns null for rests, silence, or invalid notes.
 */
export function parseNoteToMidi(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") {
    return input > 0 && input <= 127 ? Math.round(input) : null;
  }
  const str = input.trim().toLowerCase();
  if (str === "" || str === "rest" || str === "r" || str === "silence" || str === "none") {
    return null;
  }
  const match = /^([a-g][#b]?)(-?\d+)$/.exec(str);
  if (!match) {
    const num = parseInt(str, 10);
    return !isNaN(num) && num > 0 && num <= 127 ? num : null;
  }
  const name = match[1]!;
  const octave = parseInt(match[2]!, 10);
  const semi = NOTE_SEMITONES[name];
  if (semi === undefined) return null;
  const midi = (octave + 1) * 12 + semi;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/**
 * Converts a MIDI note number (60 = C4, 69 = A440) to an authentic AGI 10-bit tone frequency divisor.
 */
export function midiToAgiDivisor(midi: number | null): number {
  if (midi === null || midi <= 0 || midi > 127) return 0;
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  return Math.max(1, Math.min(1023, Math.round(99431.67 / freq)));
}

export interface AgentSourceStore {
  logics: Map<number, string>;
  /** Picture DSL source, keyed by picture number — what the agent wrote. */
  pictures: Map<number, string>;
  views: Map<number, BuildViewInput>;
  words: Map<string, number>;
  objects?: { name: string; startingRoom: number }[] | undefined;
  sounds: Map<number, SoundTrackInput[]>;
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
 * Builds authentic AGI sound binary payload (4 channels: 3 tone voices + 1 noise voice).
 * Supports MIDI note numbers (e.g. 60 for C4, 69 for A440) or note names ('C4', 'G4', 'rest'),
 * as well as raw frequency divisors. Each channel terminates with 0xffff.
 */
export function buildSound(tracks: readonly SoundTrackInput[]): Uint8Array {
  const channelData: number[][] = [];
  for (let ch = 0; ch < 4; ch++) {
    const track = tracks[ch];
    const bytes: number[] = [];
    if (track && Array.isArray(track.notes)) {
      for (const note of track.notes) {
        const dur = Math.max(1, Math.min(65534, note.duration || 1));
        bytes.push(dur & 0xff, (dur >> 8) & 0xff);

        let div = 0;
        let isRest = false;

        if (typeof note.freqDivisor === "number" && note.freqDivisor > 0) {
          div = Math.max(0, Math.min(1023, note.freqDivisor));
        } else if (note.note !== undefined && note.note !== null) {
          const midi = parseNoteToMidi(note.note);
          if (midi !== null) {
            div = midiToAgiDivisor(midi);
          } else {
            isRest = true;
          }
        } else if (typeof note.freqDivisor === "number") {
          div = Math.max(0, Math.min(1023, note.freqDivisor));
        } else {
          isRest = true;
        }

        // Store the device command word, including its latch and channel bits.
        // Noise uses the raw control nibble; repeat it in the unused second
        // byte so early profiles that emit both bytes preserve the selection.
        const byte0 = ch === 3 ? div & 0x0f : (div >> 4) & 0x3f;
        const byte1 = 0x80 | (ch << 5) | (div & 0x0f);
        bytes.push(byte0, byte1);

        let att = 0;
        if (isRest || (ch < 3 && div === 0)) {
          att = 15; // 0x0f = silence in AGI
        } else if (typeof note.attenuation === "number") {
          att = Math.max(0, Math.min(15, note.attenuation));
        }
        bytes.push((0x90 + ch * 0x20) | att);
      }
    }
    // Channel terminator (0xffff)
    bytes.push(0xff, 0xff);
    channelData.push(bytes);
  }

  let offset = 8;
  const offsets: number[] = [];
  for (let ch = 0; ch < 4; ch++) {
    offsets.push(offset);
    offset += channelData[ch]!.length;
  }

  const result = new Uint8Array(offset);
  for (let ch = 0; ch < 4; ch++) {
    const off = offsets[ch]!;
    result[ch * 2] = off & 0xff;
    result[ch * 2 + 1] = (off >> 8) & 0xff;
    result.set(channelData[ch]!, off);
  }
  return result;
}

const MESSAGE_KEY = "Avis Durgan";

export function buildObjectFile(
  items: readonly { name: string; startingRoom?: number | undefined }[],
  profile: AgiProfile = DEFAULT_V2_PROFILE,
  maximumDrawableObjectIndex = 255,
): Uint8Array {
  const tableSize = items.length * 3;
  let totalNamesLen = 0;
  for (const item of items) {
    totalNamesLen += item.name.length + 1;
  }
  const plain = new Uint8Array(3 + tableSize + totalNamesLen);
  plain[0] = tableSize & 0xff;
  plain[1] = (tableSize >> 8) & 0xff;
  plain[2] = maximumDrawableObjectIndex & 0xff;

  let currentOffset = tableSize;
  let poolAt = 3 + tableSize;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const entryAt = 3 + i * 3;
    plain[entryAt] = currentOffset & 0xff;
    plain[entryAt + 1] = (currentOffset >> 8) & 0xff;
    plain[entryAt + 2] = (item.startingRoom ?? 0) & 0xff;

    for (let c = 0; c < item.name.length; c++) {
      plain[poolAt++] = item.name.charCodeAt(c);
    }
    plain[poolAt++] = 0;
    currentOffset += item.name.length + 1;
  }

  if (!profile.inventoryMetadataEncrypted) return plain;
  const encrypted = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) {
    encrypted[i] = plain[i]! ^ MESSAGE_KEY.charCodeAt(i % MESSAGE_KEY.length);
  }
  return encrypted;
}

export function createAgentSessionState(existingContainer?: GameContainer): AgentSessionState {
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
      words: new Map(dictionary ? parseWordsTok(dictionary).map(({ word, id }) => [word, id]) : []),
      sounds: new Map(),
    },
    container,
    profile: detectProfile(container.files),
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

/** Shared JSON Schemas: OpenAI uses strict mode; Anthropic uses non-strict transport. */
export const AGENT_TOOLS: readonly ToolDefinition[] = [
  ...AUTHORING_TOOLS,
  ...SPRITE_TOOLS,
  ...SOUND_TOOLS,
  ...PICTURE_TOOLS,
  ...ROOM_TOOLS,
  COMMAND_REFERENCE_TOOL,
  AUTHORING_GUIDE_TOOL,
  ...GAME_TEST_TOOLS,
  ...CORE_AGENT_TOOLS,
];

const STANDARD_NAV_WORDS = [
  "look",
  "north",
  "n",
  "south",
  "s",
  "east",
  "e",
  "west",
  "w",
  "up",
  "u",
  "down",
  "d",
];

/** Compact one-line-per-family metrics summary for the write_picture tool result. */
function formatPictureMetrics(m: {
  fillCoverage: number;
  distinctColors: number;
  edgeDensity: number;
  regionCount: number;
  commandCount: number;
  priorityBandFraction: number;
  priorityBands: number;
  priorityHorizonSanity: number;
  walkableFraction: number;
}): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  return [
    `fill coverage ${pct(m.fillCoverage)} (target >= 95%), ${m.distinctColors} distinct colours (target 8-14)`,
    `${m.commandCount} commands, ${m.regionCount} regions, edge density ${pct(m.edgeDensity)}`,
    `priority: ${pct(m.priorityBandFraction)} of cells in depth bands, ${m.priorityBands} distinct bands, walkable below horizon ${pct(m.walkableFraction)}, sky above horizon on band 4 ${pct(m.priorityHorizonSanity)}`,
  ].join("\n");
}

/** "0-3, 7, 20-22" for a sorted list of resource numbers. */
function formatNumberRanges(nums: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i < nums.length;) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1]! === nums[j]! + 1) j++;
    out.push(i === j ? String(nums[i]!) : `${nums[i]!}-${nums[j]!}`);
    i = j + 1;
  }
  return out.join(", ");
}

/**
 * Execute an agent tool call against the session state.
 * Returns { success, error, details } for direct inclusion in the model transcript.
 */
function listResources(session: AgentSessionState, kindArg: unknown): AgentToolResult {
  const filter = typeof kindArg === "string" ? kindArg.trim().toLowerCase() : "";
  const kinds: readonly ResourceKind[] =
    filter === "" ? RESOURCE_KINDS : RESOURCE_KINDS.filter((k) => k === filter);
  if (kinds.length === 0) {
    return {
      success: false,
      error: `Unknown resource kind '${filter}'. Use one of: ${RESOURCE_KINDS.join(", ")}, or null for all.`,
    };
  }
  const present: Record<string, number[]> = {};
  const free: Record<string, number[]> = {};
  const corrupt: Record<string, number[]> = {};
  const lines: string[] = [];
  for (const kind of kinds) {
    const have: number[] = [];
    const broken: number[] = [];
    for (let n = 0; n <= 255; n++) {
      let bytes: Uint8Array | null;
      try {
        bytes = session.container.getResource(kind, n);
      } catch {
        broken.push(n);
        bytes = null;
      }
      if (bytes !== null) have.push(n);
    }
    const lowestFree: number[] = [];
    for (let n = kind === "logic" ? 0 : 1; n <= 255 && lowestFree.length < 8; n++) {
      if (!have.includes(n) && !broken.includes(n)) lowestFree.push(n);
    }
    present[kind] = have;
    corrupt[kind] = broken;
    free[kind] = lowestFree;
    lines.push(
      `${kind}: ${have.length} present${have.length > 0 ? ` [${formatNumberRanges(have)}]` : ""}; next free: ${lowestFree.join(", ")}`,
    );
  }
  return {
    success: true,
    message: `Container resources:\n${lines.join("\n")}`,
    details: { present, free, corrupt, genesisComplete: session.genesisComplete },
  };
}

export function executeAgentTool(
  session: AgentSessionState,
  name: string,
  args: Record<string, unknown>,
): AgentToolResult {
  const call = prepareAgentToolCall(name, args);
  if (!call.success) return call;
  return withEvidenceOrigin(session, name, executeValidatedAgentTool(session, name, call.args));
}

/** Tools that boot a fresh interpreter against the staged file set. */
const BOOT_ORIGIN_TOOLS: ReadonlySet<string> = new Set(["playtest_room", "run_game_tests"]);

/** Tools whose result is static reference text, not evidence about the game. */
const REFERENCE_TOOLS: ReadonlySet<string> = new Set([
  "read_authoring_guide",
  "read_command_reference",
  "read_diagnostic",
]);

/**
 * Every game-facing result records where its evidence came from and which
 * resource set it describes: "staged" for reads and writes of the session
 * container, "boot" for fresh boot simulations against that set. A "boot"
 * verdict is not proof the paused live game resumes correctly — resume
 * validation is a separate host concern.
 */
function withEvidenceOrigin(
  session: AgentSessionState,
  name: string,
  result: AgentToolResult,
): AgentToolResult {
  if (REFERENCE_TOOLS.has(name)) return result;
  return {
    ...result,
    details: {
      ...result.details,
      // A simulation that ran from a recorded replay or a restored live
      // checkpoint already stamps a more specific origin; keep it.
      origin: result.details?.["origin"] ?? {
        kind: BOOT_ORIGIN_TOOLS.has(name) ? "boot" : "staged",
        resourceSet: resourceSetRevision(session),
      },
    },
  };
}

/** Both public dispatchers must validate before reading live data or changing resources. */
function prepareAgentToolCall(
  name: string,
  args: Record<string, unknown>,
): { success: true; args: Record<string, unknown> } | { success: false; error: string } {
  const definition = AGENT_TOOLS.find((tool) => tool.name === name);
  if (!definition) return { success: false, error: `Unknown tool: '${name}'.` };
  // Omitted nullable fields become null so handlers see the strict-mode shape.
  args = normalizeToolArguments(definition.parameters, args);
  const errors = validateToolArguments(definition.parameters, args);
  if (errors.length)
    return {
      success: false,
      error: `Invalid arguments for ${name}; nothing was changed. ${errors.slice(0, 8).join(" ")}`,
    };
  return { success: true, args };
}

/**
 * A write's result carries the verdict of the stored game tests its change can
 * affect: verdict first, so the agent sees the consequence in the same turn.
 */
function withGameTestVerdict(
  session: AgentSessionState,
  result: AgentToolResult,
  touched: readonly TouchedResource[],
): AgentToolResult {
  const rerun = rerunAffectedTests(session, touched);
  if (!rerun) return result;
  return {
    ...result,
    message: `Game tests: ${rerun.line}${result.message ? ` ${result.message}` : ""}`,
    details: { ...result.details, gameTests: rerun.outcomes, gameTestsRerun: rerun.selection },
  };
}
/**
 * The resources a successful write reports touching: its writtenResources
 * plus the WORDS.TOK/OBJECT files a composite write updated (a dictionary or
 * inventory change can affect commands in tests of any room), deduplicated.
 */
function touchedResources(result: AgentToolResult): TouchedResource[] {
  const touched: TouchedResource[] = [];
  const written = result.details?.["writtenResources"];
  if (Array.isArray(written))
    for (const entry of written) {
      const resource = entry as { kind?: unknown; num?: unknown } | null;
      if (typeof resource?.kind === "string" && typeof resource.num === "number")
        touched.push({ kind: resource.kind as TouchedResource["kind"], num: resource.num });
    }
  const files = result.details?.["updatedFiles"];
  if (Array.isArray(files))
    for (const file of files) {
      if (file === "WORDS.TOK") touched.push({ kind: "words", num: 0 });
      else if (file === "OBJECT") touched.push({ kind: "objects", num: 0 });
    }
  return touched.filter(
    (resource, index) =>
      touched.findIndex((other) => other.kind === resource.kind && other.num === resource.num) ===
      index,
  );
}

/** Retrieve a stored full tool result with bounded selection and pagination. */
function readDiagnostic(
  session: AgentSessionState,
  args: Record<string, unknown>,
): AgentToolResult {
  const id = String(args["id"]);
  const stored = session.diagnostics.get(id);
  if (!stored)
    return {
      success: false,
      error: `No diagnostic '${id}'. Artifacts are session-scoped; re-run the tool that produced it.`,
    };
  const fields = args["fields"];
  const offset = typeof args["offset"] === "number" ? args["offset"] : 0;
  const limit = Math.min(typeof args["limit"] === "number" ? args["limit"] : 16000, 32000);
  let selected: unknown = {
    success: stored.success,
    message: stored.message,
    adjustments: stored.adjustments,
    details: stored.details,
  };
  if (Array.isArray(fields) && fields.length) {
    const details = stored.details ?? {};
    const picked: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const field of fields) {
      const name = String(field);
      if (name in details) picked[name] = details[name];
      else missing.push(name);
    }
    selected = { details: picked, ...(missing.length ? { missingFields: missing } : {}) };
  }
  const text = serializeAgentLog(selected);
  const page = text.slice(offset, offset + limit);
  return {
    success: true,
    message: `Diagnostic ${id}, ${text.length} bytes total, offset ${offset}:\n${page}`,
    details: {
      id,
      offset,
      limit,
      totalBytes: text.length,
      nextOffset: offset + page.length < text.length ? offset + page.length : null,
      imageCount: stored.images?.length ?? 0,
    },
  };
}

/** Internal dispatch for arguments already normalized and checked against the catalog. */
function executeValidatedAgentTool(
  session: AgentSessionState,
  name: string,
  args: Record<string, unknown>,
): AgentToolResult {
  if (name === "read_command_reference") return readCommandReference(session.profile, args);
  if (name === "read_authoring_guide") return readAuthoringGuide(args);
  if (name === "read_diagnostic") return readDiagnostic(session, args);
  const gameTest = executeGameTestTool(session, name, args);
  if (gameTest) {
    if (name === "write_game_tests" && gameTest.success)
      return { ...gameTest, details: { ...gameTest.details, updatedFiles: ["TESTS.JSON"] } };
    return gameTest;
  }
  let result: AgentToolResult;
  for (const field of ["offset", "limit"]) {
    const value = args[field];
    if (
      value != null &&
      (typeof value !== "number" || !Number.isInteger(value) || value < (field === "limit" ? 1 : 0))
    )
      return {
        success: false,
        error: `${field} must be a nonnegative integer${field === "limit" ? " greater than zero" : ""}.`,
      };
  }
  try {
    result =
      executeAuthoringTool(session, name, args) ??
      executeSpriteTool(session, name, args) ??
      executeSoundTool(session, name, args) ??
      executePictureTool(session, name, args) ??
      executeRoomTool(session, name, args) ??
      executeLegacyTool(session, name, args);
  } catch (error) {
    result = { success: false, error: String(error) };
  }
  if (result.success) {
    // The four legacy writers predate the mutation-metadata contract, so the
    // wrapper attaches it here; every other writer reports its own
    // writtenResources/updatedFiles, and rerun selection trusts that metadata
    // rather than a tool-name list.
    const legacyKind = (
      {
        write_logic_source: "logic",
        write_picture: "picture",
        write_view: "view",
        write_sound: "sound",
      } as Record<string, ResourceKind>
    )[name];
    if (legacyKind) {
      const num = Number(args["room"] ?? args["num"]);
      result = {
        ...result,
        details: {
          ...result.details,
          writtenResources: [{ kind: legacyKind, num }],
          ...(legacyKind === "logic" || legacyKind === "picture"
            ? {
                revision: sourceContextRevision(
                  session,
                  legacyKind,
                  num,
                  editableSource(session, legacyKind, num) ?? "",
                ),
              }
            : {
                revision: resourceRevision(session.container.getResource(legacyKind, num)),
              }),
        },
      };
    }
    if (name === "write_words" || name === "write_inventory_objects")
      result = {
        ...result,
        details: {
          ...result.details,
          updatedFiles: [name === "write_words" ? "WORDS.TOK" : "OBJECT"],
        },
      };
    // Writers that delegate to another write tool (edit_resource_source)
    // already carry the inner call's rerun verdict;
    // never run the tests twice.
    if (!result.details?.["gameTestsRerun"]) {
      const touched = touchedResources(result);
      if (touched.length) return withGameTestVerdict(session, result, touched);
    }
  }
  if (result.success && (name === "read_logic" || name === "read_picture")) {
    const full = String(result.details?.["source"] ?? "");
    const lines = full.split("\n");
    const offset = Number(args["offset"] ?? 0);
    const limit = Math.min(400, Number(args["limit"] ?? 200));
    const source = lines.slice(offset, offset + limit).join("\n");
    const include = name === "read_picture" ? (args["include"] ?? "both") : "source";
    if (!["source", "image", "both"].includes(String(include)))
      return { success: false, error: "include must be source, image, both, or null." };
    const num = Number(args["num"]);
    const kind = name === "read_logic" ? "logic" : "picture";
    const code = full.replace(/\/\/[^\n]*|"(?:\\[^\n]|[^"\\\n])*"/g, "");
    const values = (pattern: RegExp): number[] =>
      [...new Set([...code.matchAll(pattern)].map((match) => Number(match[1])))].sort(
        (a, b) => a - b,
      );
    const details = {
      ...result.details,
      revision: sourceContextRevision(session, kind, num, full),
      source: include === "image" ? undefined : source,
      totalLines: lines.length,
      offset,
      nextOffset: offset + limit < lines.length ? offset + limit : null,
      ...(kind === "logic"
        ? {
            dependencies: {
              rooms: values(/\bnew\.room\((\d+)\)/g),
              flags: values(/\bf(\d+)\b/g),
              variables: values(/\bv(\d+)\b/g),
            },
          }
        : {}),
    };
    const rawSpatialDiagnostics = result.details?.["spatialDiagnostics"];
    const spatialDiagnostics =
      kind === "picture" && typeof rawSpatialDiagnostics === "string"
        ? `\n${rawSpatialDiagnostics}`
        : "";
    return {
      success: true,
      message:
        include === "image"
          ? `Picture ${num}, stored rendering.${spatialDiagnostics}`
          : `${kind} ${num} source lines ${offset}..${Math.min(lines.length, offset + limit) - 1}:\n${source}${spatialDiagnostics}`,
      details,
      ...(include !== "source" && result.images ? { images: result.images } : {}),
    };
  }
  return result;
}

function executeLegacyTool(
  session: AgentSessionState,
  name: string,
  args: Record<string, unknown>,
): AgentToolResult {
  switch (name) {
    case "write_words": {
      if (!Array.isArray(args["words"]) || args["words"].length > 4096)
        return { success: false, error: "words must be an array with at most 4096 entries." };
      const rawWords = [...args["words"]];
      if (args["groups"] != null) {
        if (!Array.isArray(args["groups"]) || args["groups"].length > 512)
          return { success: false, error: "groups must be null or at most 512 synonym groups." };
        for (const group of args["groups"]) {
          if (
            !Array.isArray(group) ||
            group.length < 1 ||
            group.length > 32 ||
            group.some((word) => typeof word !== "string" || word.includes("/"))
          )
            return {
              success: false,
              error: "Each group must contain 1..32 strings without slash separators.",
            };
          rawWords.push(group.join("/"));
        }
      }
      const nextWords = new Map(session.sources.words);
      const usedIds = new Set([...nextWords.values(), 0, 1, 0x270f]);
      let nextId = 100;
      const allocateId = (): number => {
        while (nextId <= 0xffff && usedIds.has(nextId)) nextId++;
        if (nextId > 0xffff) {
          nextId = 2;
          while (nextId < 100 && usedIds.has(nextId)) nextId++;
          if (nextId >= 100) throw new Error("Dictionary has no free word IDs.");
        }
        usedIds.add(nextId);
        return nextId++;
      };
      const addedNavWords: string[] = [];
      try {
        for (const item of rawWords) {
          if (typeof item !== "string") throw new Error("Each words entry must be a string.");
          const group = item
            .split("/")
            .map((word) => word.trim().toLowerCase().replace(/\s+/g, " "));
          if (group.some((word) => !/^[a-z][a-z0-9' ]{0,63}$/.test(word)))
            throw new Error(
              `Invalid vocabulary '${item}': use ASCII words or phrases starting with a letter; punctuation is not silently removed.`,
            );
          const existingIds = new Set(
            group.flatMap((word) => {
              const id = nextWords.get(word);
              return id === undefined ? [] : [id];
            }),
          );
          if (existingIds.size > 1)
            throw new Error(`Synonym group '${item}' combines existing word IDs.`);
          const id = existingIds.size ? [...existingIds][0]! : allocateId();
          for (const word of group) nextWords.set(word, id);
        }
        for (const word of STANDARD_NAV_WORDS) {
          if (!nextWords.has(word)) {
            nextWords.set(word, allocateId());
            addedNavWords.push(word);
          }
        }
        const entries: WordEntry[] = [...nextWords].map(([word, id]) => ({ word, id }));
        const payload = buildWordsTok(entries);
        session.sources.words.clear();
        for (const [word, id] of nextWords) session.sources.words.set(word, id);
        session.wordsPayload = payload;
        const adjustments: string[] = [];
        if (addedNavWords.length > 0) {
          adjustments.push(
            `Automatically ensured standard navigation vocabulary: ${addedNavWords.join(", ")}.`,
          );
        }
        return {
          success: true,
          message: `Dictionary (WORDS.TOK) compiled successfully with ${session.sources.words.size} words (${payload.length} bytes).`,
          ...(adjustments.length > 0 ? { adjustments } : {}),
          details: {
            totalWords: session.sources.words.size,
            bytes: payload.length,
            adjustments: adjustments.length > 0 ? adjustments : undefined,
          },
        };
      } catch (err) {
        return { success: false, error: `Dictionary compilation error: ${String(err)}` };
      }
    }

    case "write_logic_source": {
      const room =
        typeof args["room"] === "number" ? args["room"] : parseInt(String(args["room"]), 10);
      const source = typeof args["source"] === "string" ? args["source"] : "";
      if (!Number.isInteger(room) || room < 0 || room > 255) {
        return { success: false, error: `Invalid logic resource number: ${room}. Must be 0..255.` };
      }
      if (source.trim().length === 0) {
        return { success: false, error: "Logic source code cannot be empty." };
      }
      try {
        const normalized = normalizeAuthoredLogic(source);
        const defined = new Set(
          [...normalized.source.matchAll(/^\s*#define\s+(\w+)/gm)].map((match) => match[1]),
        );
        const bindings = Object.entries(session.authoring.bindings)
          .filter(([name]) => !defined.has(name))
          .map(([name, binding]) => `#define ${name} ${binding.num}`)
          .join("\n");
        const assembled = assembleLogic(`${bindings}\n${normalized.source}`, {
          dictionary: session.sources.words,
          profile: session.profile,
        });
        session.container.putResource("logic", room, assembled.payload);
        session.sources.logics.set(room, normalized.source);
        return {
          success: true,
          message: `Logic ${room} compiled successfully (${assembled.code.length} bytes bytecode, ${assembled.messages.length} messages, ${assembled.payload.length} bytes total payload).`,
          ...(normalized.adjustments.length ? { adjustments: normalized.adjustments } : {}),
          details: {
            room,
            bytecodeLength: assembled.code.length,
            payloadLength: assembled.payload.length,
            messagesCount: assembled.messages.length,
          },
        };
      } catch (err) {
        const text = String(err);
        const match = /(?:unknown )?(action|condition) '([^']+)'/.exec(text);
        const command = match?.[2];
        const kind = match?.[1] as "action" | "condition" | undefined;
        const related = command ? relatedCommands(session.profile, command, kind) : [];
        const nextSteps = text.includes("is not in the dictionary")
          ? [
              "Use read_words to inspect existing word groups, then write_words to register the missing vocabulary or its synonyms before retrying the source.",
            ]
          : [
              "Use read_command_reference for the active profile's exact signatures and semantics. Candidates below are suggestions; choose by intended behavior, not spelling alone.",
            ];
        return {
          success: false,
          error: `Assembler error in logic ${room}: ${text}. ${nextSteps[0]}`,
          details: {
            profile: session.profile.id,
            nextSteps,
            ...(command ? { command, relatedCommands: related } : {}),
          },
        };
      }
    }

    case "write_picture": {
      const room =
        typeof args["room"] === "number" ? args["room"] : parseInt(String(args["room"]), 10);
      const source = typeof args["source"] === "string" ? args["source"] : "";
      if (!Number.isInteger(room) || room < 0 || room > 255) {
        return {
          success: false,
          error: `Invalid picture resource number: ${room}. Must be 0..255.`,
        };
      }
      if (source.trim().length === 0) {
        return { success: false, error: "Picture source cannot be empty." };
      }

      let compiled;
      try {
        compiled = compilePictureSource(source, { profile: session.profile });
      } catch (err) {
        // Verbatim, line-numbered diagnostics: this is the retry loop's input.
        const message = err instanceof PictureSourceSyntaxError ? err.message : String(err);
        return {
          success: false,
          error: `Picture ${room} was NOT updated; the source did not compile. Fix these and resend the complete source:\n${message}`,
        };
      }

      try {
        const surface = createPictureSurface();
        const fillDiagnostics: PictureFillDiagnostic[] = [];
        renderPicture(compiled.bytes, surface, {
          profile: session.profile,
          fillDiagnostics,
        });
        const metrics = computePictureMetrics(surface, {
          horizon: DEFAULT_HORIZON,
          commandCount: compiled.commandCount,
        });
        // Live patching: what the agent replaced, rendered as it stood, so the
        // result can say how much of it survived.
        const previousSource = session.sources.pictures.get(room);
        const previousBytes =
          previousSource === undefined ? null : session.container.getResource("picture", room);
        // The SOURCE is what the agent revises; the bytes go in the container.
        session.container.putResource("picture", room, compiled.bytes);
        session.sources.pictures.set(room, source);
        const round = (session.pictureRounds.get(room) ?? 0) + 1;
        session.pictureRounds.set(room, round);
        // Harness-owned round counter, deliberately absent from the system
        // prompt: the nudge belongs where the round is actually known.
        const nudge = `Revision ${round}. Inspect the image; revise when it would improve the requested result.`;
        // Numeric feedback about THIS render: the eval showed composition did
        // not move with prompt rules or a reference grid, only with numbers
        // about the agent's own output.
        const feedback = [
          "Dominant colour per cell, 8x7 (x left→right, y top→bottom):",
          colourGrid(surface.visual),
          formatPriorityDiagnostics(surface.priority),
        ];
        const blockedFills = fillDiagnostics.filter(
          ({ filledCells, seedValue, selectedValue }) =>
            filledCells === 0 && seedValue !== selectedValue,
        );
        if (blockedFills.length > 0) {
          const samples = blockedFills
            .slice(0, 5)
            .map(
              ({ x, y, selectedValue, seedValue, targetValue }) =>
                `${x},${y} selected ${selectedValue}, found ${seedValue} (needs ${targetValue})`,
            );
          const channels = new Set(blockedFills.map(({ channel }) => channel));
          const label = channels.size === 1 ? blockedFills[0]!.channel : "visual/priority";
          feedback.push(
            `${blockedFills.length} ${label} fill seeds did nothing: ${samples.join("; ")}${blockedFills.length > samples.length ? `; +${blockedFills.length - samples.length} more` : ""}. Enclose and fill regions while their interiors still have the target value.`,
          );
        }
        const actors = actorLayoutFeedback(source, surface.priority);
        if (actors.length > 0) feedback.push("Declared actor placement checks:", actors);
        const masses = layoutDiff(source, surface.visual);
        if (masses.length > 0) {
          feedback.push("Declared `# layout:` masses vs what rendered:", formatLayoutDiff(masses));
        }
        if (previousSource !== undefined && previousBytes !== null) {
          const previous = createPictureSurface();
          renderPicture(previousBytes, previous, { profile: session.profile });
          const edit = editReport(previousSource, source, previous.visual, surface.visual);
          feedback.push(
            `Original commands preserved in order: ${edit.preserved.kept} of ${edit.preserved.total}`,
            edit.changedBox === null
              ? "Changed cells: 0 (identical to the previous revision)"
              : `Changed cells: ${edit.changedCells} in region x${edit.changedBox.x0}-${edit.changedBox.x1} y${edit.changedBox.y0}-${edit.changedBox.y1}; stray cells outside it: ${edit.strayCells} in ${edit.changedComponents} components`,
          );
        }
        return {
          success: true,
          message: `Picture ${room} compiled and rendered (${compiled.bytes.length} bytes, ${compiled.commandCount} commands).\n${formatPictureMetrics(metrics)}\n${feedback.join("\n")}\nLook at the attached rendering before you decide it is finished.\n${nudge}`,
          ...(compiled.warnings.length > 0 ? { adjustments: [...compiled.warnings] } : {}),
          images: [
            {
              png: pictureComparisonPng(surface.visual, surface.priority),
              caption: `Picture ${room}, 960x168 comparison sheet; each 320x168 panel uses native 2:1 logical-pixel aspect. ${PICTURE_COMPARISON_LEGEND}`,
            },
          ],
          details: {
            room,
            bytes: compiled.bytes.length,
            commandCount: compiled.commandCount,
            fillCoverage: metrics.fillCoverage,
            distinctColors: metrics.distinctColors,
            priorityBands: metrics.priorityBands,
            walkableFraction: metrics.walkableFraction,
            round,
            warnings: compiled.warnings.length > 0 ? [...compiled.warnings] : undefined,
          },
        };
      } catch (err) {
        return { success: false, error: `Picture rendering error in room ${room}: ${String(err)}` };
      }
    }

    case "read_picture": {
      const num = typeof args["num"] === "number" ? args["num"] : parseInt(String(args["num"]), 10);
      if (!Number.isInteger(num) || num < 0 || num > 255) {
        return {
          success: false,
          error: `Invalid picture resource number: ${num}. Must be 0..255.`,
        };
      }
      let source: string | null;
      try {
        source = readPictureSource(session.container, num, { profile: session.profile });
      } catch (err) {
        return { success: false, error: `Cannot read picture ${num}: ${String(err)}` };
      }
      if (source === null) {
        return { success: false, error: `Picture ${num} is not present in the container.` };
      }
      try {
        const editableSource = authoredPictureSource(session, num) ?? source;
        const surface = createPictureSurface();
        renderPicture(session.container.getResource("picture", num)!, surface, {
          profile: session.profile,
        });
        const actors = actorLayoutFeedback(editableSource, surface.priority);
        const diagnostics = [
          formatPriorityDiagnostics(surface.priority),
          ...(actors.length > 0 ? ["Declared actor placement checks:", actors] : []),
        ].join("\n");
        return {
          success: true,
          message: `Picture ${num} source:\n${editableSource}\n${diagnostics}`,
          details: {
            num,
            source: editableSource,
            lines: editableSource.split("\n").length,
            spatialDiagnostics: diagnostics,
          },
          images: [
            {
              png: pictureComparisonPng(surface.visual, surface.priority),
              caption: `Picture ${num}, stored bytes in a 960x168 comparison sheet; each 320x168 panel uses native 2:1 logical-pixel aspect. ${PICTURE_COMPARISON_LEGEND}`,
            },
          ],
        };
      } catch (err) {
        return { success: false, error: `Cannot render picture ${num}: ${String(err)}` };
      }
    }

    case "read_view": {
      const num = args["num"];
      if (typeof num !== "number" || !Number.isInteger(num) || num < 0 || num > 255)
        return { success: false, error: "View number must be an integer in 0..255." };
      try {
        const payload = session.container.getResource("view", num);
        if (!payload)
          return { success: false, error: `View ${num} is not present in the container.` };
        const view = parseView(payload, session.profile);
        const preview = viewFeedback(payload, session.profile, num);
        // Optional exact rows for a selected subset (or all cels, bounded):
        // one call covers a rewrite plan instead of one read per cel.
        const selected = new Set<string>();
        const celsArg = args["cels"];
        if (Array.isArray(celsArg)) {
          for (const [i, raw] of celsArg.entries()) {
            const target = (raw ?? {}) as Record<string, unknown>;
            const loop = target["loop"];
            const cel = target["cel"];
            if (
              typeof loop !== "number" ||
              typeof cel !== "number" ||
              !Number.isInteger(loop) ||
              !Number.isInteger(cel) ||
              !view.loops[loop]?.cels[cel]
            )
              return {
                success: false,
                error: `cels[${i}] must be {loop, cel} naming an existing cel.`,
              };
            selected.add(`${loop}:${cel}`);
          }
        }
        const wantRows = args["rows"] === true;
        const rowCels: { loop: number; cel: number; rows: string[] }[] = [];
        let rowPixels = 0;
        if (wantRows || selected.size) {
          for (const [loopNum, loop] of view.loops.entries()) {
            for (const [celNum, cel] of loop.cels.entries()) {
              if (selected.size && !selected.has(`${loopNum}:${celNum}`)) continue;
              rowPixels += cel.width * cel.height;
              if (rowPixels > 32768)
                return {
                  success: false,
                  error: `Rows exceed the 32768-pixel budget; select fewer cels via 'cels'.`,
                };
              rowCels.push({
                loop: loopNum,
                cel: celNum,
                rows: Array.from({ length: cel.height }, (_, y) =>
                  [...cel.pixels.slice(y * cel.width, (y + 1) * cel.width)]
                    .map((p) => p.toString(16).toUpperCase())
                    .join(""),
                ),
              });
            }
          }
        }
        // Per-cel EGA color usage: enough to plan a recolor without reading
        // every cel's rows one at a time.
        const cels = view.loops.flatMap((loop, loopNum) =>
          loop.cels.map((cel, celNum) => {
            const counts = new Map<number, number>();
            for (const pixel of cel.pixels)
              if (pixel !== cel.transparentColor) counts.set(pixel, (counts.get(pixel) ?? 0) + 1);
            return {
              loop: loopNum,
              cel: celNum,
              width: cel.width,
              height: cel.height,
              colors: Object.fromEntries(
                [...counts].sort((a, b) => b[1] - a[1]).map(([color, n]) => [color, n]),
              ),
            };
          }),
        );
        return {
          success: true,
          message: `View ${num}: ${view.loops.length} loops, ${preview.totalFrames} cels.`,
          details: {
            num,
            bytes: payload.length,
            description: view.description?.slice(0, 512),
            loopCount: view.loops.length,
            celsPerLoop: view.loops.map((loop) => loop.cels.length),
            cels,
            revision: resourceRevision(payload),
            ...(rowCels.length ? { rows: rowCels } : {}),
            preview: {
              width: preview.width,
              height: preview.height,
              sampledCels: preview.frames,
              totalCels: preview.totalFrames,
            },
          },
          images: [{ png: preview.png, caption: preview.caption }],
        };
      } catch (err) {
        return { success: false, error: `Cannot read view ${num}: ${String(err)}` };
      }
    }

    case "read_logic": {
      const num = typeof args["num"] === "number" ? args["num"] : parseInt(String(args["num"]), 10);
      if (!Number.isInteger(num) || num < 0 || num > 255) {
        return { success: false, error: `Invalid logic resource number: ${num}. Must be 0..255.` };
      }
      let payload: Uint8Array | null;
      try {
        payload = session.container.getResource("logic", num);
      } catch (err) {
        return { success: false, error: `Cannot read logic ${num}: ${String(err)}` };
      }
      if (payload === null) {
        return { success: false, error: `Logic ${num} is not present in the container.` };
      }
      try {
        const source =
          authoredLogicSource(session, num) ??
          disassembleLogic(payload, {
            dictionary: session.sources.words,
            profile: session.profile,
          });
        return {
          success: true,
          message: `Logic ${num} source (re-assembles to the same bytecode):\n${source}`,
          details: { num, source, bytes: payload.length },
        };
      } catch (err) {
        return { success: false, error: `Disassembler error in logic ${num}: ${String(err)}` };
      }
    }

    case "read_words": {
      const prefix = typeof args["prefix"] === "string" ? args["prefix"].trim().toLowerCase() : "";
      const byId = new Map<number, string[]>();
      for (const [word, id] of session.sources.words) {
        if (prefix !== "" && !word.startsWith(prefix)) continue;
        if (typeof args["exact"] === "string" && word !== args["exact"].trim().toLowerCase())
          continue;
        const group = byId.get(id);
        if (group) group.push(word);
        else byId.set(id, [word]);
      }
      const groups = [...byId.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([id, words]) => ({ id, words: [...words].sort() }));
      const offset = Number(args["offset"] ?? 0);
      const limit = Math.min(100, Number(args["limit"] ?? 60));
      const shown = groups.slice(offset, offset + limit);
      const summary = shown.map((g) => `${g.id}: ${g.words.join("/")}`).join("\n");
      return {
        success: true,
        message:
          groups.length === 0
            ? prefix === ""
              ? "Dictionary is empty; call write_words before any said() handler."
              : `No dictionary words start with '${prefix}'.`
            : `Dictionary: ${session.sources.words.size} words in ${groups.length} synonym group(s)${groups.length > shown.length ? ` (first ${shown.length} shown)` : ""}.\n${summary}`,
        details: {
          totalWords: session.sources.words.size,
          groupCount: groups.length,
          groups: shown,
          offset,
          nextOffset: offset + limit < groups.length ? offset + limit : null,
          compiled: session.wordsPayload !== undefined,
        },
      };
    }

    case "write_view": {
      const num = typeof args["num"] === "number" ? args["num"] : parseInt(String(args["num"]), 10);
      if (!Number.isInteger(num) || num < 0 || num > 255) {
        return { success: false, error: `Invalid view resource number: ${num}. Must be 0..255.` };
      }
      const rawSpec = args["spec"] as Record<string, unknown> | undefined;
      const hasLoops = Array.isArray(rawSpec?.["loops"]);
      const hasFacings = rawSpec?.["facings"] !== null && rawSpec?.["facings"] !== undefined;
      if (!rawSpec || hasLoops === hasFacings) {
        return {
          success: false,
          error:
            "Missing or invalid view specification: exactly one of 'spec.loops' or 'spec.facings' is required.",
        };
      }

      const sanitizedLoops: BuildLoopInput[] = [];
      const adjustments: string[] = [];
      let specDescription: string | undefined;

      if (hasFacings) {
        // Four-facing actor shorthand: {right,left,down,up} hex-row cels,
        // mirror flags and a shared transparentColor expand to four loops.
        try {
          const built = actorSpecFromFacings(rawSpec["facings"] as Record<string, unknown>);
          sanitizedLoops.push(...built.spec.loops);
          adjustments.push(...built.adjustments);
          specDescription = built.spec.description ?? undefined;
        } catch (err) {
          return { success: false, error: `Invalid facings spec: ${String(err)}` };
        }
      }

      const rawLoops = hasFacings ? [] : (rawSpec["loops"] as unknown[]);

      for (let i = 0; i < rawLoops.length; i++) {
        const rawLoop = rawLoops[i];
        if (!rawLoop || typeof rawLoop !== "object") continue;
        const loopObj = rawLoop as Record<string, unknown>;

        const rawCels = Array.isArray(loopObj["cels"]) ? (loopObj["cels"] as unknown[]) : [];
        const mirrorVal =
          typeof loopObj["mirrorLoop"] === "number" ? loopObj["mirrorLoop"] : undefined;

        if (rawCels.length > 0) {
          if (mirrorVal !== undefined) {
            adjustments.push(
              `Loop ${i}: both cels and mirrorLoop were specified. Explicit cels took precedence.`,
            );
          }
          const cels: BuildCelInput[] = [];
          for (let celIdx = 0; celIdx < rawCels.length; celIdx++) {
            const item = rawCels[celIdx];
            if (!item || typeof item !== "object") continue;
            const celObj = item as Record<string, unknown>;
            const width = Number(celObj["width"]) || 0;
            const height = Number(celObj["height"]) || 0;
            const transparentColor =
              typeof celObj["transparentColor"] === "number" ? celObj["transparentColor"] : 0;
            const mirror = Boolean(celObj["mirror"]);
            const rawPixels = Array.isArray(celObj["pixels"]) ? (celObj["pixels"] as number[]) : [];
            const targetLen = width * height;
            let pixels = rawPixels.map((p) => Number(p) & 0x0f);
            if (targetLen > 0) {
              if (pixels.length > targetLen) {
                const excess = pixels.length - targetLen;
                pixels = pixels.slice(0, targetLen);
                adjustments.push(
                  `Loop ${i} cel ${celIdx}: pixel count was ${rawPixels.length}, expected ${width}x${height} = ${targetLen}. Auto-truncated ${excess} excess pixels. The compiled sprite retains ${width}x${height} logical dimensions. You may submit an updated write_view if you wish to adjust the cel pixels.`,
                );
              } else if (pixels.length < targetLen) {
                const missing = targetLen - pixels.length;
                pixels = pixels.concat(new Array(missing).fill(transparentColor));
                adjustments.push(
                  `Loop ${i} cel ${celIdx}: pixel count was ${rawPixels.length}, expected ${width}x${height} = ${targetLen}. Auto-padded ${missing} missing pixels with transparentColor (${transparentColor}).`,
                );
              }
            }
            cels.push({ width, height, transparentColor, mirror, pixels });
          }
          sanitizedLoops.push({ cels });
        } else if (mirrorVal !== undefined) {
          sanitizedLoops.push({ mirrorLoop: mirrorVal });
        } else {
          sanitizedLoops.push({ cels: [] });
        }
      }

      const cleanSpec: BuildViewInput = {
        loops: sanitizedLoops,
        description:
          specDescription ??
          (typeof rawSpec["description"] === "string" ? rawSpec["description"] : undefined),
      };

      try {
        const payload = buildView(cleanSpec, session.profile);
        const { png, caption, ...preview } = viewFeedback(payload, session.profile, num);
        session.container.putResource("view", num, payload);
        session.sources.views.set(num, cleanSpec);
        return {
          success: true,
          message: `View ${num} compiled successfully (${cleanSpec.loops.length} loops, ${payload.length} bytes). Inspect the sprite preview.`,
          images: [{ png, caption }],
          ...(adjustments.length > 0 ? { adjustments } : {}),
          details: {
            view: num,
            bytes: payload.length,
            loops: cleanSpec.loops.length,
            preview,
            adjustments: adjustments.length > 0 ? adjustments : undefined,
          },
        };
      } catch (err) {
        return { success: false, error: `View compilation error for view ${num}: ${String(err)}` };
      }
    }

    case "handover": {
      // Handover is the validation gate, not the agent's word that it tested:
      // every stored game test runs against the current resources (unchanged
      // verdicts come from the evidence cache), and the first handover of a
      // session also boots the world to a shown, interactive scene.
      const testRun = runGameTests(session, null);
      const gameTests = testRun.details?.["gameTests"];
      if (!testRun.success)
        return {
          success: false,
          error: `Handover rejected: ${testRun.error ?? "stored game tests failed"}`,
          details: { ...testRun.details, genesisComplete: session.genesisComplete },
          ...(testRun.images ? { images: testRun.images.slice(0, 1) } : {}),
        };
      if (!session.genesisComplete) {
        const result = validateGenesis(session);
        if (!result.success)
          return {
            ...result,
            details: { ...result.details, genesisComplete: false, gameTests },
          };
        session.genesisComplete = true;
        return {
          ...result,
          details: { ...result.details, genesisComplete: true, gameTests },
        };
      }
      return {
        success: true,
        message: "Handover validated: stored game tests pass. Resuming gameplay.",
        details: { genesisComplete: true, notes: args["notes"] ?? null, gameTests },
      };
    }

    case "write_inventory_objects": {
      let mergedItem: { id: number; name: string } | undefined;
      const mode = args["mode"] == null ? "replace" : String(args["mode"]);
      if (mode !== "replace" && mode !== "merge")
        return { success: false, error: "mode must be replace, merge, or null." };
      if (mode === "merge") {
        const item = args["item"] as Record<string, unknown> | null | undefined;
        if (item === null || item === undefined)
          return {
            success: false,
            error: "mode merge requires 'item' {id, name, location, room}.",
          };
        const items = readInventoryObjects(session.getFiles().get("OBJECT"), session.profile);
        const id = item["id"] == null ? items.length : item["id"];
        const itemName = item["name"];
        if (
          typeof id !== "number" ||
          !Number.isInteger(id) ||
          id < 0 ||
          id > items.length ||
          id > 255
        )
          return {
            success: false,
            error: "item.id must name an existing item, or be null to append.",
          };
        if (
          typeof itemName !== "string" ||
          !itemName.trim() ||
          [...itemName].some((char) => char.charCodeAt(0) === 0 || char.charCodeAt(0) > 255)
        )
          return {
            success: false,
            error: "item.name must be nonempty AGI byte text without zero bytes.",
          };
        const location = item["location"];
        if (!["carried", "room", "inactive"].includes(String(location)))
          return {
            success: false,
            error: "item.location must be carried, room, or inactive.",
          };
        const room = location === "carried" ? 255 : location === "inactive" ? 0 : item["room"];
        if (
          typeof room !== "number" ||
          !Number.isInteger(room) ||
          room < 0 ||
          room > 255 ||
          (location === "room" && (room < 1 || room > 254))
        )
          return { success: false, error: "A room location needs item.room 1..254." };
        args = { ...args, objects: items.map((o) => ({ ...o })) };
        (args["objects"] as { name: string; startingRoom: number }[])[id as number] = {
          name: itemName.trim(),
          startingRoom: room,
        };
        mergedItem = { id: id as number, name: itemName.trim() };
      }
      // Anthropic tools are not strict (see toolTransport.ts), so a malformed
      // call must fail here instead of silently replacing the OBJECT table.
      if (!Array.isArray(args["objects"]))
        return {
          success: false,
          error:
            "Missing or invalid 'objects': expected an array of { name, startingRoom }. The table was not changed.",
        };
      const rawObjects = args["objects"] as unknown[];
      const objects: { name: string; startingRoom: number }[] = [];
      for (const [index, item] of rawObjects.entries()) {
        const obj =
          item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
        const name = typeof obj?.["name"] === "string" ? obj["name"].trim() : "";
        const startingRoom = obj?.["startingRoom"] ?? 0;
        if (!obj || name.length === 0 || !Number.isInteger(startingRoom))
          return {
            success: false,
            error: `Invalid inventory item at index ${index}: expected { name: non-empty string, startingRoom: integer or null }. The table was not changed.`,
          };
        objects.push({ name, startingRoom: startingRoom as number });
      }
      try {
        const previous = session.objectPayload ?? session.container.files.get("OBJECT");
        // The decoded header keeps the engine's object-record capacity stable
        // whichever storage form the previous file used (see inventoryFile.ts).
        const maximumDrawableObjectIndex =
          previous && previous.length >= 3
            ? decodeInventoryFile(previous, session.profile)[2]!
            : 255;
        const payload = buildObjectFile(objects, session.profile, maximumDrawableObjectIndex);
        session.objectPayload = payload;
        session.sources.objects = objects;
        return {
          success: true,
          message: `OBJECT file compiled successfully with ${objects.length} inventory items (${payload.length} bytes, profile ${session.profile.id}).`,
          details: {
            objectCount: objects.length,
            bytes: payload.length,
            objects: objects.map((o) => o.name),
            ...(mergedItem
              ? { id: mergedItem.id, name: mergedItem.name, updatedFiles: ["OBJECT"] }
              : {}),
          },
        };
      } catch (err) {
        return { success: false, error: `OBJECT file generation error: ${String(err)}` };
      }
    }

    case "write_sound": {
      const num = typeof args["num"] === "number" ? args["num"] : parseInt(String(args["num"]), 10);
      if (!Number.isInteger(num) || num < 0 || num > 255) {
        return { success: false, error: `Invalid sound resource number: ${num}. Must be 0..255.` };
      }
      const rawTracks = Array.isArray(args["tracks"]) ? (args["tracks"] as unknown[]) : [];
      const tracks: SoundTrackInput[] = [];
      for (const t of rawTracks) {
        if (!t || typeof t !== "object") continue;
        const trackObj = t as Record<string, unknown>;
        const rawNotes = Array.isArray(trackObj["notes"]) ? (trackObj["notes"] as unknown[]) : [];
        const notes: SoundNoteInput[] = [];
        for (const n of rawNotes) {
          if (!n || typeof n !== "object") continue;
          const noteObj = n as Record<string, unknown>;
          const noteVal = noteObj["note"];
          notes.push({
            note: typeof noteVal === "number" || typeof noteVal === "string" ? noteVal : null,
            duration: typeof noteObj["duration"] === "number" ? noteObj["duration"] : 1,
            freqDivisor: typeof noteObj["freqDivisor"] === "number" ? noteObj["freqDivisor"] : null,
            attenuation: typeof noteObj["attenuation"] === "number" ? noteObj["attenuation"] : null,
          });
        }
        tracks.push({ notes });
      }
      try {
        const payload = buildSound(tracks);
        session.container.putResource("sound", num, payload);
        session.sources.sounds.set(num, tracks);
        if (session.authoring.music) delete session.authoring.music[String(num)];
        return {
          success: true,
          message: `Sound ${num} compiled successfully (${tracks.length} tracks, ${payload.length} bytes authentic 4-channel audio).`,
          details: { sound: num, bytes: payload.length, tracks: tracks.length },
        };
      } catch (err) {
        return {
          success: false,
          error: `Sound compilation error for sound ${num}: ${String(err)}`,
        };
      }
    }

    case "inspect_world_bible": {
      const filter = args["filter"] ?? "all";
      if (!["all", "rooms", "objects", "words", "intent", "slots"].includes(String(filter)))
        return {
          success: false,
          error: "Use filter all, rooms, objects, words, intent, slots, or null.",
        };
      if (filter === "slots") return listResources(session, args["kind"]);
      try {
        const details: Record<string, unknown> = {
          genesisComplete: session.genesisComplete,
          authoredIntent: Object.fromEntries(
            Object.entries(session.authoring.world).map(([section, entries]) => [
              section,
              { count: Object.keys(entries).length, keys: Object.keys(entries).slice(0, 16) },
            ]),
          ),
          bindings: Object.fromEntries(Object.entries(session.authoring.bindings).slice(0, 32)),
          bindingCount: Object.keys(session.authoring.bindings).length,
        };
        if (filter === "intent") {
          const section = String(args["section"] ?? "facts");
          if (!["rooms", "facts", "quests", "bindings"].includes(section))
            return { success: false, error: "section must be rooms, facts, quests or bindings." };
          const entries = Object.entries(
            section === "bindings"
              ? session.authoring.bindings
              : session.authoring.world[section as "rooms" | "facts" | "quests"],
          );
          const offset = Number(args["offset"] ?? 0);
          const selected =
            typeof args["name"] === "string"
              ? entries.filter(([name]) => name === args["name"])
              : entries.slice(offset, offset + 1);
          return {
            success: true,
            message: `Authored intent: ${section}. This records the author's intent; inspect compiled logic or playtest to verify implementation.`,
            details: {
              section,
              entries: Object.fromEntries(selected),
              count: entries.length,
              offset,
              nextOffset: args["name"] == null && offset + 1 < entries.length ? offset + 1 : null,
            },
          };
        }
        if (filter === "all" || filter === "rooms") {
          const listing = listResources(session, null);
          const present = listing.details!["present"] as Record<ResourceKind, number[]>;
          details["rooms"] = [...new Set([...present.logic, ...present.picture])].sort(
            (a, b) => a - b,
          );
          details["resources"] = present;
          details["views"] = present.view;
          details["sounds"] = present.sound;
        }
        if (filter === "all" || filter === "objects") {
          const inventory = readInventoryObjects(session.getFiles().get("OBJECT"), session.profile);
          details["objects"] = inventory.map((o) => o.name);
          details["inventory"] = inventory;
        }
        if (filter === "all" || filter === "words")
          details["wordCount"] = session.sources.words.size;
        return {
          success: true,
          message:
            "Current game resource index. Inventory array indices are object IDs; startingRoom is the initial location.",
          details,
        };
      } catch (err) {
        return { success: false, error: `Cannot inspect game: ${String(err)}` };
      }
    }

    case "playtest_room":
      return playtestRoom(session, args);

    default:
      return { success: false, error: `Unknown tool: '${name}'.` };
  }
}

/**
 * Live-game sources injected by the host.
 *
 * The live-inspection tool — read_live's state/objects/frames sections — reads
 * the INTERPRETER, which lives in a Web Worker and answers asynchronously. The
 * synchronous `executeAgentTool` above cannot reach it, so the host passes
 * these in to `executeAgentToolAsync`. With no deps attached a section fails
 * with a clear message. The host selects the tools available during each phase.
 */
export interface AgentRuntimeDeps {
  readonly readOnly?: boolean;
  /** Phase availability policy: names outside the list are denied before dispatch. */
  readonly allowedTools?: readonly string[];
  readonly frames?: FrameSource | undefined;
  readonly engine?: EngineStateSource | undefined;
  /** Captures the paused interpreter's resumable image, or null when it cannot. */
  readonly checkpoint?: (() => Uint8Array | null | Promise<Uint8Array | null>) | undefined;
}

/**
 * Host input bindings in readable form: the key name plus what it does —
 * a menu item text, an engine service label, or its controller number.
 */
function describeControls(
  controls: unknown,
): { key: string; controller: number | null; label: string | null }[] {
  if (!Array.isArray(controls)) return [];
  return controls.slice(0, 32).map((binding) => {
    const b = binding as Record<string, unknown>;
    const menus = Array.isArray(b["menuItems"])
      ? b["menuItems"]
          .map((item) => String((item as Record<string, unknown>)["text"] ?? "").trim())
          .filter(Boolean)
      : [];
    return {
      key: typeof b["key"] === "number" ? describeKeyWord(b["key"]) : String(b["key"]),
      controller: typeof b["controller"] === "number" ? b["controller"] : null,
      label:
        (typeof b["label"] === "string" ? b["label"] : null) ??
        (menus.length ? [...new Set(menus)].join(" / ") : null),
    };
  });
}

/** Returned when a runtime tool is called with no interpreter attached. */
const NO_LIVE_GAME =
  "No live game is attached to this session, so live inspection is unavailable. Use read_logic, read_picture and inspect_world_bible instead.";

/**
 * The picture text the agent wrote this session, only while it still compiles to
 * the stored resource bytes. An imported or stale source that disagrees with the
 * container is ignored so reads and edits never resurrect discarded work.
 */
export function authoredPictureSource(session: AgentSessionState, num: number): string | undefined {
  const authored = session.sources.pictures.get(num);
  const payload = session.container.getResource("picture", num);
  if (authored === undefined || !payload) return undefined;
  try {
    const compiled = compilePictureSource(authored, { profile: session.profile }).bytes;
    if (compiled.length !== payload.length) return undefined;
    for (let index = 0; index < compiled.length; index++)
      if (compiled[index] !== payload[index]) return undefined;
    return authored;
  } catch {
    return undefined;
  }
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
    const defined = new Set(
      [...authored.matchAll(/^\s*#define\s+(\w+)/gm)].map((match) => match[1]),
    );
    const bindings = Object.entries(session.authoring.bindings)
      .filter(([name]) => !defined.has(name))
      .map(([name, binding]) => `#define ${name} ${binding.num}`)
      .join("\n");
    const fullSource = bindings.length ? `${bindings}\n${authored}` : authored;
    const compiled = assembleLogic(fullSource, {
      dictionary: session.sources.words,
      profile: session.profile,
    }).payload;
    if (compiled.length !== payload.length) return undefined;
    for (let index = 0; index < compiled.length; index++)
      if (compiled[index] !== payload[index]) return undefined;
    return authored;
  } catch {
    return undefined;
  }
}

/** Explicit capabilities for a discussion turn; new tools require deliberate approval here. */
export const ASK_TOOLS: readonly string[] = [
  "read_room_context",
  "read_picture",
  "read_logic",
  "read_words",
  "read_view",
  "read_sound",
  "preview_sound",
  "read_command_reference",
  "read_authoring_guide",
  "read_game_tests",
  "run_game_tests",
  "inspect_world_bible",
  "playtest_room",
  "read_live",
];

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

async function executeReadFrames(
  args: Record<string, unknown>,
  source: FrameSource,
  session: AgentSessionState,
): Promise<AgentToolResult> {
  const count = clampInt(args["count"], 1, 1, MAX_FRAMES);
  const stride = clampInt(args["stride"], 1, 1, 255);
  // Default to one contact sheet for multiple frames: one image item keeps
  // the transcript lean; per-frame images are available via sheet: false.
  const sheet = args["sheet"] !== false;
  const planeArg = typeof args["plane"] === "string" ? args["plane"].toLowerCase() : "visual";
  if (planeArg !== "visual" && planeArg !== "priority") {
    return {
      success: false,
      error: `read_live frames: plane must be 'visual', 'priority' or null; got '${planeArg}'.`,
    };
  }
  const plane: FramePlane = planeArg;

  let frames: AgentFrame[];
  try {
    frames = await source.read({ count, stride });
  } catch (err) {
    return { success: false, error: `read_live frames failed: ${String(err)}` };
  }
  if (frames.length === 0) {
    return {
      success: false,
      error: "The frame ring is empty: the interpreter has not completed a cycle yet.",
    };
  }

  const cycles = frames.map((f) => f.cycle);
  const noteText =
    "Text rows are not drawn into the image (the glyph face is host-side); the text surface is transcribed below.";
  const rows = textRows(frames[frames.length - 1]!);
  const transcript =
    rows.length > 0 ? `\nText surface of the newest frame:\n${rows.join("\n")}` : "";

  const images: AgentToolImage[] = [];
  if (sheet && frames.length > 1) {
    const { png, grid } = framesToContactSheet(frames, plane);
    images.push({
      png,
      caption: `Contact sheet, ${plane} plane: ${grid.cols} columns x ${grid.rows} rows, row-major (oldest top-left), ${FRAME_WIDTH}x${FRAME_HEIGHT} per tile, ${SHEET_GAP}px gutter, sheet ${grid.width}x${grid.height}. Cycles in order: ${cycles.join(", ")}. ${noteText}`,
    });
  } else {
    for (const frame of frames) {
      images.push({
        png: frameToPng(frame, plane),
        caption: `Cycle ${frame.cycle}, ${plane} plane, ${FRAME_WIDTH}x${FRAME_HEIGHT}. ${noteText}`,
      });
    }
  }

  return {
    success: true,
    message: `${frames.length} frame(s), ${plane} plane, stride ${stride}, cycles ${cycles.join(", ")}.${transcript}`,
    details: {
      cycles,
      stride,
      plane,
      sheet: sheet && frames.length > 1,
      imageCount: images.length,
      origin: {
        kind: "live",
        checkpoint: frames[frames.length - 1]!.cycle,
        resourceSet: resourceSetRevision(session),
      },
    },
    images,
  };
}

/**
 * Execute a tool that may need the live interpreter. Validate all calls before
 * choosing a runtime handler or the shared synchronous resource dispatcher.
 */
export async function executeAgentToolAsync(
  session: AgentSessionState,
  name: string,
  args: Record<string, unknown>,
  deps?: AgentRuntimeDeps,
): Promise<AgentToolResult> {
  if (deps?.allowedTools && !deps.allowedTools.includes(name))
    return {
      success: false,
      error: `'${name}' is not available in this phase of the session.`,
    };
  if (deps?.readOnly && !ASK_TOOLS.includes(name))
    return {
      success: false,
      error:
        "Ask mode is read-only. Explain the proposed change; the player can switch to Remix to apply it.",
    };
  const call = prepareAgentToolCall(name, args);
  if (!call.success) return call;
  args = call.args;
  if (name === "read_room_context") {
    let live: Record<string, unknown> | null = null;
    let liveObjects: unknown = null;
    if (deps?.engine) {
      live = (await deps.engine.state()) as Record<string, unknown> | null;
      try {
        liveObjects = await deps.engine.objects();
      } catch {
        liveObjects = null;
      }
    }
    const room = args["room"] ?? live?.["room"];
    if (typeof room !== "number" || !Number.isInteger(room) || room < 0 || room > 255)
      return { success: false, error: "Supply room 0..255 when no live room is attached." };
    const logic = executeAgentTool(session, "read_logic", { num: room, offset: 0, limit: 80 });
    const index = listResources(session, null);
    return {
      success: true,
      message: `Room ${room}: compiled resources and authored intent${live ? "; live state is the current paused interpreter" : ""}.`,
      details: {
        room,
        logic: logic.success ? logic.details : { error: logic.error },
        resources: index.details,
        origin: { kind: "staged", resourceSet: resourceSetRevision(session) },
        wordCount: session.sources.words.size,
        intent: session.authoring.world.rooms[String(room)] ?? null,
        bindings: Object.fromEntries(Object.entries(session.authoring.bindings).slice(0, 32)),
        bindingCount: Object.keys(session.authoring.bindings).length,
        inventoryDefinitions: readInventoryObjects(
          session.getFiles().get("OBJECT"),
          session.profile,
        ),
        ...(live
          ? {
              live: {
                room: live["room"],
                egoX: live["egoX"],
                egoY: live["egoY"],
                inventory: live["inventory"],
                modalKind: live["modalKind"],
                controls: describeControls(live["controls"]),
                objects: liveObjects,
              },
            }
          : {}),
      },
    };
  }
  if (name === "read_live") {
    const stateArg = args["state"] as Record<string, unknown> | null | undefined;
    const objectsArg = args["objects"] as Record<string, unknown> | null | undefined;
    const framesArg = args["frames"] as Record<string, unknown> | null | undefined;
    if (stateArg == null && objectsArg == null && framesArg == null)
      return {
        success: false,
        error: "Select at least one section: state, objects, or frames.",
      };
    const details: Record<string, unknown> = {};
    const images: { png: Uint8Array; caption: string }[] = [];
    const messages: string[] = [];

    if (stateArg != null) {
      if (!deps?.engine) {
        details["state"] = { error: NO_LIVE_GAME };
      } else
        try {
          const state = (await deps.engine.state()) as Record<string, unknown> | null;
          if (!state) {
            details["state"] = { error: "the interpreter returned no state." };
          } else {
            const stateDetails: Record<string, unknown> = { ...state };
            stateDetails["origin"] = {
              kind: "live",
              ...(typeof state["cycle"] === "number" ? { checkpoint: state["cycle"] } : {}),
              resourceSet: resourceSetRevision(session),
            };
            for (const [field, parameter] of [
              ["vars", "variables"],
              ["flags", "flags"],
            ] as const) {
              const values = state[field];
              const ids = stateArg[parameter];
              if (Array.isArray(values) && (Array.isArray(ids) || stateArg["compact"] === true)) {
                stateDetails[field] = Object.fromEntries(
                  values.flatMap((value, id) =>
                    (Array.isArray(ids) ? ids.includes(id) : Boolean(value)) ? [[id, value]] : [],
                  ),
                );
              }
            }
            details["state"] = stateDetails;
            messages.push(
              `room ${String(state["room"])}, ego (${String(state["egoX"])}, ${String(state["egoY"])})`,
            );
          }
        } catch (err) {
          details["state"] = { error: String(err) };
        }
    }

    if (objectsArg != null) {
      if (!deps?.engine) {
        details["objects"] = { error: NO_LIVE_GAME };
      } else
        try {
          const objects = await deps.engine.objects();
          const list = (Array.isArray(objects) ? objects : []).filter(
            (object) =>
              !Array.isArray(objectsArg["ids"]) ||
              objectsArg["ids"].includes((object as Record<string, unknown>)["num"]),
          );
          details["objects"] = {
            objects: list,
            origin: { kind: "live", resourceSet: resourceSetRevision(session) },
          };
          messages.push(`${list.length} object(s)`);
        } catch (err) {
          details["objects"] = { error: String(err) };
        }
    }

    if (framesArg != null) {
      if (!deps?.frames) {
        details["frames"] = { error: NO_LIVE_GAME };
      } else {
        const result = await executeReadFrames(framesArg, deps.frames, session);
        if (!result.success) {
          details["frames"] = { error: result.error };
        } else {
          details["frames"] = result.details;
          if (result.images) images.push(...result.images);
          if (result.message) messages.push(result.message.split("\n")[0]!);
        }
      }
    }

    const allFailed =
      [stateArg, objectsArg, framesArg].filter((s) => s != null).length > 0 &&
      ["state", "objects", "frames"].every(
        (key) =>
          details[key] === undefined ||
          (details[key] as Record<string, unknown>)["error"] !== undefined,
      ) &&
      Object.values(details).some(
        (entry) => (entry as Record<string, unknown>)["error"] !== undefined,
      );
    return {
      success: !allFailed,
      ...(allFailed
        ? {
            error: Object.values(details)
              .map((entry) => (entry as Record<string, unknown>)["error"])
              .filter(Boolean)
              .join("; "),
          }
        : {}),
      message: `read_live: ${messages.join("; ") || "no sections returned."}`,
      details,
      ...(images.length ? { images } : {}),
    };
  }

  if (name === "playtest_room" && args["fromLiveCheckpoint"] === true) {
    // Candidate preview: restore the captured live checkpoint into an engine
    // built from the staged resources, instead of a fresh boot.
    const image = deps?.checkpoint ? await deps.checkpoint() : null;
    if (!image)
      return {
        success: false,
        error:
          "fromLiveCheckpoint requires an attached live game paused at a resumable cycle boundary.",
      };
    return withEvidenceOrigin(session, name, playtestRoom(session, args, { setupImage: image }));
  }
  return withEvidenceOrigin(session, name, executeValidatedAgentTool(session, name, args));
}

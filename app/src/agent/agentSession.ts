import { beginProviderTask } from "./providerBudget.ts";
import type { AgentChat } from "../../../src/agent/chats.ts";
import { computeResourceRevision } from "../../../src/authoring/resourceRevision.ts";
import { AgentRun } from "./agentRun.ts";
/**
 * Agent Session: Manages the ever-growing, append-only frontier LLM session
 * starting from Genesis (the adventure template) and continuing through runtime turns
 * (room preparation and explicit live patches), preserving the cached prefix.
 */

import {
  createAgentSessionState,
  type AgentSessionState,
  type AgentSourceStore,
  type AgentToolImage,
  type AgentToolResult,
} from "../../../src/agent/agentState.ts";
import {
  ASK_TOOLS,
  buildSound,
  type SoundTrackInput,
  type executeAgentTool,
  executeAgentToolAsync,
  GENESIS_TOOLS,
  REMIX_TOOLS,
  ROOM_AUTHORING_TOOLS,
  STUDIO_ASSIST_TASK_TOOLS,
  withReferences,
  type AgentRuntimeDeps,
  type AgentToolDeps,
} from "../../../src/agent/tools.ts";
import {
  createReferenceWatch,
  referenceManifest,
  type ReferenceArt,
  type ReferenceSource,
} from "../../../src/agent/referenceTools.ts";
import { buildView, type BuildViewInput } from "../../../src/view/view.ts";
import {
  isSoundDocumentEnvelopeClaim,
  readSoundDocumentSource,
} from "../../../src/sound/source.ts";
import {
  resourceSetHint,
  validateAuthoringState,
  type AuthoringState,
} from "../../../src/agent/authoringState.ts";
import {
  adoptTurnState,
  forkAgentState,
  changedResources,
  validateRoomCandidate,
} from "./sessionState.ts";
import { readInventoryObjects } from "../../../src/agent/inventory.ts";
import { prepareRoomPatch } from "../../../src/agent/roomPatch.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import { installBoilerplateSeed } from "../../../src/agent/baseTemplate.ts";
import { buildWordsTok } from "../../../src/logic/words.ts";
import { openContainer } from "../../../src/container/container.ts";
import {
  createGenesisPrompt,
  createOrientationPrompt,
  createRuntimeRoomPrompt,
  createSceneBrief,
  type OrientationInput,
} from "../../../src/agent/prompt.ts";
import {
  commitWorld,
  commitWorldDraft,
  worldRevision,
  type WorldCommit,
  type WorldDraft,
  type WorldPlan,
} from "../../../src/agent/worldPlan.ts";
import {
  createAnthropicConversation,
  LlmResponseError,
  createOpenAiConversation,
  type LlmConfig,
  type UnifiedConversation,
  type LlmTurnResult,
} from "./llmClient.ts";
import { GAME_DICTIONARY, StubAgent } from "./stubAgent.ts";
import { createReferenceStub } from "./referenceStub.ts";
import {
  createStudioAssistPrompt,
  createStudioAssistStub,
  type StudioAssistRequest,
  type StudioAssistResult,
} from "./studioAssist.ts";
import { createStudioAssist } from "../../../src/agent/studioAssistTools.ts";
import { projectToolResult } from "../../../src/agent/toolTransport.ts";
import { runGameTests } from "../../../src/agent/gameTests.ts";
import { verifyPlanConnections } from "../../../src/agent/roomMap.ts";
import type { AgentEventSink, AgentHandler, LlmRequest } from "./hostRequests.ts";
import { continuationTranscript } from "../archive/projectArchive.ts";

/** Resource the remix turn wrote and the host must patch into the live game. */
interface PatchedResource {
  kind: "logic" | "picture" | "view" | "sound";
  num: number;
  payload: Uint8Array;
}

/** Outcome of one remix turn. */
export interface PowerUpResult {
  /** The agent's final text turn — what the bubble shows before it closes. */
  text: string;
  /** Everything it patched, in call order. */
  patched: PatchedResource[];
  /** Updated auxiliary files; these must reach the live parser, inventory and export. */
  files?: Partial<Record<"WORDS.TOK" | "OBJECT" | "TESTS.JSON", Uint8Array>>;
}

export interface BootResources {
  files: Record<string, Uint8Array>;
  words: [string, number][];
  transcript?: unknown[] | undefined;
  sessionId?: string | undefined;
}

/** What a player turn carries besides its text. */
export interface TurnReferences {
  /** Stored reference records the player attached to this request. */
  readonly referenceIds?: readonly string[] | undefined;
  /**
   * Full images in the request, the way references travelled before
   * handles. Only the reference eval's comparison arm passes them
   * (evals/reference-benchmark.ts).
   */
  readonly legacyImages?: readonly AgentToolImage[] | undefined;
}

/** A turn's reference art: what its tools may view and what its request carries. */
interface ReferenceTurn {
  readonly references: ReferenceSource | undefined;
  /** The manifest, prefixed to the request text; empty when none rides it. */
  readonly text: string;
  readonly images: AgentToolImage[] | undefined;
}

export interface AgentChatMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * The remix user turn. A tail appended to the transcript, never an edit of
 * the cached system prefix.
 */
function createPowerUpPrompt(instruction: string, room: number): string {
  return `### LIVE PATCH REQUEST

The world is frozen at a cycle boundary in room ${room}, and the player has asked for a change:

"${instruction.trim()}"

Look before you write: read_room carries the room's live state, object table and resources — pass its 'frames' arg for the paused screen and 'state' for the full tables; read_logic / read_picture only when the request touches that resource. Patch the smallest thing that achieves what was asked — a color remap is edit_cels with 'recolor', no pixel rows needed — in the room the player is standing in unless they said otherwise. finish runs the full stored suite; playtest only when behavior is uncertain. When you are done, reply with one short sentence telling the player what changed — that sentence closes the bubble and the game resumes.`;
}

/**
 * The host verdict for a staged remix candidate — the executable half of
 * finish. Every stored game test replays against the staged resources
 * and every declared plan exit needs a reachable compiled transition. The
 * genesis boot check is absent on purpose: the running game already proves
 * it boots, and an imported game has no genesis to re-litigate. Returns the
 * rejection text, or null when the candidate may commit.
 */
function remixVerdict(staged: AgentSessionState): string | null {
  const testRun = runGameTests(staged, null);
  if (!testRun.success) return `Stored game tests failed: ${testRun.error ?? "unknown failure"}`;
  const logics = new Map<number, Uint8Array>();
  for (let num = 0; num <= 255; num++) {
    const payload = staged.container.getResource("logic", num);
    if (payload) logics.set(num, payload);
  }
  const connections = verifyPlanConnections(logics, staged.authoring.world.rooms, staged.profile);
  if (connections.missing.length || connections.mismatched.length) {
    const first = connections.missing[0] ?? connections.mismatched[0]!;
    const cause =
      "compiled" in first
        ? `its compiled transition leaves the ${first.compiled} edge instead`
        : "no compiled new.room transition reaches it";
    const extra = connections.missing.length + connections.mismatched.length - 1;
    return (
      `room ${first.from} declares exit ${JSON.stringify(first.name)} ` +
      `to room ${first.to} but ${cause}. ` +
      "Implement the exit in the room's logic or revise the plan with update_plan." +
      (extra > 0 ? ` ${extra} more declared exit(s) also fail validation.` : "")
    );
  }
  return null;
}

/** A checkpoint off the tape is untrusted input: it must be an object before stateFromAuthoredData validates its fields. */
function validateAuthoringSnapshot(snapshot: unknown): Record<string, unknown> {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot))
    throw new Error("The recorded authoring checkpoint is malformed.");
  return snapshot as Record<string, unknown>;
}

/**
 * Build the session state a set of authored bytes belongs to: container plus
 * auxiliary payloads, the live dictionary, and — when the tape or a project
 * record supplies one — the snapshot's validated authoring state and
 * sources. Shared by project load (fromAuthoredData) and history adoption
 * (adoptAuthoredData); the snapshot's deep validation lives here so both
 * paths reject the same malformed input. `profile` is the game's interpreter
 * override, when the player chose one.
 */
function stateFromAuthoredData(
  files: Record<string, Uint8Array>,
  words: [string, number][],
  authoringState?: Record<string, unknown>,
  profile?: ProfileId,
): AgentSessionState {
  const fileMap = new Map(Object.entries(files));
  const container = openContainer(fileMap, profile ? { profile } : {});
  const state = createAgentSessionState(container, profile);
  // Real copies, not refs: a Node Buffer's .slice() is a view, so callers
  // must never rely on the session detaching their byte arrays itself.
  state.wordsPayload = files["WORDS.TOK"] ? new Uint8Array(files["WORDS.TOK"]) : undefined;
  state.objectPayload = files["OBJECT"] ? new Uint8Array(files["OBJECT"]) : undefined;
  state.testsPayload = files["TESTS.JSON"] ? new Uint8Array(files["TESTS.JSON"]) : undefined;
  for (const [w, id] of words) {
    state.sources.words.set(w, id);
  }
  if (authoringState) {
    if (authoringState["authoring"])
      state.authoring = validateAuthoringState(authoringState["authoring"]);
    const sources = authoringState["sources"] as Record<string, unknown> | undefined;
    if (sources) {
      for (const kind of ["logics", "pictures"] as const) {
        const entries = sources[kind];
        if (entries !== undefined) {
          if (!Array.isArray(entries) || entries.length > 256)
            throw new Error(`Invalid project ${kind} sources.`);
          for (const entry of entries) {
            if (
              !Array.isArray(entry) ||
              entry.length !== 2 ||
              !Number.isInteger(entry[0]) ||
              entry[0] < 0 ||
              entry[0] > 255 ||
              typeof entry[1] !== "string"
            )
              throw new Error(`Invalid project ${kind} source.`);
            state.sources[kind].set(entry[0], entry[1]);
          }
        }
      }
      for (const kind of ["views", "sounds"] as const) {
        const entries = sources[kind];
        if (entries === undefined) continue;
        if (!Array.isArray(entries) || entries.length > 256)
          throw new Error(`Invalid project ${kind} sources.`);
        for (const entry of entries) {
          if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            !Number.isInteger(entry[0]) ||
            entry[0] < 0 ||
            entry[0] > 255
          )
            throw new Error(`Invalid project ${kind} source.`);
          if (kind === "views") {
            buildView(entry[1] as BuildViewInput, state.profile);
            state.sources.views.set(entry[0], entry[1] as BuildViewInput);
          } else {
            const body: unknown = entry[1];
            if (isSoundDocumentEnvelopeClaim(body)) {
              // A tagged `agi.sound-document` claim is validated under this
              // session's profile, must reproduce the native SOUND bytes
              // exactly, and is stored as the owned envelope — never
              // adopted over an absent or different resource, never read
              // as legacy tracks.
              state.sources.sounds.set(
                entry[0],
                readSoundDocumentSource(
                  body,
                  state.profile.id,
                  container.getResource("sound", entry[0]),
                ),
              );
            } else {
              buildSound(body as SoundTrackInput[]);
              state.sources.sounds.set(entry[0], body as SoundTrackInput[]);
            }
          }
        }
      }
    }
  }
  return state;
}

export class AgentSession implements AgentHandler {
  readonly task: AgentRun;
  private messages: AgentChatMessage[] = [];
  readonly state: AgentSessionState;
  /** The game's interpreter override; rebuilt state keeps it rather than re-detecting. */
  private profileOverride: ProfileId | undefined;
  private readonly config: LlmConfig;
  private readonly onEvent: AgentEventSink;
  private conversation: UnifiedConversation | null;
  private backgroundChats: AgentChat[] = [];
  private readonly stubFallback: StubAgent | null;
  /** Conversation data retained while a non-stub provider has no connected key. */
  private readonly retainedTranscript: unknown[];
  private readonly retainedSessionId: string | undefined;
  /** Live-game sources for read_room. */
  private runtime: AgentRuntimeDeps = {};
  /** Local tool-execution ms since the last provider request, for telemetry. */
  private pendingToolMs = 0;
  private diagnosticSeq = 0;
  /** Context is attached to the first submitted request, never sent on panel open. */
  private oriented = false;
  private orientation: Pick<OrientationInput, "game" | "profile"> | undefined;
  /** The reference ids the last manifest this session sent listed. */
  private manifestKey = "";

  constructor(
    config: LlmConfig,
    onEvent: AgentEventSink,
    existingState?: AgentSessionState,
    initialTranscript?: unknown[],
    sessionId?: string,
  ) {
    this.task = new AgentRun(
      config.model,
      (state) => onEvent("log", "[Task] " + state.status, { task: state }),
      config.budgetUsd,
    );
    this.config = { ...config };
    this.onEvent = onEvent;
    this.state = existingState ?? createAgentSessionState();
    this.retainedTranscript = initialTranscript ? structuredClone(initialTranscript) : [];
    this.retainedSessionId = sessionId;

    if (config.provider === "anthropic" && config.apiKey.trim()) {
      this.conversation = createAnthropicConversation(
        this.config,
        this.retainedTranscript,
        this.task,
        undefined,
        sessionId,
      );
      this.stubFallback = null;
    } else if (config.provider === "openai" && config.apiKey.trim()) {
      this.conversation = createOpenAiConversation(
        this.config,
        this.retainedTranscript,
        sessionId,
        this.task,
      );
      this.stubFallback = null;
    } else if (config.provider === "stub" && config.stubScript) {
      this.conversation = createReferenceStub(config.stubScript);
      this.stubFallback = null;
    } else if (config.provider === "stub") {
      this.conversation = null;
      this.stubFallback = new StubAgent(onEvent);
    } else {
      this.conversation = null;
      this.stubFallback = null;
    }
  }

  /**
   * Attach the running interpreter. Without this the three runtime tools
   * report "no live game" if the host cannot supply an observation.
   */
  setRuntime(deps: AgentRuntimeDeps): void {
    this.runtime = deps;
  }

  runAsk(question: string, room: number, attachments?: TurnReferences): Promise<string> {
    if (this.task.snapshot().status === "idle") beginProviderTask(this.task.snapshot().allowance);
    return this.task.run(() => this.ask(question, room, attachments));
  }
  private async ask(question: string, room: number, attachments?: TurnReferences): Promise<string> {
    this.assertAdoptable();
    if (!this.conversation && !this.stubFallback)
      throw new Error("Connect an API key in AI settings before using Ask or Remix.");
    this.messages.push({ role: "user", text: question });
    this.onEvent("request", `[Ask] ${question}`, { instruction: question, room });
    const context = await this.orientationContext(room, ASK_TOOLS, true);
    if (!this.conversation) {
      const result = await this.executeTool(
        this.state,
        "read_room",
        {
          room,
          state: { compact: true, variables: null, flags: null },
          frames: null,
        },
        { ...this.runtime, readOnly: true, allowedTools: ASK_TOOLS },
      );
      const text = result.success
        ? `You are in room ${room}. This test provider can inspect the game; connect a model for hints and debugging.`
        : result.error!;
      this.onEvent("response", `[Ask] ${text}`, { text });
      this.messages.push({ role: "assistant", text });
      return text;
    }
    const art = await this.referenceTurn(attachments);
    const tools = withReferences(ASK_TOOLS, art.references);
    this.conversation.setAvailableTools(tools);
    const inspected = forkAgentState(this.state);
    const watch = createReferenceWatch(art.references);
    try {
      let turn = await this.observeTurn(
        this.conversation.sendUserMessage(
          `${context}${art.text}### ASK REQUEST
The game is paused in room ${room}. This turn is a read-only conversation, not a request to edit.
${question.trim()}

Answer the player's question using evidence from inspection when needed. For hints, avoid spoilers beyond what was requested. Distinguish game logic from suspected engine faults and explain what you observed and what remains uncertain. playtest_room starts from boot, not the live checkpoint. Do not claim to have replayed earlier events or inspected a call stack unless a tool actually supplies it. If a content fix would help, describe it for the player to apply in Remix. Engine implementation changes belong in the development workflow. Keep the reply concise and useful; this conversation stays open.`,
          art.images,
        ),
        "ask",
      );
      while (turn.toolCalls.length) {
        const results: { toolCallId: string; result: AgentToolResult }[] = [];
        for (const call of turn.toolCalls) {
          await this.task.checkpoint(false);
          this.onEvent("request", `[Ask] ${call.name}`, { tool: call.name });
          this.task.assertActive();
          this.assertAdoptable();
          const toolStart = performance.now();
          const result = watch.record(
            call.name,
            call.input,
            await this.executeTool(inspected, call.name, call.input, {
              ...this.runtime,
              readOnly: true,
              allowedTools: tools,
              references: art.references,
            }),
          );
          this.pendingToolMs += performance.now() - toolStart;
          this.onEvent(
            result.success ? "response" : "error",
            `[Ask] ${call.name} → ${result.success ? (result.message ?? "Done") : result.error}`,
            { tool: call.name, result: { ...result, images: undefined } },
          );
          this.task.recordTool(
            call.name,
            call.input,
            result,
            computeResourceRevision(Object.fromEntries(this.state.getFiles())),
          );
          results.push({ toolCallId: call.id, result: this.projectForModel(result) });
        }
        this.conversation.appendToolResults(results);
        turn = await this.observeTurn(this.conversation.complete(), "ask");
      }
      const text = turn.text || "What would you like to explore next?";
      this.noteUnviewed("Ask", watch.unviewed(text));
      this.onEvent("response", `[Ask] ${text}`, { text });
      this.messages.push({ role: "assistant", text });
      return text;
    } catch (error) {
      this.conversation.recordInterruption?.(
        `The Ask turn was interrupted. No game changes were applied. ${String(error)}`,
      );
      throw error;
    }
  }

  private executeTool(
    ...args: Parameters<typeof executeAgentToolAsync>
  ): ReturnType<typeof executeAgentToolAsync> {
    this.task.assertActive();
    this.assertAdoptable();
    return executeAgentToolAsync(...args);
  }

  /** Register local context; opening or connecting the panel never calls the provider. */
  setOrientation(input: Pick<OrientationInput, "game" | "profile">): void {
    if (!this.oriented) this.orientation = input;
  }

  /**
   * The first request's scene brief, read under the task's own list. Ask
   * (`readOnly`) reads the room as its read_room calls do, so the
   * plan entry that tool withholds from the player's surface stays out of
   * the brief too.
   */
  private async orientationContext(
    room: number,
    allowedTools: readonly string[],
    readOnly = false,
  ): Promise<string> {
    if (!this.orientation || this.oriented) return "";
    const input = { ...this.orientation, room };
    // The compact scene brief reads through the same tools the model uses —
    // read_room, read_picture — so the brief and the
    // on-demand deep dive can never disagree about what the session holds.
    const [roomContext, picture] = [
      await this.executeTool(
        this.state,
        "read_room",
        { room, state: null, frames: null },
        { ...this.runtime, allowedTools, readOnly },
      ),
      await this.executeTool(this.state, "read_picture", { num: room }, { allowedTools, readOnly }),
    ];
    const objects =
      roomContext.success && Array.isArray(roomContext.details?.["liveObjects"])
        ? {
            success: true,
            details: { objects: roomContext.details["liveObjects"] as unknown[] },
          }
        : null;
    const prompt = createOrientationPrompt({
      ...input,
      sceneBrief: createSceneBrief(roomContext, picture, objects),
    });
    this.onEvent(
      "request",
      `[Orientation] ${input.game} room ${input.room} (profile ${input.profile})`,
      {
        prompt,
      },
    );
    this.oriented = true;
    this.orientation = undefined;
    return `${prompt}\n\n`;
  }

  /**
   * One remix turn: the player asked for a change while the world is
   * frozen. The agent inspects the live game with the runtime tools, patches
   * resources, and finishes with a text turn; every tool call streams into
   * the bubble through onEvent. Returns what to patch into the interpreter.
   * `beforeAdopt` is the host's commit gate, awaited once the turn's work is
   * done but before its staged candidate is adopted — a refusal discards the
   * turn exactly like a failed one: nothing reaches the session's resources.
   */
  runPowerUp(
    instruction: string,
    room: number,
    attachments?: TurnReferences,
    beforeAdopt?: () => Promise<void>,
  ): Promise<PowerUpResult> {
    if (this.task.snapshot().status === "idle") beginProviderTask(this.task.snapshot().allowance);
    return this.task.run(() => this.remix(instruction, room, attachments, beforeAdopt));
  }
  private async remix(
    instruction: string,
    room: number,
    attachments: TurnReferences | undefined,
    beforeAdopt: (() => Promise<void>) | undefined,
  ): Promise<PowerUpResult> {
    this.assertAdoptable();
    if (!this.conversation && !this.stubFallback)
      throw new Error("Connect an API key in AI settings before using Ask or Remix.");
    this.messages.push({ role: "user", text: instruction });
    this.onEvent("request", `[Remix] "${instruction}" (room ${room})`, { instruction, room });
    const orientation = await this.orientationContext(room, REMIX_TOOLS);
    if (this.stubFallback) {
      // The stub looks at the running game before it patches, exactly as the
      // model path does. That keeps the offline e2e a proof of the whole
      // perception chain: worker frame ring -> transfer -> composited PNG.
      const frames = await this.executeTool(
        this.state,
        "read_room",
        {
          room,
          state: null,
          frames: { count: 4, stride: 1, sheet: true, plane: null },
        },
        { ...this.runtime, allowedTools: REMIX_TOOLS },
      );
      this.onEvent(
        frames.success ? "response" : "error",
        `[Remix] read_room -> ${frames.success ? (frames.message ?? "").split("\n")[0] : frames.error}`,
        { images: frames.images?.map((i) => i.caption) },
      );
      this.task.assertActive();
      const result = await this.stubFallback.powerUp(instruction, room);
      // The commit gate runs before anything staged lands: a refusal leaves
      // the session's resources as the turn found them.
      await beforeAdopt?.();
      this.task.assertActive();
      this.assertAdoptable();
      this.messages.push({ role: "assistant", text: result.text });
      for (const resource of result.patched)
        this.state.container.putResource(resource.kind, resource.num, resource.payload);
      return result;
    }
    if (!this.conversation) throw new Error("No conversation provider configured");

    const art = await this.referenceTurn(attachments);
    const tools = withReferences(REMIX_TOOLS, art.references);
    this.conversation.setAvailableTools(tools);
    const watch = createReferenceWatch(art.references);
    const prompt = orientation + art.text + createPowerUpPrompt(instruction, room);

    const staged = forkAgentState(this.state);
    const forkRevision = worldRevision(this.state.authoring.world);
    try {
      let turn = await this.observeTurn(
        this.conversation.sendUserMessage(prompt, art.images),
        "remix",
      );

      // Nothing staged may reach the game on the provider's word alone. A
      // text turn closes the remix in one of two ways: no write succeeded,
      // or the host's own verdict — every stored game test and every
      // declared plan exit checked against this exact staged candidate —
      // passes. The genesis leg of finish is skipped here: the running
      // game already proves it boots, and imported games have no genesis
      // to re-litigate. A failing verdict goes back to the model for repair
      // until completion or a visible task pause. A text reply may be a
      // progress note while the staged candidate still needs repair.
      let stagedChanges = false;
      for (;;) {
        if (turn.toolCalls.length === 0) {
          if (!stagedChanges) break;
          const verdict = remixVerdict(staged);
          if (verdict === null) break;
          this.task.recordTool(
            "remix_verdict",
            {},
            { success: false, error: verdict },
            computeResourceRevision(Object.fromEntries(staged.getFiles())),
          );
          await this.task.checkpoint(false);
          turn = await this.observeTurn(
            this.conversation.sendUserMessage(
              `The staged changes cannot be committed: ${verdict} ` +
                "Repair them and call finish. If something blocks the repair, say what blocks it.",
            ),
            "remix",
          );
          continue;
        }
        let handedOver = false;
        const results: { toolCallId: string; result: AgentToolResult }[] = [];
        for (const tc of turn.toolCalls) {
          await this.task.checkpoint(false);
          this.onEvent("request", `[Remix] ${tc.name}`, { tool: tc.name, args: tc.input });
          this.task.assertActive();
          this.assertAdoptable();
          const toolStart = performance.now();
          const candidate = forkAgentState(staged);
          let res: AgentToolResult;
          if (handedOver) {
            // Terminal barrier: the call is recorded with an explicit
            // rejection — never silently dropped — but does not execute.
            res = {
              success: false,
              error:
                "Not executed: this turn ended at a successful finish. Ask for this change in the next Remix request.",
            };
          } else {
            res = watch.record(
              tc.name,
              tc.input,
              await this.executeTool(candidate, tc.name, tc.input, {
                ...this.runtime,
                allowedTools: tools,
                references: art.references,
              }),
            );
          }
          if (res.success) {
            Object.assign(staged, candidate);
            if (tc.name === "finish") handedOver = true;
            else if (
              res.details?.["writtenResources"] ||
              res.details?.["updatedFiles"] ||
              res.details?.["authoringChanged"]
            ) {
              stagedChanges = true;
              res = {
                ...res,
                message: `${res.message ?? "Change prepared."}\nStaged until this remix finishes; live state still describes the running game.`,
                details: { ...res.details, application: "staged" },
              };
            }
          }
          this.onEvent(
            res.success ? "response" : "error",
            `[Remix] ${tc.name} -> ${res.success ? (res.message ?? "ok").slice(0, 160) : res.error}`,
            { tool: tc.name, args: tc.input, result: { ...res, images: undefined } },
          );
          this.pendingToolMs += performance.now() - toolStart;
          this.task.recordTool(
            tc.name,
            tc.input,
            res,
            computeResourceRevision(Object.fromEntries(staged.getFiles())),
          );
          results.push({ toolCallId: tc.id, result: this.projectForModel(res) });
        }
        this.conversation.appendToolResults(results);
        // A passing finish is the host's own verdict: append the results,
        // commit below and resume without another provider request.
        if (handedOver) break;
        turn = await this.observeTurn(this.conversation.complete(), "remix");
      }

      // The host's commit gate: a refusal throws into the turn's failure
      // path, which discards the staged candidate untouched.
      await beforeAdopt?.();
      this.task.assertActive();
      this.assertAdoptable();
      const patched = changedResources(this.state, staged);
      const files: Partial<Record<"WORDS.TOK" | "OBJECT" | "TESTS.JSON", Uint8Array>> = {};
      for (const name of ["WORDS.TOK", "OBJECT", "TESTS.JSON"] as const) {
        const before = this.state.getFiles().get(name);
        const after = staged.getFiles().get(name);
        if (
          after &&
          (!before ||
            before.length !== after.length ||
            after.some((byte, index) => byte !== before[index]))
        )
          files[name] = after.slice();
      }
      if (adoptTurnState(this.state, staged, forkRevision))
        this.onEvent(
          "response",
          "[Remix] A map edit landed mid-remix; the turn's plan change was superseded.",
        );
      const text = turn.text || "Changes are ready.";
      this.noteUnviewed("Remix", watch.unviewed(text));
      this.messages.push({ role: "assistant", text });
      this.onEvent("response", `[Remix] ${text.slice(0, 300)}`, {
        text,
        patched: patched.map((p) => `${p.kind} ${p.num}`),
      });
      return { text, patched, files };
    } catch (error) {
      this.conversation.recordInterruption?.(
        `The remix turn did not finish. Its staged changes were discarded; the game resources remain as before this turn. ${String(error)}`,
      );
      throw error;
    }
  }

  /**
   * One Studio assist request: the creator's selection in Room Studio or
   * Sprite Studio and what they asked for it. The model reads the focus and
   * proposes candidates through the Studio tools only; nothing reaches the
   * game or this session's resources. The result's candidate is what the UI
   * previews and, on accept, applies as one undo step. The stub provider
   * runs the same loop with a scripted conversation.
   */
  runStudioAssist(request: StudioAssistRequest): Promise<StudioAssistResult> {
    if (this.task.snapshot().status === "idle") beginProviderTask(this.task.snapshot().allowance);
    return this.task.run(() => this.studioAssist(request));
  }
  private async studioAssist(request: StudioAssistRequest): Promise<StudioAssistResult> {
    this.assertAdoptable();
    const conversation =
      this.conversation ?? (this.stubFallback ? createStudioAssistStub(request.instruction) : null);
    if (!conversation)
      throw new Error("Connect an API key in AI settings before asking the Studio assistant.");
    const { instruction, focus } = request;
    const assist = createStudioAssist(
      focus,
      request.maxProposals === undefined ? {} : { maxProposals: request.maxProposals },
    );
    const label = `${focus.scope.kind} ${focus.scope.num}`;
    this.messages.push({ role: "user", text: instruction });
    this.onEvent("request", `[Studio] "${instruction}" (${label})`, { instruction, scope: label });
    const art = await this.referenceTurn({ referenceIds: request.referenceIds });
    const tools = withReferences(STUDIO_ASSIST_TASK_TOOLS, art.references);
    conversation.setAvailableTools(tools);
    const deps: AgentToolDeps = {
      allowedTools: tools,
      studio: assist,
      references: art.references,
    };
    const watch = createReferenceWatch(art.references);
    // Inspection reads a fork, as Ask does: nothing this turn runs may
    // reach the session's resources. It reads under the draft's profile,
    // the one Accept re-checks the candidate with.
    const inspected = forkAgentState(this.state);
    if (focus.profile) Object.assign(inspected, { profile: focus.profile });
    try {
      let turn = await this.observeTurn(
        conversation.sendUserMessage(
          art.text + createStudioAssistPrompt(instruction, focus),
          art.images,
        ),
        "studio",
      );
      while (turn.toolCalls.length) {
        const results: { toolCallId: string; result: AgentToolResult }[] = [];
        for (const call of turn.toolCalls) {
          await this.task.checkpoint(false);
          this.onEvent("request", `[Studio] ${call.name}`, { tool: call.name, args: call.input });
          this.task.assertActive();
          this.assertAdoptable();
          const toolStart = performance.now();
          const result = watch.record(
            call.name,
            call.input,
            await this.executeTool(inspected, call.name, call.input, deps),
          );
          this.pendingToolMs += performance.now() - toolStart;
          this.onEvent(
            result.success ? "response" : "error",
            `[Studio] ${call.name} -> ${result.success ? (result.message ?? "ok").split("\n")[0] : result.error}`,
            { tool: call.name, result: { ...result, images: undefined } },
          );
          this.task.recordTool(
            call.name,
            call.input,
            result,
            computeResourceRevision(Object.fromEntries(this.state.getFiles())),
          );
          results.push({ toolCallId: call.id, result: this.projectForModel(result) });
        }
        conversation.appendToolResults(results);
        turn = await this.observeTurn(conversation.complete(), "studio");
      }
      const text =
        turn.toolCalls.length === 0 && turn.text
          ? turn.text
          : (assist.candidate?.summary ?? "No change was proposed.");
      this.noteUnviewed("Studio", watch.unviewed(text));
      this.messages.push({ role: "assistant", text });
      this.onEvent("response", `[Studio] ${text.slice(0, 300)}`, {
        text,
        candidate: assist.candidate?.candidateId ?? null,
        proposals: assist.proposals,
        refusals: assist.refusals,
      });
      return {
        text,
        candidate: assist.candidate,
        proposals: assist.proposals,
        refusals: assist.refusals,
      };
    } catch (error) {
      conversation.recordInterruption?.(
        `The Studio assist request was interrupted. Nothing was applied. ${String(error)}`,
      );
      throw error;
    }
  }

  /**
   * The turn's reference art. The manifest rides the request when the player
   * attached art to it or the project's art changed since the last manifest
   * this session sent; otherwise the earlier manifest is still in the
   * conversation. `alsoAttached` marks art the task itself is about, such as
   * the room a room build writes.
   */
  private async referenceTurn(
    attachments: TurnReferences | undefined,
    alsoAttached?: (art: ReferenceArt) => boolean,
  ): Promise<ReferenceTurn> {
    const loaded = await this.runtime.referenceArt?.(attachments?.referenceIds ?? []);
    const references: ReferenceSource | undefined = loaded?.art.length
      ? {
          art: loaded.art.map((art) =>
            !art.attached && alsoAttached?.(art) ? { ...art, attached: true } : art,
          ),
        }
      : undefined;
    const images = [...(attachments?.legacyImages ?? [])];
    let text = "";
    if (references) {
      const key = references.art.map((art) => art.id).join(",");
      if (key !== this.manifestKey || references.art.some((art) => art.attached)) {
        const manifest = await referenceManifest(references);
        text = `${manifest.text}\n\n`;
        images.unshift(manifest.image);
        this.manifestKey = key;
      }
    }
    return { references, text, images: images.length ? images : undefined };
  }

  /** Log attached art a turn wrote from, or said it matched, without viewing it. */
  private noteUnviewed(phase: string, unviewed: readonly string[]): void {
    if (unviewed.length)
      this.onEvent(
        "error",
        `[${phase}] Reference art attached to the request was not viewed: ${unviewed.join(", ")}`,
        { unviewedReferences: unviewed },
      );
  }

  /**
   * The compact model-facing projection of a tool result. The full result is
   * kept in the session diagnostic store under a diagnosticId the projected
   * details point at; earlier transcript items are never rewritten.
   */
  private projectForModel(result: AgentToolResult): AgentToolResult {
    return projectToolResult(result, this.state.diagnostics, `d${++this.diagnosticSeq}`);
  }

  private async observeTurn(
    pending: Promise<LlmTurnResult>,
    phase: "ask" | "remix" | "genesis" | "room" | "studio",
  ): Promise<LlmTurnResult> {
    try {
      const turn = await pending;
      if (turn.usage)
        this.onEvent(
          "log",
          `[Usage] ${turn.usage.input} input, ${turn.usage.cachedInput} cached, ${turn.usage.output} output tokens`,
          { usage: turn.usage, totalUsage: this.conversation?.getUsage?.() },
        );
      if (turn.telemetry) {
        const toolMs = this.pendingToolMs;
        this.pendingToolMs = 0;
        const cache =
          turn.telemetry.cacheHitShare === undefined
            ? ""
            : ` · ${Math.round(turn.telemetry.cacheHitShare * 100)}% cached`;
        this.onEvent(
          "telemetry",
          `[Request] ${phase} #${turn.telemetry.requestIndex} ${turn.telemetry.usageIncomplete ? "(incomplete usage) " : ""}${turn.telemetry.responseMs.toFixed(0)}ms${cache}`,
          { phase, telemetry: turn.telemetry, toolMs },
        );
      }
      return turn;
    } catch (error) {
      this.onEvent("log", "[Usage] Provider turn interrupted", {
        telemetry: error instanceof LlmResponseError ? error.telemetry : undefined,
        totalUsage: this.conversation?.getUsage?.(),
      });
      if (
        error instanceof LlmResponseError &&
        /output limit/.test(error.message) &&
        this.conversation
      ) {
        this.task.pause("The response reached its output limit. Work is kept; continue to finish.");
        await this.task.checkpoint();
        return this.observeTurn(
          this.conversation.sendUserMessage(
            "Continue the current task from the successful tool results. The previous response was truncated; its partial tool calls were not executed. Inspect staged resources if needed and finish the remaining work.",
          ),
          phase,
        );
      }
      throw error;
    }
  }

  getBackgroundChats(): AgentChat[] {
    return structuredClone(this.backgroundChats);
  }

  getTranscript(): unknown[] {
    return this.conversation?.getTranscript() ?? structuredClone(this.retainedTranscript);
  }

  getProviderContext(): { provider: string; model: string } {
    return { provider: this.config.provider, model: this.config.model };
  }

  getAuthoringState(state: AgentSessionState = this.state): Record<string, unknown> {
    return structuredClone({
      chat: this.messages,
      authoring: state.authoring,
      sources: {
        logics: [...state.sources.logics],
        pictures: [...state.sources.pictures],
        views: [...state.sources.views],
        sounds: [...state.sources.sounds],
      },
    });
  }

  /**
   * The state a history checkpoint carries: authoring plan and sources —
   * everything getAuthoringState persists except the chat, which a Resume
   * here keeps as provenance rather than rewinding.
   */
  snapshotAuthoring(): Record<string, unknown> {
    const full = this.getAuthoringState();
    delete full["chat"];
    return full;
  }

  /** resourceSetHint of the session's file set — the worker's identity for the same bytes. */
  resourceSet(): string {
    return resourceSetHint(this.state);
  }

  /**
   * While a history adoption is in flight — or after its session leg
   * failed — the bytes the worker runs no longer match this session's
   * state, so no turn or map commit may start until adoptAuthoredData
   * installs state belonging to them.
   */
  private adoptionHold: string | null = null;
  private mutationHold: string | null = null;

  /** Reserve an idle session across a durable resource transaction. */
  reserveMutation(reason: string): () => void {
    this.assertAdoptable();
    if (this.task.snapshot().status !== "idle")
      throw new Error("Wait for the current agent turn before keeping an edit.");
    this.mutationHold = reason;
    return () => {
      this.mutationHold = null;
    };
  }

  /**
   * Validate a resource edit's candidate state — the edited files plus the
   * source (and bindings) `stage` records for them — without changing this session before
   * storage succeeds. `changed` is what `stage` reported: whether the
   * recorded source differs from the one this session holds.
   */
  prepareSourcePatch(
    files: Record<string, Uint8Array>,
    stage: (sources: AgentSourceStore, authoring: AuthoringState) => boolean,
  ): {
    authoringState: Record<string, unknown>;
    changed: boolean;
    adopt: () => void;
  } {
    const candidate = forkAgentState(this.state);
    const changed = stage(candidate.sources, candidate.authoring);
    const snapshot = this.getAuthoringState(candidate);
    const next = stateFromAuthoredData(
      files,
      [...candidate.sources.words],
      snapshot,
      this.profileOverride,
    );
    next.genesisComplete = this.state.genesisComplete;
    return {
      authoringState: snapshot,
      changed,
      adopt: () => {
        Object.assign(this.state, next);
      },
    };
  }

  /** Non-null while a history adoption owns this session's state. */
  get adoptionHeld(): string | null {
    return this.adoptionHold;
  }

  holdAdoption(reason: string): void {
    if (this.mutationHold !== null) throw new Error(this.mutationHold);
    this.adoptionHold = reason;
  }

  releaseAdoption(): void {
    this.adoptionHold = null;
  }

  private assertAdoptable(): void {
    if (this.mutationHold !== null) throw new Error(this.mutationHold);
    if (this.adoptionHold !== null) throw new Error(this.adoptionHold);
  }

  /**
   * Install the authoring state belonging to a history-adopted boot: the
   * container and dictionary come from the boot, the snapshot from the
   * tape's last checkpoint or the kept session's record. Without a
   * snapshot, the current state qualifies only when it already describes
   * exactly these bytes — otherwise the session rebuilds clean rather than
   * keep authoring a future it can no longer see. Conversation and chat
   * stay untouched: the abandoned future remains on the record.
   */
  adoptAuthoredData(
    files: Record<string, Uint8Array>,
    words: [string, number][],
    snapshot?: unknown,
    expectedRevision?: string,
  ): void {
    if (this.mutationHold !== null) throw new Error(this.mutationHold);
    const adoptedRevision = resourceSetHint({
      getFiles: () => new Map(Object.entries(files)),
    });
    if (expectedRevision !== undefined && adoptedRevision !== expectedRevision)
      throw new Error(
        `the adopted bytes do not match the revision the worker adopted (${adoptedRevision} ≠ ${expectedRevision})`,
      );
    const authoringState =
      snapshot !== undefined
        ? validateAuthoringSnapshot(snapshot)
        : this.resourceSet() === adoptedRevision
          ? this.snapshotAuthoring()
          : undefined;
    const next = stateFromAuthoredData(files, words, authoringState, this.profileOverride);
    next.genesisComplete = this.state.genesisComplete;
    Object.assign(this.state, next);
    // The adoption hold is the caller's to release once the whole
    // transaction — session, booted game, durable record — has landed;
    // a throw above leaves it set.
  }

  getSessionId(): string | undefined {
    return this.conversation?.getSessionId?.() ?? this.retainedSessionId;
  }

  getMessages(): AgentChatMessage[] {
    return this.messages.map((message) => ({ ...message }));
  }

  /** True for the deterministic stub or a provider client with a current key. */
  isConfigured(): boolean {
    return this.stubFallback !== null || this.conversation !== null;
  }

  /**
   * Replace provider credentials at an idle boundary without replacing the
   * authored game state. Protocol-specific transcripts are replayed only to
   * the exact provider/model that produced them.
   */
  reconfigure(config: LlmConfig): AgentSession {
    if (this.mutationHold !== null) throw new Error(this.mutationHold);
    if (this.task.snapshot().status !== "idle")
      throw new Error("Wait for the current agent task to finish before changing AI settings.");
    const context = this.getProviderContext();
    const sameProtocol = context.provider === config.provider && context.model === config.model;
    const transcript = continuationTranscript(
      { ...context, transcript: this.getTranscript() },
      config.provider,
      config.model,
    );
    const replacement = new AgentSession(
      config,
      this.onEvent,
      this.state,
      transcript,
      sameProtocol ? this.getSessionId() : undefined,
    );
    replacement.messages = this.getMessages();
    replacement.backgroundChats = this.getBackgroundChats();
    replacement.runtime = this.runtime;
    // A mid-swap credential change must not unlock authoring against bytes
    // the session has not adopted — the hold belongs to the shared state.
    replacement.adoptionHold = this.adoptionHold;
    replacement.oriented = this.oriented;
    replacement.orientation = this.orientation ? { ...this.orientation } : undefined;
    replacement.profileOverride = this.profileOverride;
    return replacement;
  }

  /**
   * Reconstitute an active AgentSession from previously authored game files
   * (bypassing Genesis, ready for room preparation and explicit live patches).
   * `profile` is the game's interpreter override, so tools compile and
   * validate for the interpreter the game actually boots under.
   */
  static fromAuthoredData(
    config: LlmConfig,
    onEvent: AgentEventSink,
    files: Record<string, Uint8Array>,
    words: [string, number][],
    transcript?: unknown[],
    sessionId?: string,
    authoringState?: Record<string, unknown>,
    profile?: ProfileId,
  ): AgentSession {
    const state = stateFromAuthoredData(files, words, authoringState, profile);
    state.genesisComplete = true;
    const session = new AgentSession(config, onEvent, state, transcript, sessionId);
    session.profileOverride = profile;
    const chat = authoringState?.["chat"];
    if (Array.isArray(chat)) {
      session.messages = chat
        .filter(
          (message): message is AgentChatMessage =>
            message &&
            (message.role === "user" || message.role === "assistant") &&
            typeof message.text === "string",
        )
        .map(({ role, text }) => ({ role, text }));
    }
    return session;
  }

  /**
   * Genesis is one turn: the agent records the world through update_plan —
   * the map shows the plan as it lands — and builds the opening room in the
   * same run. There is no separate plan approval: the map stays editable
   * afterwards and later rooms build when entered or from Build this room.
   */
  startGenesis(templateMarkdown: string): Promise<BootResources> {
    if (this.task.snapshot().status === "idle") beginProviderTask(this.task.snapshot().allowance);
    return this.task.run(() => this.buildTurn(templateMarkdown));
  }

  /**
   * Commit a player draft against the current world revision; a "conflict"
   * means the world moved since the draft forked — the caller offers a
   * refresh rather than overwriting. A running turn refuses instead: its
   * staged fork adopts back wholesale at completion, so a map edit
   * committed mid-turn would be silently overwritten.
   */
  commitPlanDraft(draft: WorldDraft): WorldCommit {
    if (this.mutationHold !== null) return { status: "invalid", error: this.mutationHold };
    if (this.adoptionHold !== null) return { status: "invalid", error: this.adoptionHold };
    if (this.task.snapshot().status !== "idle") return { status: "busy" };
    const result = commitWorldDraft(this.state.authoring, draft);
    if (result.status === "committed") this.state.authoring = result.authoring;
    return result;
  }

  /** Adopt a plan wholesale — a stored draft restoring into a fresh session. */
  adoptWorldPlan(world: WorldPlan): void {
    this.assertAdoptable();
    if (this.task.snapshot().status !== "idle")
      throw new Error("The agent is mid-turn — the plan can be adopted when it finishes.");
    const result = commitWorld(this.state.authoring, world);
    if (result.status !== "committed")
      throw new Error(result.status === "invalid" ? result.error : "Plan conflict");
    this.state.authoring = result.authoring;
  }

  private async buildTurn(templateMarkdown: string): Promise<BootResources> {
    this.task.assertActive();
    this.assertAdoptable();
    if (!this.conversation && !this.stubFallback)
      throw new Error("Connect an API key in AI settings before creating a game.");
    // Install the complete deterministic Boilerplate before the first model
    // turn — the same playable snapshot manual Create produces without a
    // provider. Admission is explicit: a blank session and the untouched
    // seed are seeded; a session holding completed, imported or divergent
    // authored work is refused rather than silently reseeded.
    const seed = installBoilerplateSeed(this.state);
    // Genesis carries no reference art yet, so read_reference_image stays off its list.
    const genesisTools = withReferences(GENESIS_TOOLS, undefined);
    this.conversation?.setAvailableTools(genesisTools);
    if (this.stubFallback) {
      this.onEvent("request", "Starting Genesis using offline StubAgent");
      this.task.assertActive();
      // The stub records its world plan through the same update_plan tool —
      // the map's planned nodes land in the same turn the room does.
      this.stubFallback.plan(this.state);
      const resources = this.stubFallback.initialResources();
      for (const res of resources) {
        this.state.container.putResource(res.kind, res.num, res.payload);
        // Stub-authored bytes carry no recorded source: the seed's claim
        // over a number the stub replaced would read as a false source.
        if (res.kind === "logic") this.state.sources.logics.delete(res.num);
        else if (res.kind === "picture") this.state.sources.pictures.delete(res.num);
        else if (res.kind === "view") this.state.sources.views.delete(res.num);
        else this.state.sources.sounds.delete(res.num);
      }
      this.state.genesisComplete = true;
      const stubWords: [string, number][] = [...GAME_DICTIONARY];
      // The stub rebuilds WORDS.TOK from its own dictionary; the claims
      // must describe the file it wrote, not the seeded vocabulary.
      this.state.sources.words.clear();
      for (const [w, id] of stubWords) {
        this.state.sources.words.set(w, id);
      }
      this.state.wordsPayload = buildWordsTok(stubWords.map(([word, id]) => ({ word, id })));
      const files: Record<string, Uint8Array> = Object.fromEntries(this.state.getFiles());
      return { files, words: stubWords };
    }

    if (!this.conversation) throw new Error("No conversation provider configured");

    this.onEvent(
      "request",
      `Beginning Genesis authoring with ${this.config.provider} (${this.config.model})`,
    );

    const genesisPrompt = createGenesisPrompt(templateMarkdown, seed);
    let turn = await this.observeTurn(this.conversation.sendUserMessage(genesisPrompt), "genesis");

    while (!this.state.genesisComplete) {
      await this.task.checkpoint(false);
      if (turn.toolCalls.length > 0) {
        const results: { toolCallId: string; result: ReturnType<typeof executeAgentTool> }[] = [];
        for (const tc of turn.toolCalls) {
          await this.task.checkpoint(false);
          this.onEvent("request", `[Genesis] ${tc.name}`, { tool: tc.name, args: tc.input });
          this.task.assertActive();
          this.assertAdoptable();
          const toolStart = performance.now();
          // Terminal barrier: a successful finish ends the batch; later
          // calls get an explicit rejection result, never a silent drop.
          const res = this.state.genesisComplete
            ? {
                success: false,
                error:
                  "Not executed: this turn ended at a successful finish. Use an Ask or Remix request for further changes.",
              }
            : await this.executeTool(this.state, tc.name, tc.input, {
                allowedTools: genesisTools,
              });
          this.pendingToolMs += performance.now() - toolStart;
          this.onEvent(
            res.success ? "response" : "error",
            res.success
              ? `[Genesis] ${tc.name} succeeded`
              : `[Genesis] ${tc.name} failed: ${res.error}`,
            { tool: tc.name, args: tc.input, result: { ...res, images: undefined } },
          );
          this.task.recordTool(
            tc.name,
            tc.input,
            res,
            computeResourceRevision(Object.fromEntries(this.state.getFiles())),
          );
          results.push({ toolCallId: tc.id, result: this.projectForModel(res) });
        }
        this.conversation.appendToolResults(results);
        if (this.state.genesisComplete) break;
        turn = await this.observeTurn(this.conversation.complete(), "genesis");
      } else {
        this.task.recordTool(
          "unfinished_reply",
          {},
          { success: false, message: turn.text ?? "" },
          computeResourceRevision(Object.fromEntries(this.state.getFiles())),
        );
        // Model answered with text instead of tools, remind it to complete genesis
        this.onEvent("response", `[Genesis text] ${(turn.text ?? "").slice(0, 150)}`, {
          text: turn.text,
        });
        turn = await this.observeTurn(
          this.conversation.sendUserMessage(
            "Genesis is not finished: record the world plan with update_plan, adapt the seeded opening room to the brief with your write_* tools, then call finish.",
          ),
          "genesis",
        );
      }
    }

    this.onEvent("response", "Genesis authoring complete! Assembling boot files.");

    const files = Object.fromEntries(this.state.getFiles());
    const words = [...this.state.sources.words.entries()];
    const transcript = this.conversation.getTranscript();
    const sessionId = this.conversation.getSessionId?.();
    return { files, words, transcript, sessionId };
  }

  handle(
    req: LlmRequest,
    beforeAdopt?: () => Promise<void>,
    attachments?: TurnReferences,
  ): Promise<string> {
    return this.task.run(async () => {
      const previous = this.conversation;
      const previousMessages = this.messages;
      this.messages = [];
      if (this.config.provider === "openai" && this.config.apiKey.trim())
        this.conversation = createOpenAiConversation(this.config, [], undefined, this.task);
      else if (this.config.provider === "anthropic" && this.config.apiKey.trim())
        this.conversation = createAnthropicConversation(this.config, [], this.task);
      try {
        return await this.prepareRoom(req, beforeAdopt, attachments);
      } finally {
        const id = `room-task-${Date.now()}-${this.backgroundChats.length}`;
        this.backgroundChats.push({
          id,
          title: `Built room ${Number(req.context["room"])}`,
          ...this.getProviderContext(),
          transcript: this.conversation?.getTranscript() ?? [
            { role: "user", text: `Build room ${Number(req.context["room"])}` },
            ...this.messages,
          ],
          messages: this.messages.map((message, index) => ({ ...message, id: `${id}-${index}` })),
          background: true,
        });
        this.conversation = previous;
        this.messages = previousMessages;
      }
    });
  }
  private async prepareRoom(
    req: LlmRequest,
    beforeAdopt?: () => Promise<void>,
    attachments?: TurnReferences,
  ): Promise<string> {
    this.task.assertActive();
    this.assertAdoptable();
    if (!this.conversation && !this.stubFallback)
      throw new Error("Connect an API key in AI settings before creating the next room.");
    if (this.stubFallback) {
      const response = await this.stubFallback.handle(req);
      if (req.op === "room" && response) {
        // Same commit gate as a remix turn: refuse before the staged room
        // lands in the session's container.
        await beforeAdopt?.();
        this.task.assertActive();
        this.assertAdoptable();
        const patch = prepareRoomPatch(
          openContainer(this.state.getFiles(), { profile: this.state.profile }),
          Number(req.context["room"]),
          response,
          this.state.sources.words,
          this.state.profile,
        );
        for (const resource of patch.resources)
          this.state.container.putResource(resource.kind, resource.num, resource.payload);
      }
      return response;
    }
    if (req.op !== "room") return "";
    if (!this.conversation) throw new Error("No conversation provider configured");
    const room = Number(req.context["room"]);
    const from = Number(req.context["from"]);
    if (!Number.isInteger(room) || room < 1 || room > 255) throw new Error("Invalid room number");

    // Tools work against a detached container. A failed turn cannot leave
    // half a room in the session that the next attempt mistakes for success.
    let staged = forkAgentState(this.state);
    const forkRevision = worldRevision(this.state.authoring.world);
    staged.genesisComplete = true;
    staged.sources.objects = readInventoryObjects(staged.getFiles().get("OBJECT"), staged.profile);
    // Art aimed at the room being written counts as attached to the request.
    const art = await this.referenceTurn(
      attachments,
      (candidate) => candidate.target.kind === "room" && candidate.target.num === room,
    );
    const tools = withReferences(ROOM_AUTHORING_TOOLS, art.references);
    this.conversation.setAvailableTools(tools);
    const watch = createReferenceWatch(art.references);
    const snapshot: AgentToolDeps = {
      allowedTools: tools,
      references: art.references,
      engine: {
        state: () => req.context["state"] ?? null,
        objects: () => req.context["objects"] ?? [],
      },
      // The host's pinned map notes stay reachable when the turn inspects a
      // room other than the one the request names.
      roomNotes: this.runtime.roomNotes,
    };
    this.onEvent("request", `[Runtime room] authoring room ${room} from room ${from}`);
    const resources = await this.executeTool(
      staged,
      "read_plan",
      { filter: "slots", section: null, name: null, offset: null, kind: null },
      snapshot,
    );
    const previous = await this.executeTool(staged, "read_logic", { num: from }, snapshot);
    // Player intent pinned on the map for this room — provenance the host
    // attached to the request; every supplied string travels in the prompt.
    const rawNotes = req.context["playerNotes"];
    const playerNotes = Array.isArray(rawNotes)
      ? rawNotes.filter((note): note is string => typeof note === "string")
      : undefined;
    // A map-built extension names the planned exit it is realizing: the turn
    // must leave that route implemented in the source room's logic.
    const rawExit = req.context["plannedExit"];
    const plannedExit =
      typeof rawExit === "string" && rawExit.length > 0 && rawExit.length <= 40
        ? rawExit
        : undefined;
    try {
      let turn = await this.observeTurn(
        this.conversation.sendUserMessage(
          art.text +
            createRuntimeRoomPrompt(room, from, playerNotes, plannedExit) +
            (typeof req.context["gameNotes"] === "string"
              ? `\nGame notes:\n${req.context["gameNotes"]}`
              : "") +
            `\nResources: ${resources.message ?? ""}\nInventory (preserve this order): ${JSON.stringify(staged.sources.objects)}\nPrevious room logic:\n${previous.message ?? ""}`,
          art.images,
        ),
        "room",
      );
      let completed = false;
      for (;;) {
        if (turn.toolCalls.length === 0) {
          // Only a passing finish — the host's own validation of the exact
          // staged candidate — completes the room; a text reply commits
          // nothing, whether or not the resources merely exist.
          const missing =
            !staged.container.getResource("logic", room) ||
            !staged.container.getResource("picture", room);
          this.task.recordTool(
            "unfinished_reply",
            {},
            { success: false, message: turn.text ?? "" },
            computeResourceRevision(Object.fromEntries(staged.getFiles())),
          );
          turn = await this.observeTurn(
            this.conversation.sendUserMessage(
              missing
                ? `Room ${room} still needs both logic and picture. Author the missing resources.`
                : `Room ${room} is authored but not handed over. Call finish to validate and commit it; a text reply alone commits nothing.`,
            ),
            "room",
          );
          continue;
        }
        const results: { toolCallId: string; result: AgentToolResult }[] = [];
        for (const tc of turn.toolCalls) {
          await this.task.checkpoint(false);
          this.onEvent("request", `[Room tool] ${tc.name}`, { tool: tc.name, args: tc.input });
          this.task.assertActive();
          this.assertAdoptable();
          const toolStart = performance.now();
          const candidate = forkAgentState(staged);
          let result: AgentToolResult;
          try {
            if (completed) {
              result = {
                success: false,
                error:
                  "Not executed: this turn ended at a successful finish. The room is already committed.",
              };
            } else if (tc.name === "finish") {
              if (
                staged.container.getResource("logic", room) &&
                staged.container.getResource("picture", room)
              ) {
                // The room's structural gate first, then the shared host
                // validation (stored game tests) against the staged candidate.
                result = await this.executeTool(candidate, "finish", tc.input, snapshot);
                if (result.success) {
                  staged = candidate;
                  completed = true;
                }
              } else {
                result = {
                  success: false,
                  error: `Cannot hand over: room ${room} still needs both logic and picture. Author the missing resources before finishing.`,
                };
              }
            } else {
              result = watch.record(
                tc.name,
                tc.input,
                await this.executeTool(candidate, tc.name, tc.input, snapshot),
              );
              if (result.success) {
                validateRoomCandidate(this.state, staged, candidate);
                staged = candidate;
                if (
                  result.details?.["writtenResources"] ||
                  result.details?.["updatedFiles"] ||
                  result.details?.["authoringChanged"]
                )
                  result = {
                    ...result,
                    message: `${result.message ?? "Change prepared."}\nStaged for the new room; live state is the frozen departure snapshot.`,
                    details: { ...result.details, application: "staged" },
                  };
              }
            }
          } catch (error) {
            result = { success: false, error: String(error) };
          }
          this.onEvent(
            result.success ? "response" : "error",
            `[Room tool] ${tc.name} -> ${result.success ? "ok" : result.error}`,
            { tool: tc.name, result: { ...result, images: undefined } },
          );
          this.pendingToolMs += performance.now() - toolStart;
          this.task.recordTool(
            tc.name,
            tc.input,
            result,
            computeResourceRevision(Object.fromEntries(staged.getFiles())),
          );
          results.push({ toolCallId: tc.id, result: this.projectForModel(result) });
        }
        this.conversation.appendToolResults(results);
        if (completed) break;
        turn = await this.observeTurn(this.conversation.complete(), "room");
      }
      if (!completed) throw new Error(`Room ${room} authoring did not finish.`);
      this.noteUnviewed("Room", watch.unviewed(turn.text ?? ""));

      // The host's commit gate: a refusal discards the staged room through
      // the turn's failure path.
      await beforeAdopt?.();
      this.task.assertActive();
      this.assertAdoptable();
      const changed = changedResources(this.state, staged).map(({ kind, num, payload }) => ({
        kind,
        num,
        data: Array.from(payload),
      }));
      const response = JSON.stringify({
        room,
        resources: changed,
        words: [...staged.sources.words],
        ...(staged.objectPayload ? { objects: Array.from(staged.objectPayload) } : {}),
        ...(staged.testsPayload ? { tests: Array.from(staged.testsPayload) } : {}),
      });
      prepareRoomPatch(
        openContainer(this.state.getFiles(), { profile: this.state.profile }),
        room,
        response,
        this.state.sources.words,
        this.state.profile,
      );
      if (adoptTurnState(this.state, staged, forkRevision))
        this.onEvent(
          "response",
          `[Room] A map edit landed mid-build; the turn's plan change was superseded.`,
        );
      this.onEvent("response", `Authored room ${room}: logic, picture and dependencies ready`);
      return response;
    } catch (error) {
      this.conversation.recordInterruption?.(
        `Room ${room} generation did not finish. All staged room changes were discarded. ${String(error)}`,
      );
      throw error;
    }
  }
}

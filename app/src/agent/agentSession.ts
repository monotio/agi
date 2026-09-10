import { AgentRun } from "./agentRun.ts";
/**
 * Agent Session: Manages the ever-growing, append-only frontier LLM session
 * starting from Genesis (the adventure template) and continuing through runtime turns
 * (room preparation and explicit live patches), preserving the cached prefix.
 */

import {
  AGENT_TOOLS,
  ASK_TOOLS,
  buildSound,
  type SoundTrackInput,
  createAgentSessionState,
  executeAgentTool,
  executeAgentToolAsync,
  type AgentRuntimeDeps,
  type AgentSessionState,
  type AgentToolResult,
} from "../../../src/agent/tools.ts";
import { buildView, type BuildViewInput } from "../../../src/view/view.ts";
import { validateAuthoringState } from "../../../src/agent/authoringState.ts";
import { forkAgentState, changedResources, validateRoomCandidate } from "./sessionState.ts";
import { readInventoryObjects } from "../../../src/agent/inventory.ts";
import { prepareRoomPatch } from "../../../src/agent/roomPatch.ts";
import { buildWordsTok } from "../../../src/logic/words.ts";
import { openContainer } from "../../../src/container/container.ts";
import {
  createGenesisPrompt,
  createOrientationPrompt,
  createRuntimeRoomPrompt,
  type OrientationInput,
} from "../../../src/agent/prompt.ts";
import {
  createAnthropicConversation,
  LlmResponseError,
  createOpenAiConversation,
  type LlmConfig,
  type UnifiedConversation,
  type LlmTurnResult,
} from "./llmClient.ts";
import { StubAgent } from "./stubAgent.ts";
import type { AgentEventSink, AgentHandler, LlmRequest } from "./sabBridge.ts";
import { continuationTranscript } from "../projectArchive.ts";

/** Resource the remix turn wrote and the host must patch into the live game. */
export interface PatchedResource {
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

/** Tools active during Genesis and Room Authoring. Stable across both phases for prompt cache reuse. */
const AUTHORING_SESSION_TOOLS = AGENT_TOOLS.filter((tool) => tool.name !== "read_frames").map(
  (tool) => tool.name,
);

export interface BootResources {
  files: Record<string, Uint8Array>;
  words: [string, number][];
  transcript?: unknown[] | undefined;
  sessionId?: string | undefined;
}

export interface AgentChatMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * The remix user turn. A tail appended to the transcript, never an edit of
 * the cached system prefix.
 */
export function createPowerUpPrompt(instruction: string, room: number): string {
  return `### LIVE PATCH REQUEST

The world is frozen at a cycle boundary in room ${room}, and the player has asked for a change:

"${instruction.trim()}"

Look before you write: read_state and read_objects tell you where the player is and what is on screen, read_frames shows you the screen itself, and read_logic / read_picture / list_resources give you the resources as source. Then patch the smallest thing that achieves what was asked, in the room the player is standing in unless they said otherwise. When you are done, reply with one short sentence telling the player what changed — that sentence closes the bubble and the game resumes.`;
}

export class AgentSession implements AgentHandler {
  readonly task: AgentRun;
  private messages: AgentChatMessage[] = [];
  readonly state: AgentSessionState;
  private readonly config: LlmConfig;
  private readonly onEvent: AgentEventSink;
  private readonly conversation: UnifiedConversation | null;
  private readonly stubFallback: StubAgent | null;
  /** Conversation data retained while a non-stub provider has no connected key. */
  private readonly retainedTranscript: unknown[];
  private readonly retainedSessionId: string | undefined;
  /** Live-game sources for read_frames / read_objects / read_state. */
  private runtime: AgentRuntimeDeps = {};
  /** Context is attached to the first submitted request, never sent on panel open. */
  private oriented = false;
  private orientation: Pick<OrientationInput, "game" | "profile"> | undefined;

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

  runAsk(question: string, room: number): Promise<string> {
    return this.task.run(() => this.ask(question, room));
  }
  private async ask(question: string, room: number): Promise<string> {
    if (!this.conversation && !this.stubFallback)
      throw new Error("Connect an API key in AI settings before using Ask or Remix.");
    this.messages.push({ role: "user", text: question });
    this.onEvent("request", `[Ask] ${question}`, { instruction: question, room });
    const context = this.orientationContext(room);
    if (!this.conversation) {
      const result = await executeAgentToolAsync(
        this.state,
        "read_state",
        { compact: true },
        { ...this.runtime, readOnly: true },
      );
      const text = result.success
        ? `You are in room ${room}. This test provider can inspect the game; connect a model for hints and debugging.`
        : result.error!;
      this.onEvent("response", `[Ask] ${text}`, { text });
      this.messages.push({ role: "assistant", text });
      return text;
    }
    this.conversation.setTools([...ASK_TOOLS]);
    const inspected = forkAgentState(this.state);
    try {
      let turn = await this.observeTurn(
        this.conversation.sendUserMessage(`${context}### ASK REQUEST
The game is paused in room ${room}. This turn is a read-only conversation, not a request to edit.
${question.trim()}

Answer the player's question using evidence from inspection when needed. For hints, avoid spoilers beyond what was requested. Distinguish game logic from suspected engine faults and explain what you observed and what remains uncertain. playtest_room starts from boot, not the live checkpoint. Do not claim to have replayed earlier events or inspected a call stack unless a tool actually supplies it. If a content fix would help, describe it for the player to apply in Remix. Engine implementation changes belong in the development workflow. Keep the reply concise and useful; this conversation stays open.`),
      );
      while (turn.toolCalls.length) {
        const results: { toolCallId: string; result: AgentToolResult }[] = [];
        for (const call of turn.toolCalls) {
          await this.task.checkpoint(false);
          this.onEvent("request", `[Ask] ${call.name}`, { tool: call.name });
          const result = await executeAgentToolAsync(inspected, call.name, call.input, {
            ...this.runtime,
            readOnly: true,
          });
          this.onEvent(
            result.success ? "response" : "error",
            `[Ask] ${call.name} → ${result.success ? (result.message ?? "Done") : result.error}`,
            { tool: call.name, result: { ...result, images: undefined } },
          );
          this.task.recordTool(call.name, call.input, result);
          results.push({ toolCallId: call.id, result });
        }
        turn = await this.observeTurn(this.conversation.sendToolResults(results));
      }
      const text = turn.text || "What would you like to explore next?";
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

  /** Register local context; opening or connecting the panel never calls the provider. */
  setOrientation(input: Pick<OrientationInput, "game" | "profile">): void {
    if (!this.oriented) this.orientation = input;
  }

  private orientationContext(room: number): string {
    if (!this.orientation || this.oriented) return "";
    const input = { ...this.orientation, room };
    const text = (result: AgentToolResult, fallback: string): string =>
      result.success ? (result.message ?? fallback) : `(${result.error ?? fallback})`;
    const prompt = createOrientationPrompt({
      ...input,
      resourceListing: text(
        executeAgentTool(this.state, "list_resources", { kind: null }),
        "no listing",
      ),
      logicSource: text(
        executeAgentTool(this.state, "read_logic", { num: input.room }),
        "no logic",
      ),
      pictureSource: text(
        executeAgentTool(this.state, "read_picture", { num: input.room }),
        "no picture",
      ),
      wordsSummary: text(
        executeAgentTool(this.state, "read_words", { prefix: null }),
        "no dictionary",
      ),
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
   */
  runPowerUp(instruction: string, room: number): Promise<PowerUpResult> {
    return this.task.run(() => this.remix(instruction, room));
  }
  private async remix(instruction: string, room: number): Promise<PowerUpResult> {
    if (!this.conversation && !this.stubFallback)
      throw new Error("Connect an API key in AI settings before using Ask or Remix.");
    this.messages.push({ role: "user", text: instruction });
    this.onEvent("request", `[Remix] "${instruction}" (room ${room})`, { instruction, room });
    const prompt = this.orientationContext(room) + createPowerUpPrompt(instruction, room);
    if (this.stubFallback) {
      // The stub looks at the running game before it patches, exactly as the
      // model path does. That keeps the offline e2e a proof of the whole
      // perception chain: worker frame ring -> transfer -> composited PNG.
      const frames = await executeAgentToolAsync(
        this.state,
        "read_frames",
        { count: 4, stride: 1, sheet: true, plane: null },
        this.runtime,
      );
      this.onEvent(
        frames.success ? "response" : "error",
        `[Remix] read_frames -> ${frames.success ? (frames.message ?? "").split("\n")[0] : frames.error}`,
        { images: frames.images?.map((i) => i.caption) },
      );
      const result = await this.stubFallback.powerUp(instruction, room);
      this.messages.push({ role: "assistant", text: result.text });
      for (const resource of result.patched)
        this.state.container.putResource(resource.kind, resource.num, resource.payload);
      return result;
    }
    if (!this.conversation) throw new Error("No conversation provider configured");

    this.conversation.setTools();

    const staged = forkAgentState(this.state);
    try {
      let turn = await this.observeTurn(this.conversation.sendUserMessage(prompt));

      while (turn.toolCalls.length > 0) {
        let remixDone = false;
        const results: { toolCallId: string; result: AgentToolResult }[] = [];
        for (const tc of turn.toolCalls) {
          await this.task.checkpoint(false);
          this.onEvent("request", `[Remix] ${tc.name}`, { tool: tc.name, args: tc.input });
          const candidate = forkAgentState(staged);
          let res: AgentToolResult;
          if (tc.name === "finish_genesis" || tc.name === "handover") {
            remixDone = true;
            res = {
              success: true,
              message: "Remix complete. Handing over to resume gameplay.",
              details: { genesisComplete: true, remixComplete: true },
            };
          } else {
            res = await executeAgentToolAsync(candidate, tc.name, tc.input, this.runtime);
          }
          if (res.success && tc.name !== "finish_genesis" && tc.name !== "handover") {
            Object.assign(staged, candidate);
            if (
              res.details?.["writtenResources"] ||
              res.details?.["updatedFiles"] ||
              res.details?.["authoringChanged"]
            )
              res = {
                ...res,
                message: `${res.message ?? "Change prepared."}\nStaged until this remix finishes; live state still describes the running game.`,
                details: { ...res.details, application: "staged" },
              };
          }
          this.onEvent(
            res.success ? "response" : "error",
            `[Remix] ${tc.name} -> ${res.success ? (res.message ?? "ok").slice(0, 160) : res.error}`,
            { tool: tc.name, args: tc.input, result: { ...res, images: undefined } },
          );
          this.task.recordTool(tc.name, tc.input, res);
          results.push({ toolCallId: tc.id, result: res });
        }
        turn = await this.observeTurn(this.conversation.sendToolResults(results));
        if (remixDone) break;
      }

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
      Object.assign(this.state, staged);
      const text = turn.text || "Changes are ready.";
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

  private async observeTurn(pending: Promise<LlmTurnResult>): Promise<LlmTurnResult> {
    try {
      const turn = await pending;
      if (turn.usage)
        this.onEvent(
          "log",
          `[Usage] ${turn.usage.input} input, ${turn.usage.cachedInput} cached, ${turn.usage.output} output tokens`,
          { usage: turn.usage, totalUsage: this.conversation?.getUsage?.() },
        );
      return turn;
    } catch (error) {
      this.onEvent("log", "[Usage] Provider turn interrupted", {
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
        );
      }
      throw error;
    }
  }

  getTranscript(): unknown[] {
    return this.conversation?.getTranscript() ?? structuredClone(this.retainedTranscript);
  }

  getProviderContext(): { provider: string; model: string } {
    return { provider: this.config.provider, model: this.config.model };
  }

  getAuthoringState(): Record<string, unknown> {
    return structuredClone({
      chat: this.messages,
      authoring: this.state.authoring,
      sources: {
        logics: [...this.state.sources.logics],
        pictures: [...this.state.sources.pictures],
        views: [...this.state.sources.views],
        sounds: [...this.state.sources.sounds],
      },
    });
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
    replacement.runtime = this.runtime;
    replacement.oriented = this.oriented;
    replacement.orientation = this.orientation ? { ...this.orientation } : undefined;
    return replacement;
  }

  /**
   * Reconstitute an active AgentSession from previously authored game files
   * (bypassing Genesis, ready for room preparation and explicit live patches).
   */
  static fromAuthoredData(
    config: LlmConfig,
    onEvent: AgentEventSink,
    files: Record<string, Uint8Array>,
    words: [string, number][],
    transcript?: unknown[],
    sessionId?: string,
    authoringState?: Record<string, unknown>,
  ): AgentSession {
    const fileMap = new Map(Object.entries(files));
    const container = openContainer(fileMap);
    const state = createAgentSessionState(container);
    state.wordsPayload = files["WORDS.TOK"];
    state.objectPayload = files["OBJECT"];
    state.testsPayload = files["TESTS.JSON"];
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
              buildSound(entry[1] as SoundTrackInput[]);
              state.sources.sounds.set(entry[0], entry[1] as SoundTrackInput[]);
            }
          }
        }
      }
    }
    state.genesisComplete = true;
    const session = new AgentSession(config, onEvent, state, transcript, sessionId);
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
   * Author the Genesis world (words, view 0, picture 1, logic 0, logic 1)
   * by feeding the raw template markdown into the agent loop.
   */
  startGenesis(templateMarkdown: string): Promise<BootResources> {
    return this.task.run(() => this.genesis(templateMarkdown));
  }
  private async genesis(templateMarkdown: string): Promise<BootResources> {
    if (!this.conversation && !this.stubFallback)
      throw new Error("Connect an API key in AI settings before creating a game.");
    this.conversation?.setTools(AUTHORING_SESSION_TOOLS);
    if (this.stubFallback) {
      this.onEvent("request", "Starting Genesis using offline StubAgent");
      const resources = this.stubFallback.initialResources();
      for (const res of resources) {
        this.state.container.putResource(res.kind, res.num, res.payload);
      }
      this.state.genesisComplete = true;
      // Standard stub dictionary
      const stubWords: [string, number][] = [
        ["look", 100],
        ["east", 101],
        ["west", 102],
        ["north", 103],
        ["south", 104],
        ["take", 105],
        ["open", 106],
      ];
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

    const genesisPrompt = createGenesisPrompt(templateMarkdown);
    let turn = await this.observeTurn(this.conversation.sendUserMessage(genesisPrompt));

    while (!this.state.genesisComplete) {
      await this.task.checkpoint(false);
      if (turn.toolCalls.length > 0) {
        const results: { toolCallId: string; result: ReturnType<typeof executeAgentTool> }[] = [];
        for (const tc of turn.toolCalls) {
          await this.task.checkpoint(false);
          this.onEvent("request", `[Genesis] ${tc.name}`, { tool: tc.name, args: tc.input });
          const res = await executeAgentToolAsync(this.state, tc.name, tc.input);
          this.onEvent(
            res.success ? "response" : "error",
            res.success
              ? `[Genesis] ${tc.name} succeeded`
              : `[Genesis] ${tc.name} failed: ${res.error}`,
            { tool: tc.name, args: tc.input, result: { ...res, images: undefined } },
          );
          this.task.recordTool(tc.name, tc.input, res);
          results.push({ toolCallId: tc.id, result: res });
        }
        turn = await this.observeTurn(this.conversation.sendToolResults(results));
        if (this.state.genesisComplete) break;
      } else {
        this.task.recordTool("unfinished_reply", {}, { success: false, message: turn.text ?? "" });
        // Model answered with text instead of tools, remind it to complete genesis
        this.onEvent("response", `[Genesis text] ${(turn.text ?? "").slice(0, 150)}`, {
          text: turn.text,
        });
        turn = await this.observeTurn(
          this.conversation.sendUserMessage(
            "Genesis resources are not complete yet. Please invoke write_words, write_view, write_picture, write_logic_source, and finish_genesis.",
          ),
        );
      }
    }

    if (turn.toolCalls.length)
      this.conversation.recordInterruption?.(
        "Genesis finished successfully. Additional tool calls in the final response were not executed; use a remix turn for further changes.",
      );
    this.onEvent("response", "Genesis authoring complete! Assembling boot files.");

    const files = Object.fromEntries(this.state.getFiles());
    const words = [...this.state.sources.words.entries()];
    const transcript = this.conversation.getTranscript();
    const sessionId = this.conversation.getSessionId?.();
    return { files, words, transcript, sessionId };
  }

  handle(req: LlmRequest): Promise<string> {
    return this.task.run(() => this.prepareRoom(req));
  }
  private async prepareRoom(req: LlmRequest): Promise<string> {
    if (!this.conversation && !this.stubFallback)
      throw new Error("Connect an API key in AI settings before creating the next room.");
    if (this.stubFallback) {
      const response = await this.stubFallback.handle(req);
      if (req.op === "room" && response) {
        const patch = prepareRoomPatch(
          openContainer(this.state.getFiles()),
          Number(req.context["room"]),
          response,
          this.state.sources.words,
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
    staged.genesisComplete = true;
    staged.sources.objects = readInventoryObjects(staged.getFiles().get("OBJECT"), staged.profile);
    const allowed = new Set(AUTHORING_SESSION_TOOLS);
    this.conversation.setTools(AUTHORING_SESSION_TOOLS);
    const snapshot: AgentRuntimeDeps = {
      engine: {
        state: () => req.context["state"] ?? null,
        objects: () => req.context["objects"] ?? [],
      },
    };
    this.onEvent("request", `[Runtime room] authoring room ${room} from room ${from}`);
    const resources = executeAgentTool(staged, "list_resources", { kind: null });
    const previous = executeAgentTool(staged, "read_logic", { num: from });
    try {
      let turn = await this.observeTurn(
        this.conversation.sendUserMessage(
          createRuntimeRoomPrompt(room, from) +
            `\nResources: ${resources.message ?? ""}\nInventory (preserve this order): ${JSON.stringify(staged.sources.objects)}\nPrevious room logic:\n${previous.message ?? ""}`,
        ),
      );
      let completed = false;
      for (;;) {
        if (turn.toolCalls.length === 0) {
          if (
            staged.container.getResource("logic", room) &&
            staged.container.getResource("picture", room)
          ) {
            completed = true;
            break;
          }
          this.task.recordTool(
            "unfinished_reply",
            {},
            { success: false, message: turn.text ?? "" },
          );
          turn = await this.observeTurn(
            this.conversation.sendUserMessage(
              `Room ${room} still needs both logic and picture. Author the missing resources.`,
            ),
          );
          continue;
        }
        const results: { toolCallId: string; result: AgentToolResult }[] = [];
        for (const tc of turn.toolCalls) {
          await this.task.checkpoint(false);
          this.onEvent("request", `[Room tool] ${tc.name}`, { tool: tc.name, args: tc.input });
          const candidate = forkAgentState(staged);
          let result: AgentToolResult;
          try {
            if (tc.name === "finish_genesis" || tc.name === "handover") {
              if (
                staged.container.getResource("logic", room) &&
                staged.container.getResource("picture", room)
              ) {
                completed = true;
                result = {
                  success: true,
                  message: `Room ${room} authored successfully. Handing over to resume gameplay.`,
                  details: { genesisComplete: true, roomHandover: room },
                };
              } else {
                result = {
                  success: false,
                  error: `Cannot hand over: room ${room} still needs both logic and picture. Author the missing resources before finishing.`,
                };
              }
            } else {
              result = allowed.has(tc.name)
                ? await executeAgentToolAsync(candidate, tc.name, tc.input, snapshot)
                : { success: false, error: "This tool is unavailable during room preparation." };
              if (result.success) {
                validateRoomCandidate(this.state, staged, candidate, room);
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
          this.task.recordTool(tc.name, tc.input, result);
          results.push({ toolCallId: tc.id, result });
        }
        turn = await this.observeTurn(this.conversation.sendToolResults(results));
        if (completed) break;
      }
      if (
        !completed &&
        turn.toolCalls.length === 0 &&
        staged.container.getResource("logic", room) &&
        staged.container.getResource("picture", room)
      )
        completed = true;
      if (!completed) throw new Error(`Room ${room} authoring did not finish.`);

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
        openContainer(this.state.getFiles()),
        room,
        response,
        this.state.sources.words,
      );
      Object.assign(this.state, staged);
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

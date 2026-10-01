/**
 * The Logic Studio project assistant: a request-scoped runtime over the shared
 * ProjectDraft workspace. A session binds one project workspace (through a live
 * accessor, so a reopened workspace is detected as a replacement), connects with
 * an owned LlmConfig, and drives one request at a time through the narrow
 * project tool catalog. Results are request-identified proposals the reviewer
 * accepts, rejects or lets an explicit scoped auto-approval apply — always
 * through the draft's own atomic compare-and-apply. Nothing here Keeps, Tests,
 * installs, or touches the live engine; state is session memory only, never
 * serialized into project archives or storage.
 */
import { AgentRun, DEFAULT_TASK_BUDGET_USD, type AgentRunState } from "./agentRun.ts";
import {
  createAnthropicConversation,
  createOpenAiConversation,
  type LlmConfig,
  type LlmTurnResult,
  type LlmUsage,
  type ProviderType,
  type UnifiedConversation,
} from "./llmClient.ts";
import {
  createProjectAssistDriver,
  PROJECT_ASSIST_TOOLS,
  PROJECT_ASSIST_TOOL_NAMES,
  type ProjectAssistDriver,
} from "./projectAssistTools.ts";
import type { AgentToolResult } from "../../../src/agent/agentState.ts";
import {
  captureAgentWorkspace,
  type AgentCandidateDiagnostic,
  type AgentWorkspace,
} from "../../../src/authoring/projectAgentCandidate.ts";
import type { ProjectDraft } from "../../../src/authoring/projectDraft.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";

/** Provider turns with tool calls one request may take: a ceiling, not a target. */
const MAX_PROJECT_ASSIST_ROUNDS = 8;

type DocumentContent = string | Uint8Array;
type WorkspaceProposal = ReturnType<ProjectDraft["propose"]>;
type WorkspaceTransaction = ReturnType<ProjectDraft["apply"]>;

/** One document edit inside a proposal: new whole text/bytes, or null to delete. */
interface ProjectAssistDocumentChange {
  readonly key: string;
  readonly content: DocumentContent | null;
}

/** The workspace a session serves, resolved lazily so reopening is detected. */
export interface ProjectAssistWorkspace {
  readonly draft: ProjectDraft;
  /** The kept native file image — a record or a cheap accessor consulted per request. */
  readonly files:
    Readonly<Record<string, Uint8Array>> | (() => Readonly<Record<string, Uint8Array>>);
  readonly profileId: ProfileId;
  /** Forwarded to reference inspection; only missing new.room targets soften. */
  readonly allowMissingRooms?: boolean;
  /**
   * Host-declared session eligibility for auto-approval. It is never persisted
   * project authority and imported data cannot self-opt-in — but a human may
   * explicitly opt into auto mode on a writable imported/remix workspace. A
   * readonly host leaves this unset to disallow auto entirely; explicit user
   * mode plus an exact scope is still the apply authority.
   */
  readonly autoApproveEligible?: boolean;
}

interface ProjectAssistRequest {
  /** The creator's words. */
  readonly instruction: string;
  /** Extra context the caller attached (selection, focus, notes), shown verbatim. */
  readonly context?: string;
}

/** How a completed proposal is handled for one request. */
type ProjectAssistOutcome = "applied" | "review" | "stale" | "refused" | "none" | "cancelled";

/**
 * The request-identified review handle. Opaque: authority lives in the
 * session's issued-proposal registry, so a lookalike or a handle from another
 * session is refused. Read methods stay usable after disconnect or staleness —
 * the retained before/after diff is review data, never apply authority.
 */
export interface ProjectAssistProposal {
  readonly requestId: string;
  readonly connectionEpoch: number;
  readonly label: string;
  /** Document keys the proposal writes. */
  readonly keys: readonly string[];
  /** Changed keys whose content is a deletion. */
  readonly deletions: readonly string[];
  readonly baseRevision: number;
  /** Detached before/after for review; safe after the draft moved on. */
  changes(): readonly ProjectAssistDocumentChange[];
  /** The captured document the proposal started from, if it existed. */
  before(key: string): DocumentContent | undefined;
  /** Whether the workspace changed since this proposal's base was captured. */
  stale(): boolean;
  /** Apply through the draft's atomic transaction, checked against live authority. */
  accept(): ProjectAssistAccept;
  /** Release this proposal without applying; only this request's proposal is affected. */
  reject(): boolean;
}

type ProjectAssistAccept =
  | {
      readonly ok: true;
      readonly label: string;
      readonly keys: readonly string[];
      /** One atomic draft transaction: a single coordinated undo group. */
      readonly transaction: WorkspaceTransaction;
    }
  | {
      readonly ok: false;
      readonly reason: "stale" | "closed" | "consumed" | "rejected" | "superseded" | "foreign";
      readonly message: string;
    };

export interface ProjectAssistResult {
  readonly requestId: string;
  readonly connectionEpoch: number;
  readonly outcome: ProjectAssistOutcome;
  /** The model's closing text, or the reason a request ended without one. */
  readonly text: string;
  readonly label?: string;
  /** Document keys the issued proposal (or applied transaction) changed. */
  readonly keys: readonly string[];
  readonly deletions: readonly string[];
  readonly proposal?: ProjectAssistProposal;
  /** One atomic draft transaction when outcome is "applied". */
  readonly transaction?: WorkspaceTransaction;
  readonly diagnostics: readonly AgentCandidateDiagnostic[];
  readonly profileId: ProfileId;
  readonly proposals: number;
  readonly refusals: number;
  readonly usage?: LlmUsage;
}

export type ProjectAssistApproval =
  { readonly mode: "review" } | { readonly mode: "auto"; readonly scope: readonly string[] };

export interface ProjectAssistState {
  readonly closed: boolean;
  readonly connected: boolean;
  /** Bumped by connect/disconnect/close; proposals carry the epoch they were issued under. */
  readonly connectionEpoch: number;
  /** Bumped when the workspace accessor starts returning another draft. */
  readonly workspaceEpoch: number;
  /** The in-flight or most recent request identity. */
  readonly requestId: string | null;
  readonly phase: "disconnected" | "idle" | "running" | "paused";
  readonly approval: ProjectAssistApproval;
  readonly provider: ProviderType | null;
  readonly model: string | null;
  readonly run: AgentRunState | null;
  /** The open reviewable proposal, if one is awaiting the reviewer. */
  readonly pendingProposal: {
    readonly requestId: string;
    readonly label: string;
    readonly keys: readonly string[];
    readonly deletions: readonly string[];
    readonly stale: boolean;
  } | null;
  readonly lastResult: ProjectAssistResult | null;
}

type ProjectAssistEventSink = (
  kind: "request" | "response" | "error" | "log" | "telemetry" | "state",
  detail: string,
  data?: unknown,
) => void;

/**
 * Test seam: builds the per-request conversation. The production default calls
 * createOpenAiConversation/createAnthropicConversation with the project assist
 * tool catalog; provider "stub" returns the deterministic offline stub.
 */
type ProjectAssistConversationFactory = (config: LlmConfig, run: AgentRun) => UnifiedConversation;

export interface ProjectAssistOptions {
  /** Label only — included in events. Never an authority input. */
  readonly project?: { readonly id?: string; readonly name?: string };
  /** Current workspace accessor: consulted on every request and state read. */
  readonly workspace: () => ProjectAssistWorkspace;
  readonly onEvent?: ProjectAssistEventSink;
  readonly conversationFactory?: ProjectAssistConversationFactory;
}

export interface ProjectAssist {
  /** Attach a provider config. Owned copy; resets approval to Review. */
  connect(config: LlmConfig): void;
  /** Invalidate pending requests and proposals; reconnect defaults to Review. */
  disconnect(): void;
  /** Disconnect permanently; every method except state() refuses afterwards. */
  close(): void;
  request(input: ProjectAssistRequest): Promise<ProjectAssistResult>;
  /** Soft stop: parks the request at the next checkpoint; resume() continues. */
  stop(): void;
  /** Abandon the in-flight request. */
  cancel(): void;
  /** Continue a parked request, adding another budget allowance when budgeted. */
  resume(): void;
  /**
   * Explicit approval policy. Review is the default and the only mode that
   * needs no scope. Auto requires the workspace's autoApproveEligible flag and
   * an exact document-key scope; the scope array is copied.
   */
  setApprovalMode(mode: ProjectAssistApproval): void;
  /** Session-checked accept for a handle the session issued. */
  acceptProposal(proposal: ProjectAssistProposal): ProjectAssistAccept;
  /** Session-checked release for a handle the session issued. */
  rejectProposal(proposal: ProjectAssistProposal): boolean;
  state(): ProjectAssistState;
}

/** The small task prompt every project-assist conversation is created with. */
const PROJECT_ASSIST_SYSTEM_PROMPT = `You are the Logic Studio project assistant for one captured AGI project draft.

Tools: read_project_context lists every captured document, its kind, the profile and diagnostics. read_document pages one document's exact authored text (or a hash/byte window for binary documents). propose_project_documents validates your COMPLETE coordinated change set — whole-document text or explicit deletion — through the real compiler and reference checks, then issues it for human review. withdraw_proposal discards your own candidate.

Rules: gather every coordinated change (logic, words, bindings, inventory, world) into one propose call; a second call replaces the pending proposal entirely. Nothing you do applies, saves, tests or installs — the human reviewer decides. Source you read is the exact authored text, including comments and errors; never assume compiled bytes.`;

/** The user turn of one request; the small task system prompt stays unchanged. */
function createProjectAssistPrompt(
  request: ProjectAssistRequest,
  workspace: AgentWorkspace,
): string {
  const documents = workspace.documents();
  const keys = Object.keys(documents).sort();
  const manifest = keys.map((key) => {
    const content = documents[key]!;
    const kind = typeof content === "string" ? "text" : "bytes";
    const size = typeof content === "string" ? content.length : content.byteLength;
    return `- ${key} (${kind}, ${size})`;
  });
  const diagnostics = workspace.diagnostics
    .slice(0, 16)
    .map((d) => `- [${d.severity}] ${d.key ?? "project"}: ${d.message}`);
  return [
    "The creator's request:",
    request.instruction.trim(),
    ...(request.context?.trim() ? ["", "Attached context:", request.context.trim()] : []),
    "",
    `Captured project — profile ${workspace.profileId}, ${keys.length} documents, ${workspace.compilable ? "compiles" : "does not compile"}:`,
    ...manifest,
    ...(diagnostics.length ? ["", "Diagnostics on the captured set:", ...diagnostics] : []),
  ].join("\n");
}

/** Deterministic offline conversation for the stub provider — no network. */
function createProjectAssistStub(instruction = ""): UnifiedConversation {
  const transcript: unknown[] = [];
  return {
    setAvailableTools() {},
    async sendUserMessage(text: string): Promise<LlmTurnResult> {
      transcript.push({ role: "user", text });
      return { toolCalls: [{ id: "stub-1", name: "read_project_context", input: {} }] };
    },
    appendToolResults(results): void {
      for (const r of results)
        transcript.push({ role: "tool", toolCallId: r.toolCallId, result: r.result });
    },
    async complete(): Promise<LlmTurnResult> {
      return {
        text: `Stub inspected the captured project and proposes nothing for "${instruction.trim() || "the request"}".`,
        toolCalls: [],
      };
    },
    getTranscript(): unknown[] {
      return structuredClone(transcript);
    },
  };
}

interface ProposalRecord {
  readonly requestId: string;
  readonly connectionEpoch: number;
  readonly draft: ProjectDraft;
  readonly proposal: WorkspaceProposal;
  /** Revoked on supersede/disconnect — the diff stays readable, accept refuses. */
  revoked: boolean;
  status: "open" | "applied" | "rejected";
}

/** A private observational copy — sinks mutating the offered snapshot cannot steer the session. */
function copyRunState(s: AgentRunState): AgentRunState {
  return { ...s, progress: s.progress ? { ...s.progress } : null };
}

/**
 * A detached observational copy of a result: nested arrays/records are new.
 * The proposal handle and draft transaction keep their identity — a WeakMap
 * handle and a DraftTransaction id are authority, never data to clone.
 */
function copyResult(result: ProjectAssistResult): ProjectAssistResult {
  return {
    ...result,
    keys: [...result.keys],
    deletions: [...result.deletions],
    diagnostics: result.diagnostics.map((d) => ({ ...d })),
    ...(result.usage ? { usage: { ...result.usage } } : {}),
  };
}

function copyConfig(config: LlmConfig): LlmConfig {
  return {
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    ...(config.effort !== undefined ? { effort: config.effort } : {}),
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.budgetUsd !== undefined ? { budgetUsd: config.budgetUsd } : {}),
    ...(config.stubScript !== undefined ? { stubScript: config.stubScript } : {}),
  };
}

export function createProjectAssist(options: ProjectAssistOptions): ProjectAssist {
  let closed = false;
  let config: LlmConfig | null = null;
  let connectionEpoch = 0;
  let workspaceEpoch = 0;
  let seenDraft: ProjectDraft | null = null;
  let approval: { mode: "review" } | { mode: "auto"; scope: ReadonlySet<string> } = {
    mode: "review",
  };
  let requestSeq = 0;
  let generation = 0;
  let run: AgentRun | null = null;
  let runState: AgentRunState | null = null;
  let activeRequestId: string | null = null;
  let lastResult: ProjectAssistResult | null = null;
  let pending: ProposalRecord | null = null;
  const issued = new WeakMap<ProjectAssistProposal, ProposalRecord>();
  const openRecords = new Set<ProposalRecord>();

  const emit: ProjectAssistEventSink = (kind, detail, data) => {
    try {
      options.onEvent?.(kind, detail, data);
    } catch {
      // A host sink error must not corrupt request state.
    }
  };

  function workspaceNow(): ProjectAssistWorkspace {
    const ws = options.workspace();
    if (seenDraft === null) seenDraft = ws.draft;
    else if (ws.draft !== seenDraft) {
      seenDraft = ws.draft;
      workspaceEpoch++;
      // A reopened workspace ends the in-flight request, revokes the previous
      // workspace's proposals (their diffs stay readable) and resets approval
      // to Review — auto mode never survives a workspace change.
      abortActive();
      approval = { mode: "review" };
      emit("state", "workspace", { workspaceEpoch });
    }
    return ws;
  }

  /** Rejects the in-flight request's provider waits, whoever they are. */
  let cancelWaits: (() => void) | null = null;

  /** Revoke every still-open issued proposal; handles keep read-only diff data. */
  function revokeOpen(): void {
    for (const record of openRecords) record.revoked = true;
    openRecords.clear();
    pending = null;
  }

  function abortActive(): void {
    generation++;
    const release = cancelWaits;
    cancelWaits = null;
    const active = run;
    if (active) {
      active.cancel();
      run = null;
    }
    activeRequestId = null;
    revokeOpen();
    release?.();
  }

  function proposalStale(record: ProposalRecord): boolean {
    try {
      if (options.workspace().draft !== record.draft) return true;
    } catch {
      return true;
    }
    return record.draft.capture().revision !== record.proposal.baseRevision;
  }

  function makeHandle(record: ProposalRecord): ProjectAssistProposal {
    const changes = record.proposal.changes();
    const keys = changes.map((c) => c.key);
    const deletions = changes.filter((c) => c.content === null).map((c) => c.key);
    const handle: ProjectAssistProposal = {
      requestId: record.requestId,
      connectionEpoch: record.connectionEpoch,
      label: record.proposal.label,
      keys,
      deletions,
      baseRevision: record.proposal.baseRevision,
      changes: () => record.proposal.changes(),
      before: (key: string) => {
        try {
          return record.proposal.base.read(key)?.content;
        } catch {
          return undefined;
        }
      },
      stale: () => proposalStale(record),
      accept: () => api.acceptProposal(handle),
      reject: () => api.rejectProposal(handle),
    };
    return handle;
  }

  async function drive(
    conversation: UnifiedConversation,
    driver: ProjectAssistDriver,
    prompt: string,
    activeRun: AgentRun,
    race: <T>(pending: Promise<T>) => Promise<T>,
    admit: () => void,
  ): Promise<LlmTurnResult> {
    // Admission is checked before every provider operation — a request whose
    // connection died inside an event sink must never start a paid call.
    admit();
    let turn = await race(conversation.sendUserMessage(prompt));
    let rounds = 0;
    while (turn.toolCalls.length > 0) {
      if (rounds >= MAX_PROJECT_ASSIST_ROUNDS) {
        conversation.recordInterruption?.(
          `Stopped after ${MAX_PROJECT_ASSIST_ROUNDS} tool rounds; the pending calls were not executed.`,
        );
        return { text: turn.text ?? "", toolCalls: [] };
      }
      await activeRun.checkpoint(false);
      admit();
      const results: { toolCallId: string; result: AgentToolResult }[] = [];
      try {
        for (const call of turn.toolCalls) {
          admit();
          const result: AgentToolResult = driver.execute(call.name, call.input);
          activeRun.recordTool(call.name, call.input, result);
          results.push({ toolCallId: call.id, result });
          // The log sink is a host callback; it may have ended the request.
          emit("log", call.name, result.success ? result.details : { error: result.error });
          admit();
        }
      } finally {
        // Executed results are appended exactly once, in success and
        // interruption; the catch below records the truthful closure for any
        // provider calls that never ran.
        if (results.length > 0) conversation.appendToolResults(results);
      }
      rounds++;
      admit();
      turn = await race(conversation.complete());
    }
    return turn;
  }

  async function request(input: ProjectAssistRequest): Promise<ProjectAssistResult> {
    if (closed) throw new Error("Project assist session is closed.");
    const owned = config;
    if (!owned) throw new Error("Project assist is not connected.");
    // Supersede any in-flight request; its loop resolves cancelled. Resolve the
    // workspace before capturing the generation — a replaced workspace aborts
    // once more, and this request must outlive that abort.
    abortActive();
    const ws = workspaceNow();
    const gen = generation;
    const epoch = connectionEpoch;
    const requestId = `r${++requestSeq}`;
    const draft = ws.draft;
    const files = typeof ws.files === "function" ? ws.files() : ws.files;
    const workspace = captureAgentWorkspace({
      draft,
      files,
      profileId: ws.profileId,
      ...(ws.allowMissingRooms === true ? { allowMissingRooms: true } : {}),
    });
    const driver = createProjectAssistDriver(workspace);
    const model = owned.model;
    const activeRun = new AgentRun(
      model,
      (s) => {
        // A superseded run retained by a test seam or provider cannot overwrite
        // the current request's progress — callbacks are checked against the
        // live run identity, not just the final result.
        if (run !== activeRun) return;
        // Retain and offer separate copies — a host sink mutating the emitted
        // snapshot cannot corrupt the session's own progress record.
        runState = copyRunState(s);
        emit("state", requestId, copyRunState(s));
      },
      owned.budgetUsd ?? DEFAULT_TASK_BUDGET_USD,
    );
    run = activeRun;
    runState = activeRun.snapshot();
    activeRequestId = requestId;
    const convConfig = {
      ...owned,
      systemPrompt: owned.systemPrompt ?? PROJECT_ASSIST_SYSTEM_PROMPT,
    };
    const conversation =
      owned.provider === "stub"
        ? createProjectAssistStub(input.instruction)
        : (options.conversationFactory ?? ((cfg, r) => defaultConversation(cfg, r)))(
            convConfig,
            activeRun,
          );
    conversation.setAvailableTools?.(PROJECT_ASSIST_TOOL_NAMES);
    const prompt = createProjectAssistPrompt(input, workspace);

    const live = () => gen === generation && epoch === connectionEpoch && !closed;
    /**
     * Full liveness: generation + connection epoch + session + workspace —
     * re-read both before AND after the external workspace accessor, because
     * workspaceNow() may abort on replacement and its state emit is itself a
     * host callback. Returns the current workspace wrapper so eligibility and
     * other host fields are read fresh, never from the request-time snapshot.
     */
    const currentWorkspace = (): ProjectAssistWorkspace | null => {
      if (!live()) return null;
      try {
        const wsNow = workspaceNow();
        if (!live() || wsNow.draft !== draft) return null;
        return wsNow;
      } catch {
        return null;
      }
    };
    const stillLive = (): boolean => currentWorkspace() !== null;
    /** Current-authority admission check before any provider operation. */
    const admit = (): void => {
      if (!stillLive()) throw new Error("Project assist request cancelled.");
    };
    const cancelledResult = (text: string): ProjectAssistResult => ({
      requestId,
      connectionEpoch: epoch,
      outcome: "cancelled",
      text,
      keys: [],
      deletions: [],
      diagnostics: driver.lastDiagnostics,
      profileId: ws.profileId,
      proposals: driver.proposals,
      refusals: driver.refusals,
    });

    // Provider waits race a session-level cancel so disconnect, a newer
    // request and workspace replacement resolve promptly even when the
    // conversation ignores the abort signal. The machinery is installed
    // before the request event — a sink may end the request inside that very
    // callback, and AgentRun.run() resets its own cancelled flag on start.
    let releaseWaits: (() => void) | null = null;
    const cancelledWait = new Promise<never>((_, reject) => {
      releaseWaits = () => reject(new Error("Project assist request cancelled."));
    });
    cancelledWait.catch(() => {});
    cancelWaits = releaseWaits;
    const race = <T>(pendingPromise: Promise<T>): Promise<T> =>
      Promise.race([pendingPromise, cancelledWait]);

    emit("request", requestId, { instruction: input.instruction, context: input.context });

    let turn: LlmTurnResult;
    try {
      turn = await activeRun.run(async () => {
        const done = await drive(conversation, driver, prompt, activeRun, race, admit);
        // A stop that lands during the final provider wait parks here — the
        // terminal result, and any auto-apply, happens only after resume.
        await race(activeRun.checkpoint(false));
        return done;
      });
    } catch (error) {
      if (run === activeRun) run = null;
      if (activeRequestId === requestId) activeRequestId = null;
      const message = error instanceof Error ? error.message : String(error);
      // Close pending provider tool calls exactly once — the conversation may
      // still hold an unexecuted tool_use/function_call turn.
      conversation.recordInterruption?.(`The request ended before the model finished: ${message}`);
      if (cancelWaits === releaseWaits) cancelWaits = null;
      const result = cancelledResult(message);
      if (live()) lastResult = copyResult(result);
      return result;
    }
    if (activeRequestId === requestId) activeRequestId = null;
    if (run === activeRun) run = null;
    if (cancelWaits === releaseWaits) cancelWaits = null;

    if (!stillLive()) {
      return cancelledResult("The workspace or connection changed before the response arrived.");
    }

    if (turn.telemetry) emit("telemetry", requestId, turn.telemetry);
    // Every host callback may disconnect, supersede or replace the workspace;
    // recheck before the terminal result or an auto-apply can land.
    if (!stillLive()) {
      return cancelledResult("The connection or workspace changed during completion.");
    }
    const proposal = driver.pending();
    const changes = proposal?.changes() ?? [];
    const keys = changes.map((c) => c.key);
    const deletions = changes.filter((c) => c.content === null).map((c) => c.key);
    const base: Omit<ProjectAssistResult, "outcome"> = {
      requestId,
      connectionEpoch: epoch,
      text: turn.text ?? "",
      ...(proposal ? { label: proposal.label } : {}),
      keys,
      deletions,
      diagnostics: driver.lastDiagnostics,
      profileId: ws.profileId,
      proposals: driver.proposals,
      refusals: driver.refusals,
      ...(turn.usage ? { usage: turn.usage } : {}),
    };
    if (!proposal) {
      const result: ProjectAssistResult = {
        ...base,
        outcome: driver.refusals > 0 ? "refused" : "none",
      };
      lastResult = copyResult(result);
      emit("response", requestId, copyResult(result));
      return result;
    }
    const record: ProposalRecord = {
      requestId,
      connectionEpoch: epoch,
      draft,
      proposal,
      revoked: false,
      status: "open",
    };
    const handle = makeHandle(record);
    issued.set(handle, record);
    openRecords.add(record);
    const stale = draft.capture().revision !== proposal.baseRevision;
    if (stale) {
      pending = record;
      const result: ProjectAssistResult = { ...base, outcome: "stale", proposal: handle };
      lastResult = copyResult(result);
      emit("response", requestId, copyResult(result));
      return result;
    }
    // Re-read generation, connection, workspace identity, mode, scope and the
    // CURRENT workspace wrapper's eligibility immediately before the atomic
    // apply — mid-flight changes apply, no earlier observation counts.
    const wsAtApply = currentWorkspace();
    if (wsAtApply === null) {
      return cancelledResult("The connection or workspace changed during completion.");
    }
    const scope = approval.mode === "auto" ? approval.scope : null;
    const auto =
      wsAtApply.autoApproveEligible === true &&
      scope !== null &&
      deletions.length === 0 &&
      keys.every((key) => scope.has(key));
    if (auto) {
      try {
        const transaction = draft.apply(proposal);
        record.status = "applied";
        openRecords.delete(record);
        const result: ProjectAssistResult = {
          ...base,
          outcome: "applied",
          proposal: handle,
          transaction,
        };
        lastResult = copyResult(result);
        emit("response", requestId, copyResult(result));
        return result;
      } catch (error) {
        // A stale base on the apply path falls back to review, never a rebase.
        const result: ProjectAssistResult = {
          ...base,
          outcome: "stale",
          text: error instanceof Error ? error.message : String(error),
          proposal: handle,
        };
        lastResult = copyResult(result);
        emit("response", requestId, copyResult(result));
        return result;
      }
    }
    pending = record;
    const result: ProjectAssistResult = { ...base, outcome: "review", proposal: handle };
    lastResult = copyResult(result);
    emit("response", requestId, copyResult(result));
    return result;
  }

  const api: ProjectAssist = {
    connect(next: LlmConfig): void {
      if (closed) throw new Error("Project assist session is closed.");
      abortActive();
      config = copyConfig(next);
      connectionEpoch++;
      approval = { mode: "review" };
      emit("state", "connect", { connectionEpoch });
    },
    disconnect(): void {
      if (closed) return;
      abortActive();
      config = null;
      connectionEpoch++;
      approval = { mode: "review" };
      emit("state", "disconnect", { connectionEpoch });
    },
    close(): void {
      if (closed) return;
      abortActive();
      config = null;
      connectionEpoch++;
      closed = true;
      emit("state", "close", { connectionEpoch });
    },
    request,
    stop(): void {
      run?.stop();
    },
    cancel(): void {
      run?.cancel();
      cancelWaits?.();
    },
    resume(): void {
      run?.resume();
    },
    setApprovalMode(mode: ProjectAssistApproval): void {
      if (closed) throw new Error("Project assist session is closed.");
      approval =
        mode.mode === "review" ? { mode: "review" } : { mode: "auto", scope: new Set(mode.scope) };
      emit("state", "approval", {
        mode: approval.mode,
        ...(approval.mode === "auto" ? { scope: [...approval.scope] } : {}),
      });
    },
    acceptProposal(handle: ProjectAssistProposal): ProjectAssistAccept {
      const record = issued.get(handle);
      if (!record)
        return {
          ok: false,
          reason: "foreign",
          message: "This handle was not issued by this session.",
        };
      /** Named refusal when the record's authority is gone, or null. */
      const authorityCheck = (): ProjectAssistAccept | null => {
        if (record.status === "applied")
          return { ok: false, reason: "consumed", message: "This proposal was already applied." };
        if (record.status === "rejected")
          return { ok: false, reason: "rejected", message: "This proposal was rejected." };
        if (closed || !config || record.connectionEpoch !== connectionEpoch)
          return {
            ok: false,
            reason: "closed",
            message: "The connection that issued this proposal is closed.",
          };
        if (record.revoked)
          return {
            ok: false,
            reason: "superseded",
            message: "A newer request, reconnect or workspace replaced this proposal.",
          };
        return null;
      };
      let refusal = authorityCheck();
      if (refusal) return refusal;
      let currentDraft: ProjectDraft;
      try {
        currentDraft = options.workspace().draft;
      } catch {
        return {
          ok: false,
          reason: "closed",
          message: "The workspace that issued this proposal is unavailable.",
        };
      }
      // The accessor is host code — it may have disconnected, superseded or
      // consumed this record while running. Recheck authority after it and
      // again at the atomic apply; nothing else runs in between.
      refusal = authorityCheck();
      if (refusal) return refusal;
      if (currentDraft !== record.draft)
        return {
          ok: false,
          reason: "stale",
          message: "The workspace that issued this proposal was replaced.",
        };
      refusal = authorityCheck();
      if (refusal) return refusal;
      try {
        const transaction = record.draft.apply(record.proposal);
        record.status = "applied";
        openRecords.delete(record);
        if (pending === record) pending = null;
        return {
          ok: true,
          label: transaction.label,
          keys: transaction.keys,
          transaction,
        };
      } catch (error) {
        return {
          ok: false,
          reason: "stale",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    rejectProposal(handle: ProjectAssistProposal): boolean {
      const record = issued.get(handle);
      if (!record || record.status !== "open") return false;
      record.status = "rejected";
      openRecords.delete(record);
      if (pending === record) pending = null;
      return true;
    },
    state(): ProjectAssistState {
      const ws = closed ? null : safeWorkspace();
      const pendingStale =
        pending !== null &&
        (ws?.draft !== pending.draft ||
          pending.draft.capture().revision !== pending.proposal.baseRevision);
      const pendingChanges = pending?.proposal.changes() ?? [];
      const phase = !config
        ? "disconnected"
        : runState?.status === "paused"
          ? "paused"
          : runState?.status === "running"
            ? "running"
            : "idle";
      return {
        closed,
        connected: config !== null,
        connectionEpoch,
        workspaceEpoch,
        requestId: activeRequestId ?? lastResult?.requestId ?? null,
        phase,
        approval:
          approval.mode === "review"
            ? { mode: "review" }
            : { mode: "auto", scope: [...approval.scope] },
        provider: config?.provider ?? null,
        model: config?.model ?? null,
        // The snapshot is detached; callers mutating it cannot steer the session.
        run: runState ? copyRunState(runState) : null,
        pendingProposal: pending
          ? {
              requestId: pending.requestId,
              label: pending.proposal.label,
              keys: pendingChanges.map((c) => c.key),
              deletions: pendingChanges.filter((c) => c.content === null).map((c) => c.key),
              stale: pendingStale,
            }
          : null,
        lastResult: lastResult ? copyResult(lastResult) : null,
      };
    },
  };

  function safeWorkspace(): ProjectAssistWorkspace | null {
    try {
      return workspaceNow();
    } catch {
      return null;
    }
  }

  return api;
}

function defaultConversation(config: LlmConfig, run: AgentRun): UnifiedConversation {
  if (config.provider === "openai")
    return createOpenAiConversation(config, undefined, undefined, run, PROJECT_ASSIST_TOOLS);
  if (config.provider === "anthropic")
    return createAnthropicConversation(config, undefined, run, PROJECT_ASSIST_TOOLS);
  return createProjectAssistStub("");
}

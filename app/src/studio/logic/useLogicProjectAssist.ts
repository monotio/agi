/**
 * Logic Studio's project assistant panel state over the frozen
 * createProjectAssist runtime. One session serves the mounted workspace
 * accessor: connect() binds the saved AI settings locally (no provider
 * request — only Ask starts one), Review is the default approval mode, and
 * an accepted proposal is one atomic draft transaction the creator can undo
 * as a unit. The draft stays the authority; this composable never edits
 * documents, Keeps, installs, or touches a running game.
 *
 * Session honesty rules the panel relies on:
 * - Settings changes while connected rebind the session (connect() resets
 *   Review and bumps the connection epoch); an explicit Disconnect is
 *   respected until the creator Connects or Asks again.
 * - A replaced workspace (project switch, recovery restore) disposes the
 *   session before the new one answers, so no stale assistant belongs to the
 *   old project.
 * - Undo/redo of an accepted proposal goes through draft.undo/redo with its
 *   strict later-edit conflict check — a refused conflict is reported, never
 *   force-rolled back.
 */
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import type { ProjectDraft } from "../../../../src/authoring/projectDraft.ts";
import type { AiSettingsApi } from "../../settings/useAiSettings.ts";
import {
  createProjectAssist,
  type ProjectAssist,
  type ProjectAssistApproval,
  type ProjectAssistOptions,
  type ProjectAssistProposal,
  type ProjectAssistResult,
  type ProjectAssistState,
  type ProjectAssistWorkspace,
} from "../../agent/projectAssist.ts";

type DraftTransaction = ReturnType<ProjectDraft["apply"]>;
type TransactionId = DraftTransaction["id"];

/** What the mounted workspace hands the session per request/read. */
export type LogicAssistWorkspaceAccessor = () => ProjectAssistWorkspace;

export interface LogicAssistHost {
  /**
   * The current workspace wrapper; throws when no project is mounted so the
   * session refuses cleanly instead of serving a stale project.
   */
  workspace(): ProjectAssistWorkspace;
  /** Editor context attached to the next request: document, caret, selection. */
  editorContext(): string | undefined;
  /** The host's reactive draft revision — a read keeps staleness computeds live. */
  revisionTick(): number;
  /**
   * Called synchronously after any external draft write (accepted proposal,
   * auto-apply, undo/redo) so the host reconciles editor models, bumps its
   * revision and schedules recovery — exactly once per transaction.
   */
  onDraftChanged(keys: readonly string[]): void;
}

export interface LogicAssistOptions {
  /**
   * The shared AI settings controller (provider/model/key/effort/budget), or
   * null where no settings controller exists — the panel then stays
   * connect-only and never offers provider actions.
   */
  readonly ai: AiSettingsApi | null;
  readonly host: LogicAssistHost;
  /** Test seam: swap session construction; defaults to createProjectAssist. */
  readonly assistFactory?: (options: ProjectAssistOptions) => ProjectAssist;
}

export interface AssistTurn {
  readonly role: "creator" | "ai";
  readonly text: string;
}

/** The last accepted transaction, for the atomic Undo changes/Redo changes. */
export interface AssistUndo {
  readonly id: TransactionId;
  readonly label: string;
  readonly keys: readonly string[];
  readonly undone: boolean;
}

/** A proposal already applied (manual accept or scoped auto-apply). */
export interface AssistApplied {
  readonly label: string;
  readonly keys: readonly string[];
  /** The issuing handle: its before/after diff stays readable for review. */
  readonly handle: ProjectAssistProposal;
}

/** Most bytes of selected text a request's attached context may carry. */
export const MAX_ASSIST_SELECTION_CHARS = 4000;

const EMPTY_STATE: ProjectAssistState = {
  closed: false,
  connected: false,
  connectionEpoch: 0,
  workspaceEpoch: 0,
  requestId: null,
  phase: "disconnected",
  approval: { mode: "review" },
  provider: null,
  model: null,
  run: null,
  pendingProposal: null,
  lastResult: null,
};

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Friendly step lines for a request's tool activity, in the creator's words. */
const STEP_WORDS: Record<string, { doing: string; done: string }> = {
  read_project_context: { doing: "Reading the project…", done: "Read the project" },
  read_document: { doing: "Reading a document…", done: "Read a document" },
  propose_project_documents: { doing: "Proposing changes…", done: "Proposed changes" },
  withdraw_proposal: { doing: "Withdrawing its proposal…", done: "Withdrew its proposal" },
  read_command_reference: { doing: "Reading the command reference…", done: "Read the reference" },
  read_authoring_guide: { doing: "Reading the authoring guide…", done: "Read the guide" },
};

export function useLogicProjectAssist(options: LogicAssistOptions) {
  const makeSession = options.assistFactory ?? createProjectAssist;

  let session: ProjectAssist | undefined;
  /** Bumped by every session event so computed state reads refresh. */
  const tick = ref(0);
  /** Tool-step lines for the current request only — never across projects. */
  const steps = ref<readonly string[]>([]);
  const turns = ref<readonly AssistTurn[]>([]);
  /** The proposal awaiting review, if the last result offered one. */
  const pending = shallowRef<ProjectAssistProposal | null>(null);
  /** The proposal that was applied, kept for the applied-diff view + undo. */
  const applied = shallowRef<AssistApplied | null>(null);
  const lastResult = shallowRef<ProjectAssistResult | null>(null);
  const lastTransaction = shallowRef<AssistUndo | null>(null);
  const error = ref<string | undefined>();
  /** Undo/redo conflict or failure, in plain words. */
  const undoNote = ref<string | undefined>();
  /** The creator chose Disconnect; nothing auto-reconnects until Connect/Ask. */
  const manualDisconnect = ref(false);
  /** Why the review's proposal was refused by apply, when it was. */
  const acceptNote = ref<string | undefined>();

  function onSessionEvent(
    kind: "request" | "response" | "error" | "log" | "telemetry" | "state",
    detail: string,
    data?: unknown,
  ): void {
    tick.value++;
    if (kind === "request") steps.value = [];
    if (kind === "log") {
      // data is the tool result's details on success, or { error } on a
      // denial/refusal — a failed call lands as a refused step line.
      const record = data && typeof data === "object" ? (data as { error?: unknown }) : undefined;
      const failed = record !== undefined && record.error !== undefined;
      const words = STEP_WORDS[detail];
      const label = failed
        ? `Refused: ${String(record.error).slice(0, 200)}`
        : (words?.done ?? detail);
      steps.value = [...steps.value.slice(-19), label];
    }
    if (kind === "state" && detail === "workspace") {
      // A reopened workspace revoked every old handle; the panel shows
      // nothing that belongs to the previous project.
      pending.value = null;
      applied.value = null;
      lastTransaction.value = null;
      lastResult.value = null;
      acceptNote.value = undefined;
      undoNote.value = undefined;
      steps.value = [];
      turns.value = [];
    }
  }

  function ensureSession(): ProjectAssist {
    if (!session)
      session = makeSession({ workspace: () => options.host.workspace(), onEvent: onSessionEvent });
    return session;
  }

  /** Bind the saved provider config locally — connect() makes no provider call. */
  function connectNow(): boolean {
    const ai = options.ai;
    if (!ai || !ai.aiConfigured.value) return false;
    manualDisconnect.value = false;
    ensureSession().connect(ai.llmConfig());
    return true;
  }

  function disconnectNow(): void {
    manualDisconnect.value = true;
    session?.disconnect();
  }

  // Reactivity: tick covers session events, revisionTick covers draft writes.
  const state = computed<ProjectAssistState>(() => {
    void tick.value;
    options.host.revisionTick();
    return session?.state() ?? EMPTY_STATE;
  });
  const phase = computed(() => state.value.phase);
  const connected = computed(() => state.value.connected);
  const running = computed(() => phase.value === "running" || phase.value === "paused");
  /** The pending proposal's staleness against the live draft, refreshed. */
  const pendingStale = computed(() => {
    void tick.value;
    options.host.revisionTick();
    return pending.value?.stale() ?? false;
  });
  /**
   * Whether this host's workspace is eligible for auto-approval at all —
   * read fresh from the current wrapper, matching the runtime's own check.
   */
  const autoEligible = computed(() => {
    void tick.value;
    options.host.revisionTick();
    try {
      return options.host.workspace().autoApproveEligible === true;
    } catch {
      return false;
    }
  });
  /** The budget line for a running or paused request. */
  const budget = computed(() => {
    const run = state.value.run;
    if (!run) return "";
    if (!run.priceKnown) return `Budget $${run.budget.toFixed(2)} · usage estimate unavailable`;
    return `$${Math.max(0, run.budget - run.spent).toFixed(2)} of $${run.budget.toFixed(2)} left`;
  });
  /** One status line for the live region and the running block. */
  const status = computed(() => {
    const run = state.value.run;
    if (run?.status === "paused") return run.reason;
    if (phase.value !== "running") return "";
    const last = steps.value.at(-1);
    const progress = run?.progress;
    if (progress?.phase === "thinking") return "Thinking…";
    if (progress?.phase === "text") return "Writing…";
    return last ?? "Waiting for the model…";
  });

  /** Drop review/undo state that belonged to a superseded authority. */
  function clearReview(): void {
    pending.value = null;
    applied.value = null;
    lastTransaction.value = null;
    lastResult.value = null;
    acceptNote.value = undefined;
    undoNote.value = undefined;
  }

  /**
   * The host replaces its workspace (project switch, recovery restore): the
   * old session is closed before the new workspace answers, then a fresh
   * session binds the saved settings when the creator still wants them.
   */
  function onWorkspaceSwapped(): void {
    session?.close();
    session = undefined;
    clearReview();
    steps.value = [];
    turns.value = [];
    tick.value++;
    if (!manualDisconnect.value && options.ai?.aiConfigured.value) connectNow();
  }

  // Bound once at mount when a configured provider is saved — session-local
  // binding only, never a provider request and never persisted authority.
  if (options.ai?.aiConfigured.value) connectNow();

  // Provider/model/key/effort/budget changes invalidate the old session's
  // authority: rebind (connect resets Review) when bound, or disconnect when
  // the key went away. A creator who explicitly disconnected stays so.
  const ai = options.ai;
  if (ai)
    watch(
      () =>
        [
          ai.provider.value,
          ai.model.value,
          ai.apiKey.value,
          ai.effort.value,
          ai.taskBudget.value,
        ] as const,
      () => {
        if (connected.value) {
          if (ai.aiConfigured.value) ensureSession().connect(ai.llmConfig());
          else disconnectNow();
        } else if (!manualDisconnect.value && ai.aiConfigured.value) {
          connectNow();
        }
      },
    );

  /** Ask the assistant; binds the saved session first when needed. */
  async function ask(text: string): Promise<void> {
    const instruction = text.trim();
    if (!instruction || running.value) return;
    try {
      options.host.workspace();
    } catch {
      error.value = "No project is open.";
      return;
    }
    if (!connected.value && !connectNow()) {
      error.value = "Connect AI first.";
      return;
    }
    error.value = undefined;
    acceptNote.value = undefined;
    undoNote.value = undefined;
    turns.value = [...turns.value, { role: "creator", text: instruction }];
    const sessionNow = ensureSession();
    const context = options.host.editorContext();
    let result: ProjectAssistResult;
    try {
      result = await sessionNow.request({
        instruction,
        ...(context !== undefined ? { context } : {}),
      });
    } catch (failure) {
      error.value = reason(failure);
      return;
    }
    // A workspace swap or disconnect closed this session while the request
    // was in flight — its result belongs to a revoked authority and shows
    // nothing in the new project's panel.
    if (session !== sessionNow) return;
    lastResult.value = result;
    if (result.text) turns.value = [...turns.value, { role: "ai", text: result.text }];
    switch (result.outcome) {
      case "review":
      case "stale":
        pending.value = result.proposal ?? null;
        applied.value = null;
        break;
      case "applied":
        pending.value = null;
        applied.value = result.proposal
          ? {
              label: result.label ?? result.proposal.label,
              keys: result.keys,
              handle: result.proposal,
            }
          : null;
        if (result.transaction)
          lastTransaction.value = {
            id: result.transaction.id,
            label: result.transaction.label,
            keys: result.transaction.keys,
            undone: false,
          };
        options.host.onDraftChanged(result.keys);
        break;
      case "refused":
        pending.value = null;
        error.value = result.text || "The proposal was refused.";
        break;
      case "none":
      case "cancelled":
        pending.value = null;
        break;
    }
    tick.value++;
  }

  function stop(): void {
    session?.stop();
  }
  function cancel(): void {
    session?.cancel();
  }
  function resume(): void {
    session?.resume();
  }

  /** Explicit approval policy. Auto needs an exact document-key scope. */
  function setApproval(mode: ProjectAssistApproval): void {
    try {
      ensureSession().setApprovalMode(mode);
    } catch (failure) {
      error.value = reason(failure);
    }
    tick.value++;
  }

  /** Approve the pending proposal: one atomic draft transaction. */
  function accept(): boolean {
    const handle = pending.value;
    if (!handle || !session) return false;
    const outcome = session.acceptProposal(handle);
    if (!outcome.ok) {
      acceptNote.value = outcome.message;
      tick.value++;
      return false;
    }
    lastTransaction.value = {
      id: outcome.transaction.id,
      label: outcome.label,
      keys: outcome.keys,
      undone: false,
    };
    applied.value = { label: outcome.label, keys: outcome.keys, handle };
    pending.value = null;
    acceptNote.value = undefined;
    options.host.onDraftChanged(outcome.keys);
    tick.value++;
    return true;
  }

  /** Release the pending proposal; the draft is untouched. */
  function reject(): void {
    const handle = pending.value;
    if (!handle || !session) return;
    session.rejectProposal(handle);
    pending.value = null;
    acceptNote.value = undefined;
    tick.value++;
  }

  /** Atomically undo the last accepted agent transaction; conflicts refuse. */
  function undoChanges(): boolean {
    const held = lastTransaction.value;
    if (!held || held.undone) return false;
    let draft: ProjectDraft;
    try {
      draft = options.host.workspace().draft;
    } catch {
      undoNote.value = "No project is open.";
      return false;
    }
    try {
      draft.undo(held.id);
    } catch (failure) {
      // A later manual edit conflicts — report it, never force a rollback.
      undoNote.value = reason(failure);
      return false;
    }
    lastTransaction.value = { ...held, undone: true };
    undoNote.value = undefined;
    options.host.onDraftChanged(held.keys);
    return true;
  }

  function redoChanges(): boolean {
    const held = lastTransaction.value;
    if (!held || !held.undone) return false;
    let draft: ProjectDraft;
    try {
      draft = options.host.workspace().draft;
    } catch {
      undoNote.value = "No project is open.";
      return false;
    }
    try {
      draft.redo(held.id);
    } catch (failure) {
      undoNote.value = reason(failure);
      return false;
    }
    lastTransaction.value = { ...held, undone: false };
    undoNote.value = undefined;
    options.host.onDraftChanged(held.keys);
    return true;
  }

  onScopeDispose(() => {
    session?.close();
    session = undefined;
  });

  return {
    state,
    phase,
    connected,
    running,
    steps,
    turns,
    status,
    budget,
    pending,
    pendingStale,
    applied,
    lastResult,
    lastTransaction,
    autoEligible,
    manualDisconnect,
    error,
    undoNote,
    acceptNote,
    connectNow,
    disconnectNow,
    ask,
    stop,
    cancel,
    resume,
    setApproval,
    accept,
    reject,
    undoChanges,
    redoChanges,
    onWorkspaceSwapped,
  };
}

export type LogicProjectAssist = ReturnType<typeof useLogicProjectAssist>;

/**
 * Ask the AI about a Studio selection (Room Studio and Sprite Studio). The
 * creator selects something, asks for a change to just that, and the game's
 * session proposes a candidate (AgentSession.runStudioAssist). The candidate
 * is data: the Studio previews it on its canvas and, on Accept, adopts it as
 * one undo step through its draft, which checks it again (the scope and the
 * locks a manual edit passes). Reject, Stop and a declined request leave the
 * draft untouched.
 *
 * States: idle → running → candidate | declined (the AI proposed nothing
 * and said why) | stopped | failed; a candidate ends accepted or rejected.
 * A candidate whose base revision no longer matches the draft is stale: it
 * cannot be accepted. "Ask again…" sends a follow-up on the same selection,
 * continuing the conversation shown as the thread.
 */

import { computed, onScopeDispose, ref, shallowRef } from "vue";
import type { StudioCandidate, StudioFocus } from "../../../src/agent/studioAssistTools.ts";
import {
  draftRevision,
  type AssistDraft,
  type AssistScope,
} from "../../../src/studio/assistScope.ts";
import type { AgentLogEntry } from "../agent/agentLog.ts";
import type { AgentRunState } from "../agent/agentRun.ts";
import type { StudioAssistRequest, StudioAssistResult } from "../agent/studioAssist.ts";
import { ResourceCommitError } from "../project/projectTransaction.ts";

/** Where requests run: the game's session, through the engine. */
export interface StudioAssistHost {
  run(request: StudioAssistRequest): Promise<StudioAssistResult>;
  /** Stop and discard the running request. */
  cancel(): void;
  /** Continue a request paused at its budget. */
  resume(): void;
  task(): AgentRunState | null;
  /** The agent log the request's activity streams into. */
  log(): readonly AgentLogEntry[];
}

export type AssistPhase =
  "idle" | "running" | "candidate" | "declined" | "accepted" | "rejected" | "stopped" | "failed";

export interface AssistTurn {
  readonly role: "creator" | "ai";
  readonly text: string;
}

type AssistOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface StudioAssistOptions {
  /** Null where no AI can run (the Studio harness). */
  readonly host: () => StudioAssistHost | null;
  /** An AI provider is connected. */
  readonly configured: () => boolean;
  /** Editing is blocked (view only, or a Keep that needs a reload). */
  readonly frozen: () => boolean;
  /** Something that can be asked about is selected. */
  readonly selected: () => boolean;
  /** The focus of the current selection, built per request; null when nothing can be asked about. */
  readonly focus: () => StudioFocus | null;
  /** The draft as it stands. */
  readonly current: () => AssistDraft;
  /** Adopt the candidate as one undo step (the draft checks it again). */
  readonly apply: (candidate: StudioCandidate, focus: StudioFocus) => AssistOutcome;
}

export const STALE_TEXT = "You changed the picture while the AI worked. Ask again.";
/** Why the lens and the unlocks wait while a request runs or its proposal awaits a verdict. */
export const HOLD_TEXT = "Finish or reject the AI's proposal first";
export const STALE_VIEW_TEXT = "You changed the view while the AI worked. Ask again.";

type Violation = { readonly constraint?: string; readonly plane?: string };

/** A refused proposal's reasons in the creator's words. */
export function refusalWords(violations: readonly Violation[]): string {
  const locked = new Set(
    violations.flatMap((v) => (v.constraint === "locked-plane" ? [v.plane] : [])),
  );
  const words = violations.flatMap((v) => {
    switch (v.constraint) {
      case "locked-plane":
        return [v.plane === "visual" ? "would change the art" : "would change the depth"];
      case "outside-mask":
        return locked.has(v.plane) ? [] : ["would change things outside the selection"];
      case "fill-spill":
        return locked.has(v.plane) ? [] : ["would spill a fill outside the selection"];
      case "extra-copy":
        return locked.has(v.plane)
          ? []
          : ["would copy the selection more than once, or in other colours"];
      case "outside-target":
        return ["would change things outside the selection"];
      case "walk-depth":
        return ["would change depth values"];
      case "protected-loop":
        return ["would change a protected loop"];
      case "max-bytes":
        return ["would be too big"];
      case "stale-base":
        return ["the draft changed"];
      case "unknown-target":
        return ["the selection is out of date"];
      default:
        return ["didn't pass the checks"];
    }
  });
  return [...new Set(words.length ? words : ["didn't pass the checks"])].join(" and ");
}

const STUDIO = "[Studio] ";

/**
 * The request's activity from its log entries, compactly: reading the
 * selection, each proposal and each refusal ("Refused: would change the art;
 * trying again" when another proposal followed).
 */
export function assistSteps(entries: readonly AgentLogEntry[]): string[] {
  const steps: { text: string; refused: boolean }[] = [];
  for (const entry of entries) {
    if (!entry.detail.startsWith(STUDIO)) continue;
    const rest = entry.detail.slice(STUDIO.length);
    if (entry.kind === "request" && rest === "read_edit_context")
      steps.push({ text: "Reading the selection…", refused: false });
    else if (entry.kind === "request" && rest === "propose_edit")
      steps.push({ text: "Proposing…", refused: false });
    else if (rest.startsWith("propose_edit -> ")) {
      const last = steps.at(-1);
      if (!last) continue;
      if (entry.kind === "error") {
        const data = entry.data as
          { result?: { details?: { violations?: readonly Violation[] } } } | undefined;
        last.text = `Refused: ${refusalWords(data?.result?.details?.violations ?? [])}`;
        last.refused = true;
      } else last.text = "Proposed a change";
    } else if (rest.startsWith("read_edit_context -> ")) {
      const last = steps.at(-1);
      if (last && entry.kind !== "error") last.text = "Read the selection";
    }
  }
  return steps.map(({ text, refused }, index) =>
    refused && index < steps.length - 1 ? `${text}; trying again` : text,
  );
}

/** A stable key for a scope's selection: a follow-up continues the thread only on the same one. */
function scopeKey(scope: AssistScope): string {
  return scope.kind === "picture"
    ? `picture ${scope.num}: ${[...scope.targetIds].sort().join(",")}`
    : `view ${scope.num}: ${scope.targetCels.map(({ loop, cel }) => `${loop}.${cel}`).join(",")}`;
}

export function useStudioAssist(options: StudioAssistOptions) {
  const phase = ref<AssistPhase>("idle");
  const candidate = shallowRef<StudioCandidate | null>(null);
  /** The focus the last request was made with. */
  const asked = shallowRef<StudioFocus | null>(null);
  /** The AI's closing sentence. */
  const reply = ref("");
  /** Why the last action failed, in plain words. */
  const error = ref("");
  /**
   * The last request failed because the project moved past the running game
   * (a newer save elsewhere): only reloading the game from storage continues.
   */
  const behindStorage = ref(false);
  /** The conversation about the current selection. */
  const thread = ref<AssistTurn[]>([]);
  let threadKey = "";
  /** Log entries after this sequence number belong to the request. */
  const startSeq = ref(Number.POSITIVE_INFINITY);
  let runId = 0;
  let stopping = false;

  const running = computed(() => phase.value === "running");
  /** Studio editing pauses while a request runs or a candidate awaits a verdict. */
  const holds = computed(() => phase.value === "running" || phase.value === "candidate");
  const stale = computed(
    () =>
      phase.value === "candidate" &&
      candidate.value !== null &&
      draftRevision(options.current()) !== candidate.value.baseRevision,
  );
  /** Why nothing can be asked right now; null when it can. */
  const blocked = computed<"unavailable" | "connect" | "frozen" | "selection" | null>(() => {
    if (!options.host()) return "unavailable";
    if (!options.configured()) return "connect";
    if (options.frozen()) return "frozen";
    if (!options.selected()) return "selection";
    return null;
  });
  const steps = computed(() => {
    const host = options.host();
    if (!host) return [];
    const since = startSeq.value;
    return assistSteps(host.log().filter((entry) => (entry.seq ?? 0) > since));
  });
  const task = computed(() => options.host()?.task() ?? null);
  /** One line for the live region: the latest step, or what the model is doing. */
  const status = computed(() => {
    if (!running.value) return "";
    const progress = task.value?.progress;
    const last = steps.value.at(-1);
    if (task.value?.status === "paused") return task.value.reason;
    if (last?.endsWith("…")) return last;
    if (last?.startsWith("Refused")) return `${last}; trying again`;
    if (progress?.phase === "thinking") return "Thinking…";
    if (progress?.phase === "text") return "Writing…";
    return last ? "Finishing…" : "Waiting for the model…";
  });
  /** The budget left for the request. */
  const budget = computed(() => {
    const state = task.value;
    if (!state) return "";
    if (!state.priceKnown) return `Budget $${state.budget.toFixed(2)} · usage estimate unavailable`;
    return `$${Math.max(0, state.budget - state.spent).toFixed(2)} of $${state.budget.toFixed(2)} left`;
  });

  /**
   * Send `text` about the selection; `referenceIds` names stored reference
   * art the creator attached, which rides the request as handles.
   */
  async function ask(text: string, referenceIds: readonly string[] = []): Promise<void> {
    const instruction = text.trim();
    const host = options.host();
    if (!instruction || running.value || !host || blocked.value !== null) return;
    const focus = options.focus();
    if (!focus) return;
    const key = scopeKey(focus.scope);
    if (key !== threadKey) {
      thread.value = [];
      threadKey = key;
    }
    thread.value = [...thread.value, { role: "creator", text: instruction }];
    candidate.value = null;
    reply.value = "";
    error.value = "";
    behindStorage.value = false;
    asked.value = focus;
    startSeq.value = host.log().at(-1)?.seq ?? 0;
    stopping = false;
    phase.value = "running";
    const id = ++runId;
    try {
      const result = await host.run(
        referenceIds.length ? { instruction, focus, referenceIds } : { instruction, focus },
      );
      if (id !== runId) return;
      reply.value = result.text;
      thread.value = [...thread.value, { role: "ai", text: result.text }];
      candidate.value = result.candidate;
      phase.value = result.candidate ? "candidate" : "declined";
    } catch (failure) {
      if (id !== runId) return;
      if (stopping) phase.value = "stopped";
      else {
        error.value =
          failure instanceof ResourceCommitError
            ? failure.message
            : String(failure).replace(/^Error: /, "");
        behindStorage.value = failure instanceof ResourceCommitError && failure.behindStorage;
        phase.value = "failed";
      }
    }
  }

  /** Stop the running request: nothing it proposed is kept. */
  function stop(): void {
    if (!running.value) return;
    stopping = true;
    options.host()?.cancel();
  }

  function resume(): void {
    options.host()?.resume();
  }

  /** Adopt the candidate as one undo step; false (with the reason) when it cannot be. */
  function accept(): boolean {
    const proposed = candidate.value;
    const focus = asked.value;
    if (phase.value !== "candidate" || !proposed || !focus) return false;
    if (stale.value) {
      error.value = proposed.kind === "picture" ? STALE_TEXT : STALE_VIEW_TEXT;
      return false;
    }
    const outcome = options.apply(proposed, focus);
    if (!outcome.ok) {
      error.value = outcome.message;
      return false;
    }
    error.value = "";
    candidate.value = null;
    phase.value = "accepted";
    return true;
  }

  /** Drop the candidate: the draft stays as it is. */
  function reject(): void {
    if (phase.value !== "candidate") return;
    candidate.value = null;
    error.value = "";
    phase.value = "rejected";
  }

  // Leaving Studio mid-request stops it.
  onScopeDispose(() => {
    runId++;
    if (running.value) options.host()?.cancel();
  });

  return {
    phase,
    candidate,
    asked,
    reply,
    error,
    behindStorage,
    thread,
    running,
    holds,
    stale,
    blocked,
    steps,
    status,
    budget,
    task,
    ask,
    stop,
    resume,
    accept,
    reject,
  };
}

export type StudioAssist = ReturnType<typeof useStudioAssist>;

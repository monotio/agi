import { inspectedResourceKeys, resourceRenderingDependencies } from "./agentResults.ts";
import type { ProjectContent } from "../../../src/authoring/projectContent.ts";
import { beginProviderTask } from "./providerBudget.ts";
/** One task-chat adapter; ProjectSession remains the sole project writer. */
import { DEFAULT_TASK_BUDGET_USD, AgentRun, type AgentRunState } from "./agentRun.ts";
import {
  createAnthropicConversation,
  createOpenAiConversation,
  LlmResponseError,
  LlmRefusalError,
  type LlmConfig,
  type UnifiedConversation,
} from "./llmClient.ts";
import { createProjectAssistDriver, PROJECT_ASSIST_TOOLS } from "./projectAssistTools.ts";
import {
  ASK_TOOLS,
  validateAgentHandover,
  withReferences,
  executeAgentToolAsync,
  type AgentRuntimeDeps,
} from "../../../src/agent/tools.ts";
import { referenceManifest } from "../../../src/agent/referenceTools.ts";
import { captureAgentWorkspace } from "../../../src/authoring/projectAgentCandidate.ts";
import { createProjectInspection } from "../../../src/agent/projectInspection.ts";
import { computeResourceRevision } from "../../../src/authoring/resourceRevision.ts";
import { compileProjectDocuments } from "../../../src/authoring/projectDocuments.ts";
import { ProjectModel } from "../../../src/authoring/projectModel.ts";
import {
  diffProjectDocuments,
  projectDocumentId,
  sameProjectContent,
} from "../../../src/authoring/projectContent.ts";
import {
  readProjectWorkspace,
  writeProjectWorkspace,
} from "../../../src/authoring/projectWorkspace.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import { ProjectDraft } from "../../../src/authoring/projectDraft.ts";
import { validateToolArguments } from "../../../src/agent/schemaValidate.ts";
import type { ProjectChange } from "../../../src/authoring/projectContent.ts";
import type { ImageFrame } from "../../../src/creative/imageOperations.ts";
import { PROFILES } from "../../../src/runtime/profile.ts";
import { parseWordsTok } from "../../../src/logic/words.ts";
import { disassembleLogic } from "../../../src/logic/disassembler.ts";
import { disassemblePicture } from "../../../src/picture/source.ts";
import type { ProjectProposal } from "../../../src/authoring/projectModel.ts";
import type { ProjectSession } from "../project/projectSession.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import {
  readAgentChats,
  chatTitle,
  type AgentChat,
  type AgentRequest,
  type AgentResult,
  type PendingAgentReview,
} from "../../../src/agent/chats.ts";
import type { AgentToolResult } from "../../../src/agent/agentState.ts";
import { VOCABULARY_ACTIONS } from "../../../src/vocabulary.ts";
import { WORKSPACE_AGENT_TOOLS } from "./workspaceAgentTools.ts";
import type { ToolDefinition } from "../../../src/agent/tools.ts";

import { workspaceSelection, selectionScene } from "./workspaceSelection.ts";
import { createSelectionStub } from "./selectionStub.ts";
import { SELECTION_TOOL_NAMES } from "../../../src/agent/selectionTools.ts";
import { proposeNames } from "../../../src/agent/namingTools.ts";

const HANDOFF =
  "Summarize this task for a different model using the compaction summary pattern: objective, decisions, completed changes, unresolved work, resource identifiers, and next steps. Return only the summary. Preserve user constraints. Omit thinking blocks, credentials and protocol records.";
export interface AgentReview {
  readonly proposal: ProjectProposal;
  readonly chatId: string;
  readonly messageId: string;
  changes(): ReturnType<ProjectProposal["changes"]>;
  stale(): boolean;
}
export type ReplyFormatter = (reply: string) => {
  text: string;
  context?: string;
  result?: AgentResult;
};
export interface AgentSubmission extends AgentTurnContext {
  readonly instruction: string;
  readonly context?: string;
  readonly mode: "play" | "create";
  readonly readOnly?: boolean;
  readonly formatReply?: ReplyFormatter;
}
export interface WorkspaceAgentRuntime extends AgentRuntimeDeps {
  /** Authorize only the revision produced by this task's own admission. */
  readonly advanceRevision?: (before: string, after: string, nativeAdmission: boolean) => void;
}
export interface AgentTurnContext {
  readonly mode?: "play" | "create";
  readonly profileId?: ProfileId;
  readonly runtime?: () => WorkspaceAgentRuntime;
}
export type ConversationSession = Pick<
  ProjectSession,
  | "allowMissingRooms"
  | "chats"
  | "closed"
  | "flush"
  | "history"
  | "model"
  | "restore"
  | "saveChats"
  | "submit"
  | "subscribe"
  | "undo"
  | "workingSnapshot"
>;
interface Options {
  readonly session: ConversationSession;
  readonly readOnly?: boolean;
  readonly profileId: ProfileId;
  readonly config: () => LlmConfig;
  readonly conversation?: (
    config: LlmConfig,
    transcript: unknown[],
    run: AgentRun,
    catalog?: readonly ToolDefinition[],
    sessionId?: string,
  ) => UnifiedConversation;
  readonly runtime?: () => WorkspaceAgentRuntime;
  readonly changed?: () => void;
  readonly beforeApprove?: () => Promise<void>;
}
function conversation(
  config: LlmConfig,
  transcript: unknown[],
  run: AgentRun,
  catalog: readonly ToolDefinition[] = WORKSPACE_AGENT_TOOLS,
  sessionId?: string,
): UnifiedConversation {
  if (config.provider === "openai")
    return createOpenAiConversation(config, transcript, sessionId, run, catalog);
  if (config.provider === "anthropic")
    return createAnthropicConversation(config, transcript, run, catalog, sessionId);
  return stubConversation(transcript);
}
/** Offline authoring uses real validation and admission, with a deterministic resource edit. */
function stubConversation(initial: unknown[]): UnifiedConversation {
  const transcript = [...initial];
  let step = 0;
  let prompt = "";
  let context: Record<string, unknown> = {};
  let selected: UnifiedConversation | undefined;
  return {
    setAvailableTools() {},
    async sendUserMessage(text, images) {
      if (text.includes("Selection: PICTURE") || text.includes("Selection: VIEW")) {
        selected = createSelectionStub(text.split("Request:\n").at(-1) ?? text, transcript);
        return selected.sendUserMessage(text, images);
      }
      prompt = text;
      if (text.startsWith("Answer questions about this game")) {
        const reply = text.includes('Return a JSON object {"synonyms"')
          ? '{"synonyms":["inspect","check"]}'
          : text.includes('Return a JSON object {"commands"')
            ? '{"commands":["look tree","climb tree"]}'
            : "This test provider can inspect the game; connect a model for hints and debugging.";
        transcript.push({ role: "user", text }, { role: "assistant", text: reply });
        return { text: reply, toolCalls: [] };
      }
      step = 0;
      transcript.push({ role: "user", text });
      return {
        text: "Plan: inspect the project, then prepare the changes.",
        toolCalls: [{ id: "context", name: "read_project_context", input: {} }],
      };
    },
    appendToolResults(results) {
      if (selected) return selected.appendToolResults(results);
      for (const entry of results) {
        transcript.push({ role: "assistant", text: JSON.stringify(entry) });
        if (entry.result.details?.["documents"]) context = entry.result.details;
      }
    },
    async complete() {
      if (selected) return selected.complete();
      if (/launch|vacuum death/i.test(prompt)) {
        if (step++ === 0) {
          const roomMatch = /room\s*(\d+)/i.exec(prompt);
          const room = roomMatch ? Number(roomMatch[1]) : 8;
          return {
            toolCalls: [
              {
                id: "launch",
                name: "configure_launch",
                input: {
                  room,
                  action: "create",
                  name: "Vacuum death",
                  cameFrom: { room: 7, edge: 4 },
                  flags: [{ id: 77, value: true }],
                  variables: [{ id: 90, value: 123 }],
                  selected: true,
                },
              },
            ],
          };
        }
        const text = "Created a launch for the vacuum death in Room 8.";
        transcript.push({ role: "assistant", text });
        return { text, toolCalls: [] };
      }
      if (step++ === 0) {
        const docs = context["documents"] as { key: string }[] | undefined;
        const picture = docs?.find((d) => d.key.startsWith("picture:"))?.key;
        const room = /Current room (\d+)/.exec(prompt)?.[1];
        const logic =
          docs?.find((d) => d.key === `logic:${room}`)?.key ??
          docs?.find((d) => d.key.startsWith("logic:") && d.key !== "logic:0")?.key;
        if (!picture || !logic) return { text: "The project is ready for a task.", toolCalls: [] };
        return {
          toolCalls: [
            {
              id: "logic",
              name: "read_document",
              input: { key: logic, offset: null, limit: null },
            },
            {
              id: "picture",
              name: "read_document",
              input: { key: picture, offset: null, limit: null },
            },
            ...(prompt.includes("look at sign")
              ? [
                  {
                    id: "words",
                    name: "read_document",
                    input: { key: "words", offset: null, limit: null },
                  },
                ]
              : []),
          ],
        };
      }
      if (step === 2) {
        const reads = transcript
          .filter((item) => item && typeof item === "object" && "text" in item)
          .map((item) => {
            try {
              return JSON.parse((item as { text: string }).text) as { result?: AgentToolResult };
            } catch {
              return {};
            }
          })
          .filter((item) => item.result?.details?.["key"]);
        const signResponse = prompt.includes("look at sign");
        const changes = reads.slice(signResponse ? -3 : -2).map((item) => {
          const r = item.result!;
          const key = String(r.details!["key"]);
          const bytes =
            r.details!["kind"] === "bytes"
              ? Uint8Array.from(atob(String(r.details!["base64"])), (char) => char.charCodeAt(0))
              : undefined;
          const text =
            bytes && key.startsWith("logic:")
              ? disassembleLogic(bytes)
              : bytes && key.startsWith("picture:")
                ? disassemblePicture(bytes)
                : (r.message?.split(":\n").slice(1).join(":\n") ?? "");
          if (signResponse && key === "words") {
            const entries: [string, number][] = bytes
              ? parseWordsTok(bytes).map(({ word, id }) => [word, id])
              : JSON.parse(text);
            if (!entries.some(([word]) => word === "at")) entries.push(["at", 0]);
            if (!entries.some(([word]) => word === "sign"))
              entries.push(["sign", Math.max(1, ...entries.map(([, group]) => group)) + 1]);
            return { key, content: JSON.stringify(entries) };
          }
          if (signResponse && key.startsWith("logic:"))
            return {
              key,
              content: 'if (said("look", "sign")) { print("Welcome sign"); }\n' + text,
            };
          return {
            key,
            content: key.startsWith("logic:")
              ? /#message/.test(text)
                ? text.replace(/#message (\d+) "[^"]*"/, '#message $1 "Welcome sign"')
                : text.replace(/print\("(?:[^"\\]|\\.)*"\)/, 'print("Welcome sign")')
              : text.replace(/vis \d+/, "vis 4"),
          };
        });
        return {
          toolCalls: [
            {
              id: "proposal",
              name: "propose_changes",
              input: { label: chatTitle(prompt.split("Request:\n")[1] ?? "Welcome sign"), changes },
            },
          ],
        };
      }
      const text = "Added a welcome sign.";
      transcript.push({ role: "assistant", text });
      return { text, toolCalls: [] };
    },
    recordInterruption(text) {
      if (selected) return selected.recordInterruption?.(text);
      transcript.push({ role: "user", text });
    },
    getTranscript() {
      return selected?.getTranscript() ?? structuredClone(transcript);
    },
  };
}
let sequence = 0;
const owned = new WeakMap<
  ConversationSession,
  { agent: ReturnType<typeof createWorkspaceAgent>; options: Options }
>();
export function borrowWorkspaceAgent(options: Options) {
  const existing = owned.get(options.session);
  if (existing) {
    if (options.beforeApprove)
      Object.assign(existing.options, { beforeApprove: options.beforeApprove });
    return existing.agent;
  }
  const agent = createWorkspaceAgent(options);
  owned.set(options.session, { agent, options });
  return agent;
}
export function createWorkspaceAgent(options: Options) {
  const session = options.session;
  const store = session.chats();
  let review: AgentReview | null = null;
  const reviews = new Map<string, AgentReview>();
  for (const chat of store.chats) {
    const pending = chat.pendingReview;
    if (!pending) continue;
    const currentImage = session.model.capture().lastAdmissibleBuild!;
    const files = Object.fromEntries(currentImage.files());
    let invalidBase = false;
    let build;
    try {
      build = compileProjectDocuments({
        files,
        documents: readProjectWorkspace(pending.baseImage ?? pending.base),
        profileId: options.profileId,
      });
    } catch {
      invalidBase = true;
      build = compileProjectDocuments({
        files,
        documents: currentImage.documents(),
        profileId: options.profileId,
      });
    }
    const model = new ProjectModel({
      documents: readProjectWorkspace(pending.base),
      digest: sha256Hex,
      build,
    });
    const base = model.capture();
    const proposal = model.propose(
      base,
      pending.label,
      diffProjectDocuments(base.documents(), readProjectWorkspace(pending.candidate)),
    );
    reviews.set(chat.id, {
      proposal,
      chatId: chat.id,
      messageId: pending.messageId,
      changes: () => proposal.changes(),
      stale: () =>
        invalidBase ||
        base.documentId !== pending.baseDocumentId ||
        session.model.capture().documentId !== pending.baseDocumentId ||
        session.history.capture().cursor !== pending.baseCommit,
    });
  }
  review = store.active === null ? null : (reviews.get(store.active) ?? null);
  let activeRun: AgentRun | null = null;
  let activeRequest: AgentRequest | null = null;
  let nextSteps: { id: string; text: string }[] = [];
  let acceptingSteps = false;
  const completedRuns = new Map<string, AgentRunState>();
  let autoApprove = false;
  const reviewOutcomes = new Map<string, string>();
  let error = "";
  let chatSaveError = "";
  let busy = false;
  let applying = false;
  let actionQueue: string[] | null = null;
  let actionChat: string | null = null;
  let appliedDuringRun:
    { resources: readonly string[]; documentId: string; commit: string | null }[] | null = null;
  const progress: string[] = [];
  const observers = new Set<() => void>();
  const knownChats = new Set(store.chats.map((chat) => chat.id));
  function syncTasks() {
    for (const chat of session.chats().chats)
      if (!knownChats.has(chat.id)) {
        store.chats.push(chat);
        knownChats.add(chat.id);
      }
  }
  const notify = () => {
    options.changed?.();
    for (const observer of observers) observer();
  };
  const id = () => `chat-${Date.now()}-${++sequence}`;
  const save = async () => {
    syncTasks();
    await session.saveChats(store);
    notify();
  };
  function action(chat: AgentChat, decision: string, details: Record<string, unknown> = {}) {
    const snapshot = session.model.capture();
    const text = JSON.stringify({
      format: "monotio.agi.user-action",
      version: 1,
      decision,
      resultingRevision: {
        documentId: snapshot.documentId,
        revision: snapshot.revision,
        commit: session.history.capture().cursor,
      },
      ...details,
    });
    if (actionQueue !== null && busy && chat.id === actionChat) actionQueue.push(text);
    else
      chat.transcript.push({
        role: "user",
        ...(chat.provider === "stub" ? { text } : { content: text }),
      });
  }
  function newChat(title = "New chat", background = false): AgentChat {
    if ((busy || applying) && !background)
      throw new Error("Finish the current task before starting a chat.");
    const config = options.config();
    const chat: AgentChat = {
      id: id(),
      title,
      provider: config.provider,
      model: config.model,
      transcript: [],
      messages: [],
      sessionId: crypto.randomUUID(),
      ...(background ? { background: true } : {}),
    };
    knownChats.add(chat.id);
    store.chats.push(chat);
    if (!background) {
      store.active = chat.id;
      review = null;
    }
    void save()
      .then(() => session.flush())
      .catch((cause) => {
        chatSaveError = "Saving the conversation failed. Retry save.";
        progress.push(cause instanceof Error ? cause.message : String(cause));
        notify();
      });
    return chat;
  }
  session.subscribe(() => {
    if (session.closed) activeRun?.cancel();
    else syncTasks();
    notify();
  });
  if (store.active === null) newChat();
  function current(): AgentChat {
    return structuredClone(store.chats.find((chat) => chat.id === store.active)!);
  }
  function assertLive() {
    activeRun?.assertActive();
    if (session.closed) throw new Error("The project session was closed.");
  }
  async function approve(
    keys?: readonly string[],
    automatic = false,
    taskRuntime?: WorkspaceAgentRuntime,
  ) {
    const approving = review;
    if (approving === null || applying) return;
    applying = true;
    notify();
    try {
      await options.beforeApprove?.();
      if (approving.stale())
        throw new Error(
          "The project changed while the agent worked. Send a follow-up to revise these changes.",
        );
      const changes = approving
        .changes()
        .filter((change) => keys === undefined || keys.includes(change.key));
      if (changes.length === 0) throw new Error("Select a change to approve.");
      const proposal = session.model.propose(
        session.model.capture(),
        approving.proposal.label,
        changes,
      );
      // Selection is revalidated as a complete project before entering MAIN.
      const draft = new ProjectDraft(proposal.documents());
      const ws = captureAgentWorkspace({
        draft,
        files: Object.fromEntries(session.model.capture().lastAdmissibleBuild!.files()),
        profileId: options.profileId,
        allowMissingRooms: session.allowMissingRooms,
      });
      ws.propose("Validate selection", []);
      const validatedState = ws.openToolState().state;
      const verdict = validateAgentHandover(validatedState);
      if (!verdict.success) throw new Error(verdict.error ?? "Handover rejected.");
      const before = session.history.capture().cursor!;
      const beforeRevision = proposal.base.lastAdmissibleBuild!.identity.revision;
      const admittedRevision = computeResourceRevision(
        Object.fromEntries(validatedState.getFiles()),
      );
      assertLive();
      const result = await session.submit({
        proposal,
        beforeCommit: assertLive,
        label: `AI: ${proposal.label}`,
        origin: "agent",
        author: "agent",
        chatId: approving.chatId,
        messageId: approving.messageId,
      });
      if (!["committed", "unchanged", "restartRequired"].includes(result.status))
        throw new Error("The changes could not be applied. Check Problems and revise them.");
      taskRuntime?.advanceRevision?.(
        beforeRevision,
        admittedRevision,
        result.status !== "restartRequired",
      );
      const commit = session.history.capture().cursor!;
      const chat = store.chats.find((chat) => chat.id === approving.chatId)!;
      chat.messages = chat.messages.map((message) =>
        message.id === approving.messageId
          ? {
              ...message,
              beforeCommit: before,
              commit,
              result: {
                kind: "changes",
                documentId: session.model.capture().documentId,
                resources: changes.map((change) => change.key),
                status: "applied",
              },
            }
          : message,
      );
      reviewOutcomes.set(approving.messageId, automatic ? "Applied automatically" : "Applied");
      action(chat, "approve", {
        resources: changes.map((change) => change.key),
        outcome: result.status,
      });
      if (chat.id === actionChat)
        appliedDuringRun?.push({
          resources: changes.map((change) => change.key),
          documentId: session.model.capture().documentId,
          commit,
        });
      delete chat.pendingReview;
      reviews.delete(approving.chatId);
      if (review === approving) review = null;
      notify();
      await save();
      return commit;
    } finally {
      applying = false;
      notify();
    }
  }
  async function drive(
    chat: AgentChat,
    instruction: string,
    context: string,
    readOnly = false,
    automatic = false,
    formatReply?: ReplyFormatter,
    turnContext: AgentTurnContext = {},
  ) {
    if (session.closed) throw new Error("The project session was closed.");
    if (busy || applying) throw new Error("Wait for the current task to finish.");
    readOnly ||= options.readOnly === true;
    const profileId = turnContext.profileId ?? options.profileId;
    if (!PROFILES[profileId]) throw new Error(`Unknown AGI profile: ${profileId}`);
    busy = true;
    error = "";
    progress.length = 0;
    let base = readOnly ? session.workingSnapshot() : session.model.capture();
    let workspace = readOnly
      ? undefined
      : captureAgentWorkspace({
          draft: new ProjectDraft(base.documents()),
          files: Object.fromEntries(base.lastAdmissibleBuild!.files()),
          profileId,
          allowMissingRooms: session.allowMissingRooms,
        });
    let staged: ReturnType<ReturnType<typeof captureAgentWorkspace>["openToolState"]> | undefined;
    let inspection: ReturnType<typeof createProjectInspection> | undefined;
    function editWorkspace() {
      if (!workspace) throw new Error("Editing is unavailable during inspection.");
      return workspace;
    }
    let notes: string | undefined;
    const prepared = new Map<string, ProjectChange>();
    let scene: Awaited<ReturnType<typeof selectionScene>> = {};
    let selection = readOnly
      ? undefined
      : workspaceSelection(context, base.documents(), PROFILES[profileId]!, scene);
    function projectDriver() {
      if (readOnly)
        return createProjectAssistDriver({
          base,
          profileId,
          get diagnostics() {
            return inspection?.diagnostics ?? [];
          },
          documents: () => base.documents(),
        });
      const captured = editWorkspace();
      return createProjectAssistDriver({
        ...captured,
        propose(label, changes) {
          const coordinated =
            notes === undefined
              ? changes
              : [
                  ...changes.filter((change) => change.key !== "notes"),
                  { key: "notes", content: notes },
                ];
          const combined = [
            ...new Map(
              [...prepared.values(), ...coordinated].map((change) => [change.key, change]),
            ).values(),
          ];
          return staged ? staged.finish(label, combined) : captured.propose(label, combined);
        },
      });
    }
    let driver = projectDriver();
    let selectionReview = "";
    let forceReview = false;
    function stagedDocuments() {
      const offered = driver.pending();
      const native = staged?.finish(chatTitle(instruction), offered?.changes() ?? []);
      const documents = { ...editWorkspace().documents() };
      for (const change of [
        ...prepared.values(),
        ...(native?.changes() ?? []),
        ...(offered?.changes() ?? []),
      ]) {
        if (change.content === null) delete documents[change.key];
        else documents[change.key] = change.content;
      }
      return documents;
    }
    function stageChanges(label: string, changes: readonly ProjectChange[]) {
      const offered = driver.pending();
      const native = staged?.finish(label, offered?.changes() ?? []);
      const combined = new Map(
        [
          ...prepared.values(),
          ...(native?.changes() ?? []),
          ...(offered?.changes() ?? []),
          ...changes,
        ].map((change) => [change.key, change]),
      );
      const checked = session.model.propose(base, label, [...combined.values()]);
      editWorkspace().propose(label, checked.changes());
      const next = captureAgentWorkspace({
        draft: new ProjectDraft(checked.documents()),
        files: Object.fromEntries(base.lastAdmissibleBuild!.files()),
        profileId,
        allowMissingRooms: session.allowMissingRooms,
      });
      const nextSelection = workspaceSelection(
        context,
        checked.documents(),
        PROFILES[profileId]!,
        scene,
      );
      prepared.clear();
      for (const change of checked.changes()) prepared.set(change.key, change);
      workspace = next;
      staged = undefined;
      selection = nextSelection;
      driver = projectDriver();
    }
    const config = options.config();
    if (!automatic) beginProviderTask(config.budgetUsd ?? DEFAULT_TASK_BUDGET_USD);
    const run = new AgentRun(config.model, () => notify(), config.budgetUsd);
    activeRun = run;
    const userId = id();
    const request: AgentRequest = {
      id: userId,
      mode: turnContext.mode ?? "create",
      capability: readOnly ? "inspect" : "edit",
      profileId,
      documentId: base.documentId,
      revision: base.revision,
      context,
    };
    activeRequest = request;
    nextSteps = [];
    acceptingSteps = true;
    chat.messages.push({
      id: userId,
      request,
      role: "user",
      text: instruction,
      ...(context ? { context } : {}),
    });
    if (chat.title === "New chat") chat.title = chatTitle(instruction);
    const make = options.conversation ?? conversation;
    let provider: UnifiedConversation | undefined;
    let unreported: { toolCallId: string; result: AgentToolResult }[] = [];
    actionQueue = [];
    actionChat = chat.id;
    const persisted: { resources: readonly string[]; documentId: string; commit: string | null }[] =
      [];
    appliedDuringRun = persisted;
    const touched = new Set<string>();
    const inspectedDocuments: Record<string, ProjectContent> = {};
    const inspectedDependencies: Record<string, ProjectContent> = {};
    const resourceSnapshots: Record<string, ReturnType<typeof writeProjectWorkspace>> = {};
    function flushActions() {
      for (const text of actionQueue ?? []) provider?.recordInterruption?.(text);
      actionQueue = [];
    }
    async function receiveNextSteps() {
      if (!nextSteps.length) return undefined;
      assertLive();
      const receiving = nextSteps;
      nextSteps = [];
      chat.messages = chat.messages.map((message) =>
        receiving.some((step) => step.id === message.id)
          ? { ...message, delivery: "received" }
          : message,
      );
      notify();
      return provider!.sendUserMessage(
        `Follow-up for the current task. Keep this turn's original capabilities and context. Reconsider pending changes before handover.\n${receiving.map((step) => step.text).join("\n\n")}`,
      );
    }
    let handedOver = false;
    let capturedRuntime: WorkspaceAgentRuntime = {};
    let failedSave: { cause: unknown } | undefined;
    async function offer(text: string) {
      assertLive();
      const offered = driver.pending();
      const native = staged?.finish(chatTitle(instruction), offered?.changes() ?? []);
      const combined = new Map(
        [...prepared.values(), ...(native?.changes() ?? []), ...(offered?.changes() ?? [])].map(
          (change) => [change.key, change],
        ),
      );
      if (notes !== undefined) combined.set("notes", { key: "notes", content: notes });
      const changes = [...combined.values()];
      if (!changes.length) return false;
      const candidate = captureAgentWorkspace({
        draft: new ProjectDraft(stagedDocuments()),
        files: Object.fromEntries(base.lastAdmissibleBuild!.files()),
        profileId,
        allowMissingRooms: session.allowMissingRooms,
      }).openToolState();
      const verdict = validateAgentHandover(candidate.state);
      if (!verdict.success) throw new Error(verdict.error ?? "Handover rejected.");
      editWorkspace().propose(chatTitle(instruction), changes);
      const proposal = session.model.propose(
        base,
        offered?.label ?? chatTitle(instruction),
        changes,
      );
      const messageId = id();
      chat.messages.push({
        id: messageId,
        role: "assistant",
        taskId: request.id,
        result: {
          kind: "changes",
          documentId: base.documentId,
          resources: changes.map((change) => change.key),
          status: "pending",
        },
        text: [text || proposal.label, selectionReview].filter(Boolean).join("\n\n"),
      });
      const capturedDocumentId = base.documentId;
      const capturedCommit = session.history.capture().cursor!;
      chat.pendingReview = {
        label: proposal.label,
        messageId,
        baseRevision: base.revision,
        baseDocumentId: base.documentId,
        baseCommit: capturedCommit,
        base: writeProjectWorkspace(base.documents()),
        baseImage: writeProjectWorkspace(base.lastAdmissibleBuild!.documents()),
        candidate: writeProjectWorkspace(proposal.documents()),
      };
      review = {
        proposal,
        chatId: chat.id,
        messageId,
        changes: () => proposal.changes(),
        stale: () =>
          session.model.capture().documentId !== capturedDocumentId ||
          session.history.capture().cursor !== capturedCommit,
      };
      reviews.set(chat.id, review);
      notify();
      assertLive();
      if ((autoApprove || automatic) && !forceReview && !review.stale()) {
        try {
          await approve(undefined, true, capturedRuntime);
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
          notify();
          return true;
        }
        touched.clear();
        base = session.model.capture();
        selection = workspaceSelection(context, base.documents(), PROFILES[profileId]!, scene);
        workspace = captureAgentWorkspace({
          draft: new ProjectDraft(base.documents()),
          files: Object.fromEntries(base.lastAdmissibleBuild!.files()),
          profileId,
          allowMissingRooms: session.allowMissingRooms,
        });
        driver = projectDriver();
        staged = undefined;
        notes = undefined;
        prepared.clear();
      }
      return true;
    }
    try {
      await run.run(async () => {
        let initial = chat.transcript;
        if (
          (chat.transcript.length || chat.messages.length > 1) &&
          (chat.provider !== config.provider || chat.model !== config.model)
        ) {
          const old = make(config, [], run, []);
          old.setAvailableTools([]);
          const handoff = await old.sendUserMessage(
            `${HANDOFF}\nTask messages:\n${JSON.stringify(chat.messages)}\nTool record:\n${JSON.stringify(chat.transcript, (key, value) => (["encrypted_content", "signature", "thinking"].includes(key) || (value && typeof value === "object" && ["reasoning", "thinking", "redacted_thinking"].includes(value.type)) ? undefined : value))}\nPrevious summary:\n${chat.summary ?? ""}`,
          );
          if (handoff.toolCalls.length || !handoff.text?.trim())
            throw new Error("The model handoff needs a summary. Retry the switch.");
          const archived = {
            ...structuredClone(chat),
            id: id(),
            archived: true,
            messages: structuredClone(chat.messages.slice(0, -1)),
          };
          store.chats.push(archived);
          knownChats.add(archived.id);
          chat.summary = handoff.text;
          initial = [{ role: "user", content: `Task summary:\n${chat.summary}` }];
        }
        chat.sessionId ??= crypto.randomUUID();
        provider = make(config, initial, run, WORKSPACE_AGENT_TOOLS, chat.sessionId);
        const runtime = (turnContext.runtime ?? options.runtime)?.() ?? {};
        capturedRuntime = runtime;
        if (readOnly) {
          const nativeFiles = await runtime.nativeFiles?.();
          assertLive();
          inspection = createProjectInspection({
            files: nativeFiles ?? Object.fromEntries(base.lastAdmissibleBuild!.files()),
            documents:
              !nativeFiles ||
              computeResourceRevision(nativeFiles) === base.lastAdmissibleBuild!.identity.revision
                ? base.lastAdmissibleBuild!.documents()
                : {},
            profileId,
            origin: nativeFiles ? "live" : "admitted",
          });
        }
        if (selection) {
          scene = await selectionScene(runtime.engine, selection.focus.room ?? 0);
          selection = workspaceSelection(context, base.documents(), PROFILES[profileId]!, scene);
        }
        const references = (await runtime.referenceArt?.([])) ?? runtime.references;
        const reference = references?.art.length ? await referenceManifest(references) : undefined;
        const sendReference =
          reference &&
          (references!.art.some((art) => art.attached) ||
            !JSON.stringify(initial).includes(JSON.stringify(reference.text).slice(1, -1)));
        const allowedTools = withReferences(
          readOnly ? ASK_TOOLS : WORKSPACE_AGENT_TOOLS.map((tool) => tool.name),
          references,
        );
        provider.setAvailableTools(allowedTools);
        chat.provider = config.provider;
        chat.model = config.model;
        const currentNotes = base.read("notes")?.content;
        const revised =
          review?.chatId === chat.id
            ? `\nPrevious changes for revision:\n${JSON.stringify(review.changes())}`
            : "";
        const prompt = `${readOnly ? "Answer questions about this game using read-only tools and concise hints." : "You are the game's agent. Answer questions directly; edit when the user requests a change. Attached context identifies the current focus and does not restrict the resources you may inspect or change. Edit any resource through one coordinated change set. Read exact documents, retain existing ids and references, and use propose_changes for the final complete set. Whole-game tools stage edits. Call finish when the task is complete; repair a rejected handover before finishing. A successful finish ends the tool batch and hands the validated changes to the creator. Include concise progress notes with your next tool call while work remains."} Write concise progress notes between tools. Game notes:\n${typeof currentNotes === "string" ? currentNotes : ""}\nAttached context:\n${context}\n${sendReference ? reference.text : ""}${revised}\nRequest:\n${instruction}`;
        let turn = await provider.sendUserMessage(
          prompt,
          sendReference ? [reference.image] : undefined,
        );
        while (true) {
          await run.checkpoint(false);
          if (session.closed) throw new Error("The project session was closed.");
          for (const message of turn.assistantMessages ?? [])
            if (message.phase === "commentary" && message.text) progress.push(message.text);
          if (turn.text) {
            progress.push(
              turn.toolCalls.length === 0 && formatReply ? formatReply(turn.text).text : turn.text,
            );
            notify();
          }
          if (turn.toolCalls.length === 0) {
            const followup = await receiveNextSteps();
            if (!followup) {
              if (nextSteps.length) continue;
              acceptingSteps = false;
              break;
            }
            turn = followup;
            continue;
          }
          const results = unreported;
          for (const call of turn.toolCalls) {
            progress.push(
              VOCABULARY_ACTIONS[call.name as keyof typeof VOCABULARY_ACTIONS]?.label ?? call.name,
            );
            notify();
            await run.checkpoint(false);
            assertLive();
            let result: AgentToolResult;
            try {
              if (handedOver)
                throw new Error("Not executed: this turn ended at a successful finish.");
              const definition = WORKSPACE_AGENT_TOOLS.find((tool) => tool.name === call.name);
              if (!definition || !allowedTools.includes(call.name))
                throw new Error("This tool is unavailable.");
              const problems = validateToolArguments(definition.parameters, call.input);
              if (problems.length) throw new Error(problems.join(" "));
              if (readOnly && PROJECT_ASSIST_TOOLS.some((tool) => tool.name === call.name)) {
                if (call.name === "read_document" && call.input["key"] === "world")
                  throw new Error(
                    "Creator intent is unavailable in Ask. Inspect game resources instead.",
                  );
                result = driver.execute(call.name, call.input);
                if (call.name === "read_document" || call.name === "read_project_context")
                  result = {
                    ...result,
                    details: {
                      ...result.details,
                      origin: {
                        kind: "draft",
                        documentId: base.documentId,
                        profileId,
                      },
                    },
                  };
              } else if (readOnly) {
                if (call.name === "read_edit_context") {
                  selection = workspaceSelection(
                    context,
                    base.documents(),
                    PROFILES[profileId]!,
                    scene,
                  );
                  if (selection) {
                    scene = await selectionScene(runtime.engine, selection.focus.room ?? 0);
                    selection = workspaceSelection(
                      context,
                      base.documents(),
                      PROFILES[profileId]!,
                      scene,
                    );
                  }
                }
                result = await inspection!.execute(call.name, call.input, {
                  ...runtime,
                  references,
                  allowedTools,
                  ...(selection ? { selection } : {}),
                });
                if (call.name === "read_edit_context")
                  result = {
                    ...result,
                    details: {
                      ...result.details,
                      origin: {
                        kind: "draft",
                        documentId: base.documentId,
                        profileId,
                      },
                    },
                  };
              } else if (call.name === "propose_names") {
                const changes = proposeNames({
                  documents: stagedDocuments(),
                  profile: PROFILES[profileId]!,
                  names: call.input["names"] as Parameters<typeof proposeNames>[0]["names"],
                });
                stageChanges("Name game parts", changes);
                forceReview = true;
                result = {
                  success: true,
                  message: "Names and their evidence are ready for review.",
                  details: { names: call.input["names"] },
                };
              } else if (SELECTION_TOOL_NAMES.includes(call.name)) {
                selection = workspaceSelection(
                  context,
                  stagedDocuments(),
                  PROFILES[profileId]!,
                  scene,
                );
                staged ??= editWorkspace().openToolState();
                result = await executeAgentToolAsync(staged.state, call.name, call.input, {
                  ...runtime,
                  references,
                  readOnly,
                  allowedTools,
                  selection,
                });
                if (result.success && call.name === "edit_selection" && selection?.candidate) {
                  const candidate = selection.candidate;
                  const key = `${candidate.kind}:${candidate.num}`;
                  const content =
                    candidate.draft.kind === "picture"
                      ? candidate.draft.source
                      : candidate.draft.payload;
                  stageChanges(candidate.summary, [{ key, content }]);
                  if (
                    candidate.ops.some((op) => op.type === "deleteItem" || op.type === "deleteCel")
                  )
                    forceReview = true;
                  const effects = candidate.check.sideEffects;
                  if (effects?.cells)
                    selectionReview = `Also changes: ${effects.items.map((item) => item.label).join(", ")} (${effects.cells} cells).`;
                  touched.add(key);
                }
              } else if (call.name === "write_notes") {
                touched.add("notes");
                notes =
                  [
                    ...new Set(
                      String(call.input["text"])
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean),
                    ),
                  ].join("\n") + "\n";
                result = {
                  success: true,
                  message: "Game notes staged. Include them with the changes.",
                };
              } else if (
                call.name === "trace_an_image" ||
                call.name === "make_cels_from_an_image"
              ) {
                const operations = await import("../../../src/creative/imageOperations.ts");
                assertLive();
                const offered = driver.pending();
                const native = staged?.finish(chatTitle(instruction), offered?.changes() ?? []);
                const combined = new Map(
                  [
                    ...prepared.values(),
                    ...(native?.changes() ?? []),
                    ...(offered?.changes() ?? []),
                  ].map((change) => [change.key, change]),
                );
                const documents = { ...base.documents() };
                for (const { key, content } of combined.values()) {
                  if (content === null) delete documents[key];
                  else documents[key] = content;
                }
                const image = operations.readProjectImage(documents, String(call.input["image"]));
                const target = String(call.input["target"]);
                const changes =
                  call.name === "trace_an_image"
                    ? operations.traceImageChanges(
                        documents,
                        target,
                        image,
                        Number(call.input["opacity"]),
                      )
                    : operations.makeCelsChanges(
                        documents,
                        target,
                        image,
                        call.input["frames"] === null
                          ? operations.suggestImageFrames(image)
                          : (call.input["frames"] as ImageFrame[]),
                        PROFILES[profileId]!,
                      );
                for (const change of changes) combined.set(change.key, change);
                // Validate before publishing any staged state. Later tools read
                // the complete overlaid project, including these image changes.
                const checked = session.model.propose(base, chatTitle(instruction), [
                  ...combined.values(),
                ]);
                editWorkspace().propose(checked.label, checked.changes());
                const next = captureAgentWorkspace({
                  draft: new ProjectDraft(checked.documents()),
                  files: Object.fromEntries(base.lastAdmissibleBuild!.files()),
                  profileId,
                  allowMissingRooms: session.allowMissingRooms,
                });
                prepared.clear();
                for (const change of checked.changes()) prepared.set(change.key, change);
                workspace = next;
                selection = undefined;
                staged = undefined;
                driver = projectDriver();
                result = { success: true, message: "Image changes staged for review." };
              } else if (PROJECT_ASSIST_TOOLS.some((tool) => tool.name === call.name)) {
                result = driver.execute(call.name, call.input);
                if (result.success && call.name === "propose_changes")
                  for (const change of call.input["changes"] as ProjectChange[])
                    touched.add(change.key);
              } else {
                staged ??= editWorkspace().openToolState();
                result = await executeAgentToolAsync(staged.state, call.name, call.input, {
                  ...runtime,
                  references,
                  readOnly,
                  allowedTools,
                });
              }
              if (
                call.name === "withdraw_changes" &&
                (result.success ||
                  staged ||
                  prepared.size ||
                  notes !== undefined ||
                  review?.chatId === chat.id)
              ) {
                staged = undefined;
                notes = undefined;
                prepared.clear();
                selection = undefined;
                selectionReview = "";
                forceReview = false;
                workspace = captureAgentWorkspace({
                  draft: new ProjectDraft(base.documents()),
                  files: Object.fromEntries(base.lastAdmissibleBuild!.files()),
                  profileId,
                  allowMissingRooms: session.allowMissingRooms,
                });
                driver = projectDriver();
                touched.clear();
                delete chat.pendingReview;
                reviews.delete(chat.id);
                if (review?.chatId === chat.id) review = null;
                result = { success: true, message: "Discarded the task's pending changes." };
              }
              if (
                call.name === "propose_changes" &&
                result.success &&
                !forceReview &&
                nextSteps.length === 0 &&
                (autoApprove || automatic)
              ) {
                acceptingSteps = false;
                notify();
                try {
                  await offer(String(call.input["label"]));
                } finally {
                  acceptingSteps = true;
                  notify();
                }
                result = {
                  ...result,
                  message: review?.stale()
                    ? "Proposal retained for review: the project changed during this task."
                    : "Changes applied as one History commit. Read current documents before further changes.",
                };
              }
            } catch (cause) {
              result = {
                success: false,
                error: cause instanceof Error ? cause.message : String(cause),
              };
            }
            if (call.name === "finish" && result.success) handedOver = true;
            if (result.details?.["gameTests"] && result.message) {
              progress.push(result.message);
              notify();
            }
            const resourceKeys = inspectedResourceKeys(call.name, call.input, result);
            if (resourceKeys.length) {
              let documents: Readonly<Record<string, ProjectContent>>;
              let dependencies: Readonly<Record<string, ProjectContent>>;
              if (call.name === "read_document") {
                // The driver reads its captured workspace, including previously staged edits.
                documents = readOnly ? base.documents() : editWorkspace().documents();
                dependencies = resourceRenderingDependencies(documents);
              } else {
                // Create tools inspect the task's native state, which can contain
                // unadmitted edits. Capture that same state before another tool runs.
                const native = readOnly
                  ? inspection!
                  : createProjectInspection({
                      files: Object.fromEntries(staged!.state.getFiles()),
                      documents: {},
                      profileId,
                    });
                documents = native.documents(resourceKeys);
                dependencies = native.documents(["words", "inventory"]);
              }
              for (const key of resourceKeys) {
                const content = documents[key];
                if (content === undefined) continue;
                inspectedDocuments[key] = content;
                Object.assign(inspectedDependencies, dependencies);
                resourceSnapshots[key] = writeProjectWorkspace({ ...dependencies, [key]: content });
              }
            }
            run.recordTool(call.name, call.input, result, base.revision);
            results.push({ toolCallId: call.id, result });
          }
          provider.appendToolResults(results);
          unreported = [];
          flushActions();
          let followup = await receiveNextSteps();
          while (!followup && nextSteps.length) followup = await receiveNextSteps();
          if (followup) {
            handedOver = false;
            turn = followup;
            continue;
          }
          if (handedOver) {
            acceptingSteps = false;
            break;
          }
          try {
            turn = await provider.complete();
          } catch (cause) {
            if (cause instanceof LlmResponseError && /output limit/i.test(cause.message)) {
              run.pause(cause.message);
              await run.checkpoint();
              turn = await provider.sendUserMessage(
                "Continue the task from successful tool results.",
              );
            } else throw cause;
          }
        }
        if (readOnly || !(await offer(turn.text ?? "")))
          chat.messages.push({
            id: id(),
            role: "assistant",
            taskId: request.id,
            ...(Object.keys(inspectedDocuments).length
              ? {
                  result: {
                    kind: "resources" as const,
                    documentId: projectDocumentId(
                      { ...inspectedDependencies, ...inspectedDocuments },
                      sha256Hex,
                    ),
                    resources: Object.keys(inspectedDocuments),
                    resourceSnapshots,
                    snapshot: writeProjectWorkspace({
                      ...inspectedDependencies,
                      ...inspectedDocuments,
                    }),
                    profileId,
                  },
                }
              : {}),
            ...(formatReply ? formatReply(turn.text ?? "") : { text: turn.text ?? "Finished." }),
          });
      });
    } catch (cause) {
      const desired = new Map(
        (driver.pending()?.changes() ?? []).map((change) => [change.key, change.content]),
      );
      try {
        for (const change of staged
          ?.finish("Interrupted task", driver.pending()?.changes() ?? [])
          .changes() ?? []) {
          touched.add(change.key);
          desired.set(change.key, change.content);
        }
      } catch {
        // Tool results retain validation failures when the staged candidate cannot compile.
      }
      for (const change of prepared.values()) {
        touched.add(change.key);
        desired.set(change.key, change.content);
      }
      if (notes !== undefined) desired.set("notes", notes);
      const discarded = [...touched].filter(
        (key) =>
          !persisted.some((effect) => effect.resources.includes(key)) ||
          !desired.has(key) ||
          !sameProjectContent(desired.get(key), session.model.capture().read(key)?.content),
      );
      if (unreported.length) provider?.appendToolResults(unreported);
      provider?.recordInterruption?.(
        "The task was interrupted; outstanding tools were not executed.",
      );
      action(chat, "interruption", {
        outcome: cause instanceof LlmRefusalError ? "refused" : "interrupted",
        error: String(cause),
        discarded,
        persisted,
      });
      if (!readOnly) delete chat.pendingReview;
      flushActions();
      if (!readOnly) {
        reviews.delete(chat.id);
        if (review?.chatId === chat.id) review = null;
      }
      error = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      flushActions();
      actionQueue = null;
      actionChat = null;
      appliedDuringRun = null;
      if (provider) chat.transcript = provider.getTranscript();
      const completed = run.snapshot();
      completedRuns.set(chat.id, completed);
      const finalMessage = chat.messages.findLast(
        (message) => message.role === "assistant" && message.taskId === request.id,
      );
      if (finalMessage)
        chat.messages = chat.messages.map((message) =>
          message === finalMessage
            ? {
                ...message,
                spend: {
                  amount: completed.reportedSpent,
                  budget: completed.budget,
                  priceKnown: completed.priceKnown,
                  incomplete: completed.usageIncomplete,
                },
              }
            : message,
        );
      acceptingSteps = false;
      const undelivered = nextSteps;
      nextSteps = [];
      chat.messages = chat.messages.map((message) =>
        undelivered.some((step) => step.id === message.id)
          ? { ...message, delivery: "cancelled" }
          : message,
      );
      try {
        await save();
        await session.flush();
        chatSaveError = "";
      } catch (cause) {
        if (!readOnly) failedSave = { cause };
        chatSaveError = "Saving the conversation failed. Retry save.";
        progress.push(cause instanceof Error ? cause.message : String(cause));
      } finally {
        activeRun = null;
        activeRequest = null;
        busy = false;
        notify();
      }
    }
    if (failedSave) throw failedSave.cause;
  }
  async function checkpoint(messageId: string, mode: "undo" | "restore") {
    const message = store.chats
      .flatMap((chat) => chat.messages)
      .find((message) => message.id === messageId);
    if (!message?.commit || !message.beforeCommit)
      throw new Error("This message has no applied changes.");
    const chat = store.chats.find((entry) => entry.messages.includes(message))!;
    async function recordDecision(result: unknown) {
      const status =
        result && typeof result === "object" && "status" in result ? result.status : "unchanged";
      action(chat, mode, { messageId, checkpoint: message!.beforeCommit, outcome: status });
      await save();
      return result;
    }
    if (mode === "restore") return recordDecision(await session.restore(message.beforeCommit));
    const history = session.history.capture();
    if (history.cursor === message.commit) return recordDecision(await session.undo());
    const commit = history.commits.find((commit) => commit.id === message.commit)!;
    const parent = history.commits.find((entry) => entry.id === message.beforeCommit);
    if (!commit || !parent) throw new Error("This checkpoint has been pruned from History.");
    const snapshot = session.model.capture();
    const changes = commit.changed.map((key) => {
      const now = snapshot.read(key)?.content;
      const hash = commit.documents[key];
      const after = hash ? history.blobs[hash] : undefined;
      if (
        typeof now === "string" || typeof after === "string"
          ? now !== after
          : now?.toString() !== after?.toString()
      )
        throw new Error(`Later edits changed ${key}. Use Restore to before this.`);
      const before = parent.documents[key];
      return { key, content: before ? history.blobs[before]! : null };
    });
    return recordDecision(
      await session.submit({
        proposal: session.model.propose(snapshot, "Undo message", changes),
        label: "Undo message",
        author: "creator",
        origin: "history",
      }),
    );
  }
  return {
    current,
    get activeRequest() {
      return activeRequest ? { ...activeRequest } : null;
    },
    get canSteer() {
      return acceptingSteps && activeRequest !== null && activeRun !== null;
    },
    steer(instruction: string) {
      if (!acceptingSteps || !activeRequest || !activeRun || !actionChat)
        throw new Error("The task has finished. Send a new message.");
      const text = instruction.trim();
      if (!text) return;
      const messageId = id();
      const chat = store.chats.find((entry) => entry.id === actionChat)!;
      chat.messages.push({
        id: messageId,
        role: "user",
        text,
        taskId: activeRequest.id,
        delivery: "queued",
      });
      nextSteps.push({ id: messageId, text });
      notify();
    },
    reviewFor(messageId: string): PendingAgentReview | undefined {
      const chat = store.chats.find((entry) =>
        entry.messages.some((message) => message.id === messageId),
      );
      const message = chat?.messages.find((entry) => entry.id === messageId);
      if (chat?.pendingReview?.messageId === messageId) return structuredClone(chat.pendingReview);
      if (message?.review) return structuredClone(message.review);
      if (!message?.commit || !message.beforeCommit) return undefined;
      const history = session.history.capture();
      const before = history.commits.find((entry) => entry.id === message.beforeCommit);
      const after = history.commits.find((entry) => entry.id === message.commit);
      if (!before || !after) return undefined;
      const documents = (commit: typeof before) =>
        Object.fromEntries(
          Object.entries(commit.documents).flatMap(([key, hash]) =>
            hash ? [[key, history.blobs[hash]!]] : [],
          ),
        );
      return {
        label: after.label,
        messageId,
        baseRevision:
          chat?.messages.find((entry) => entry.request?.id === message.taskId)?.request?.revision ??
          0,
        baseDocumentId: projectDocumentId(documents(before), sha256Hex),
        baseCommit: before.id,
        base: writeProjectWorkspace(documents(before)),
        candidate: writeProjectWorkspace(documents(after)),
      };
    },
    async submit(request: AgentSubmission) {
      const chat = store.chats.find((chat) => chat.id === store.active)!;
      await drive(
        chat,
        request.instruction,
        request.context ?? "",
        request.mode === "play" || request.readOnly === true,
        false,
        request.formatReply,
        request,
      );
      return chat.messages.at(-1)?.text ?? "";
    },
    reviewOutcome(messageId: string): string | undefined {
      return (
        reviewOutcomes.get(messageId) ??
        (store.chats.some((chat) =>
          chat.messages.some(
            (message) =>
              message.id === messageId &&
              message.result?.kind === "changes" &&
              message.result.status === "rejected",
          ),
        )
          ? "Rejected"
          : undefined) ??
        (store.chats.some((chat) =>
          chat.messages.some((message) => message.id === messageId && message.commit),
        )
          ? "Applied"
          : undefined)
      );
    },
    newChat,
    chats: () => readAgentChats(store).chats,
    pending: () => review,
    get autoApprove() {
      return autoApprove;
    },
    set autoApprove(value: boolean) {
      autoApprove = value;
      notify();
    },
    get busy() {
      return busy || applying;
    },
    get error() {
      return error;
    },
    get chatSaveError() {
      return chatSaveError;
    },
    async retryChatSave() {
      if (busy || applying) throw new Error("Wait for the current task to finish.");
      applying = true;
      notify();
      try {
        await save();
        await session.flush();
        chatSaveError = "";
      } catch (cause) {
        chatSaveError = "Saving the conversation failed. Retry save.";
        progress.push(String(cause));
        throw new Error(chatSaveError, { cause });
      } finally {
        applying = false;
        notify();
      }
    },
    get progress() {
      return [...progress];
    },
    get task() {
      return (
        activeRun?.snapshot() ??
        (store.active === null ? null : (completedRuns.get(store.active) ?? null))
      );
    },
    subscribe(observer: () => void) {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    resume(chatId: string) {
      if (busy || applying) throw new Error("Finish the current task before resuming a chat.");
      if (!store.chats.some((chat) => chat.id === chatId)) throw new Error("Chat is missing.");
      store.active = chatId;
      review = reviews.get(chatId) ?? null;
      void save().catch((cause) => {
        error = String(cause);
        notify();
      });
    },
    deleteChat(chatId: string) {
      if (busy || applying) throw new Error("Finish the current task before deleting a chat.");
      store.chats = store.chats.filter((chat) => chat.id !== chatId);
      if (store.active === chatId)
        store.active = store.chats.find((chat) => !chat.background)?.id ?? null;
      if (store.active === null) newChat();
      reviews.delete(chatId);
      review = store.active === null ? null : (reviews.get(store.active) ?? null);
      void save().catch((cause) => {
        error = String(cause);
        notify();
      });
    },
    send(instruction: string, context = "", turnContext: AgentTurnContext = {}) {
      return drive(
        store.chats.find((chat) => chat.id === store.active)!,
        instruction,
        context,
        false,
        false,
        undefined,
        turnContext,
      );
    },
    async ask(
      instruction: string,
      context = "",
      formatReply?: ReplyFormatter,
      turnContext: AgentTurnContext = {},
    ) {
      const chat = store.chats.find((chat) => chat.id === store.active)!;
      await drive(chat, instruction, context, true, false, formatReply, turnContext);
      return chat.messages.at(-1)?.text ?? "";
    },
    async background(title: string, instruction: string) {
      const chat = newChat(title, true);
      const previous = review;
      try {
        await drive(chat, instruction, "Background room task", false, true);
      } finally {
        review = previous;
        notify();
      }
    },
    approve,
    async reject() {
      if (applying) return;
      if (review) {
        const chat = store.chats.find((chat) => chat.id === review!.chatId)!;
        reviewOutcomes.set(review.messageId, "Rejected");
        chat.messages = chat.messages.map((message) =>
          message.id === review!.messageId
            ? {
                ...message,
                ...(chat.pendingReview ? { review: structuredClone(chat.pendingReview) } : {}),
                result: {
                  kind: "changes",
                  documentId: chat.pendingReview!.baseDocumentId,
                  resources: review!.changes().map((change) => change.key),
                  status: "rejected",
                },
              }
            : message,
        );
        action(chat, "reject", {
          resources: review.changes().map((change) => change.key),
          outcome: "discarded",
        });
        delete chat.pendingReview;
        reviews.delete(review.chatId);
      }
      review = null;
      await save();
    },
    undoMessage(messageId: string) {
      return checkpoint(messageId, "undo");
    },
    restoreBefore(messageId: string) {
      return checkpoint(messageId, "restore");
    },
    stop() {
      activeRun?.stop();
    },
    continue(requests?: number) {
      activeRun?.resume(requests);
    },
    cancel() {
      activeRun?.cancel();
    },
  };
}

/** One task-chat adapter; ProjectSession remains the sole project writer. */
import { AgentRun } from "./agentRun.ts";
import {
  createAnthropicConversation,
  createOpenAiConversation,
  LlmResponseError,
  type LlmConfig,
  type UnifiedConversation,
} from "./llmClient.ts";
import { createProjectAssistDriver, PROJECT_ASSIST_TOOLS } from "./projectAssistTools.ts";
import {
  ASK_TOOLS,
  withReferences,
  executeAgentToolAsync,
  type AgentRuntimeDeps,
} from "../../../src/agent/tools.ts";
import { referenceManifest } from "../../../src/agent/referenceTools.ts";
import { captureAgentWorkspace } from "../../../src/authoring/projectAgentCandidate.ts";
import { ProjectDraft } from "../../../src/authoring/projectDraft.ts";
import { validateToolArguments } from "../../../src/agent/schemaValidate.ts";
import type { ProjectProposal } from "../../../src/authoring/projectModel.ts";
import type { ProjectSession } from "../project/projectSession.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import { readAgentChats, chatTitle, type AgentChat } from "../../../src/agent/chats.ts";
import type { AgentToolResult } from "../../../src/agent/agentState.ts";
import { VOCABULARY_ACTIONS } from "../../../src/vocabulary.ts";
import { WORKSPACE_AGENT_TOOLS } from "./workspaceAgentTools.ts";
import type { ToolDefinition } from "../../../src/agent/tools.ts";

const HANDOFF =
  "Summarize this task for a different model using the compaction summary pattern: objective, decisions, completed changes, unresolved work, resource identifiers, and next steps. Return only the summary. Preserve user constraints. Omit thinking blocks, credentials and protocol records.";
export interface AgentReview {
  readonly proposal: ProjectProposal;
  readonly chatId: string;
  readonly messageId: string;
  changes(): ReturnType<ProjectProposal["changes"]>;
  stale(): boolean;
}
interface Options {
  readonly session: ProjectSession;
  readonly profileId: ProfileId;
  readonly config: () => LlmConfig;
  readonly conversation?: (
    config: LlmConfig,
    transcript: unknown[],
    run: AgentRun,
    catalog?: readonly ToolDefinition[],
  ) => UnifiedConversation;
  readonly runtime?: () => AgentRuntimeDeps;
  readonly changed?: () => void;
}
function conversation(
  config: LlmConfig,
  transcript: unknown[],
  run: AgentRun,
  catalog: readonly ToolDefinition[] = WORKSPACE_AGENT_TOOLS,
): UnifiedConversation {
  if (config.provider === "openai")
    return createOpenAiConversation(config, transcript, undefined, run, catalog);
  if (config.provider === "anthropic")
    return createAnthropicConversation(config, transcript, run, catalog);
  return stubConversation(transcript);
}
/** Offline authoring uses real validation and admission, with a deterministic resource edit. */
function stubConversation(initial: unknown[]): UnifiedConversation {
  const transcript = [...initial];
  let step = 0;
  let prompt = "";
  let context: Record<string, unknown> = {};
  return {
    setAvailableTools() {},
    async sendUserMessage(text) {
      prompt = text;
      if (text.startsWith("Answer questions about this game")) {
        const reply =
          "This test provider can inspect the game; connect a model for hints and debugging.";
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
      for (const entry of results) {
        transcript.push({ role: "assistant", text: JSON.stringify(entry) });
        if (entry.result.details?.["documents"]) context = entry.result.details;
      }
    },
    async complete() {
      if (step++ === 0) {
        const docs = context["documents"] as { key: string }[] | undefined;
        const picture = docs?.find((d) => d.key.startsWith("picture:"))?.key;
        const logic = docs?.find((d) => d.key.startsWith("logic:") && d.key !== "logic:0")?.key;
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
        const changes = reads.slice(-2).map((item) => {
          const r = item.result!;
          const key = String(r.details!["key"]);
          const text = r.message?.split(":\n").slice(1).join(":\n") ?? "";
          return {
            key,
            content: key.startsWith("logic:")
              ? text.replace(/#message (\d+) "[^"]*"/, '#message $1 "Welcome sign"')
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
    getTranscript() {
      return structuredClone(transcript);
    },
  };
}
let sequence = 0;
const owned = new WeakMap<ProjectSession, ReturnType<typeof createWorkspaceAgent>>();
export function borrowWorkspaceAgent(options: Options) {
  let agent = owned.get(options.session);
  if (!agent) {
    agent = createWorkspaceAgent(options);
    owned.set(options.session, agent);
  }
  return agent;
}
export function createWorkspaceAgent(options: Options) {
  const session = options.session;
  const store = session.chats();
  let review: AgentReview | null = null;
  const reviews = new Map<string, AgentReview>();
  let activeRun: AgentRun | null = null;
  let autoApprove = false;
  let error = "";
  let busy = false;
  let applying = false;
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
      ...(background ? { background: true } : {}),
    };
    knownChats.add(chat.id);
    store.chats.push(chat);
    if (!background) {
      store.active = chat.id;
      review = null;
    }
    void save().catch((cause) => {
      error = String(cause);
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
  async function approve(keys?: readonly string[]) {
    const approving = review;
    if (approving === null || applying) return;
    applying = true;
    notify();
    try {
      if (approving.stale())
        throw new Error(
          "The project changed while the agent worked. Send a follow-up to revise these changes.",
        );
      const changes = approving
        .changes()
        .filter((change) => keys === undefined || keys.includes(change.key));
      if (changes.length === 0) throw new Error("Select a change to approve.");
      const proposal = session.model.propose(
        approving.proposal.base,
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
      const before = session.history.capture().cursor!;
      const result = await session.submit({
        proposal,
        label: `AI: ${proposal.label}`,
        origin: "agent",
        author: "agent",
        chatId: approving.chatId,
        messageId: approving.messageId,
      });
      if (!["committed", "unchanged", "restartRequired"].includes(result.status))
        throw new Error("The changes could not be applied. Check Problems and revise them.");
      const commit = session.history.capture().cursor!;
      const chat = store.chats.find((chat) => chat.id === approving.chatId)!;
      chat.messages = chat.messages.map((message) =>
        message.id === approving.messageId ? { ...message, beforeCommit: before, commit } : message,
      );
      reviews.delete(approving.chatId);
      if (review === approving) review = null;
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
  ) {
    if (session.closed) throw new Error("The project session was closed.");
    if (busy || applying) throw new Error("Wait for the current task to finish.");
    busy = true;
    error = "";
    progress.length = 0;
    let base = session.model.capture();
    let workspace = captureAgentWorkspace({
      draft: new ProjectDraft(base.documents()),
      files: Object.fromEntries(base.lastAdmissibleBuild!.files()),
      profileId: options.profileId,
      allowMissingRooms: session.allowMissingRooms,
    });
    let staged: ReturnType<typeof workspace.openToolState> | undefined;
    let notes: string | undefined;
    function projectDriver() {
      const captured = workspace;
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
          return staged ? staged.finish(label, coordinated) : captured.propose(label, coordinated);
        },
      });
    }
    let driver = projectDriver();
    const config = options.config();
    const run = new AgentRun(config.model, () => notify(), config.budgetUsd);
    activeRun = run;
    const userId = id();
    chat.messages.push({ id: userId, role: "user", text: instruction });
    if (chat.title === "New chat") chat.title = chatTitle(instruction);
    const make = options.conversation ?? conversation;
    let provider: UnifiedConversation | undefined;
    async function offer(text: string) {
      const offered = driver.pending();
      const native = staged?.finish(chatTitle(instruction), offered?.changes() ?? []);
      const combined = new Map(
        [...(native?.changes() ?? []), ...(offered?.changes() ?? [])].map((change) => [
          change.key,
          change,
        ]),
      );
      if (notes !== undefined) combined.set("notes", { key: "notes", content: notes });
      const changes = [...combined.values()];
      if (!changes.length) return false;
      workspace.propose(chatTitle(instruction), changes);
      const proposal = session.model.propose(
        base,
        offered?.label ?? chatTitle(instruction),
        changes,
      );
      const messageId = id();
      chat.messages.push({ id: messageId, role: "assistant", text: text || proposal.label });
      const capturedRevision = base.revision;
      review = {
        proposal,
        chatId: chat.id,
        messageId,
        changes: () => proposal.changes(),
        stale: () => session.model.capture().revision !== capturedRevision,
      };
      reviews.set(chat.id, review);
      notify();
      if ((autoApprove || automatic) && !review.stale()) {
        await approve();
        base = session.model.capture();
        workspace = captureAgentWorkspace({
          draft: new ProjectDraft(base.documents()),
          files: Object.fromEntries(base.lastAdmissibleBuild!.files()),
          profileId: options.profileId,
          allowMissingRooms: session.allowMissingRooms,
        });
        driver = projectDriver();
        staged = undefined;
        notes = undefined;
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
        provider = make(config, initial, run);
        const runtime = options.runtime?.() ?? {};
        const references = (await runtime.referenceArt?.([])) ?? runtime.references;
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
        const prompt = `${readOnly ? "Answer questions about this game using read-only tools and concise hints." : "You are the game's agent. Edit any resource through one coordinated change set. Read exact documents, retain existing ids and references, and use propose_changes for the final complete set. Whole-game tools stage edits; finish validates and offers them for review."} Write concise progress notes between tools. Game notes:\n${typeof currentNotes === "string" ? currentNotes : ""}\nAttached context:\n${context}\n${references ? referenceManifest(references) : ""}${revised}\nRequest:\n${instruction}`;
        let turn = await provider.sendUserMessage(prompt);
        while (true) {
          await run.checkpoint();
          if (session.closed) throw new Error("The project session was closed.");
          if (turn.usage) run.recordUsage(turn.usage);
          if (turn.text) {
            progress.push(turn.text);
            notify();
          }
          if (turn.toolCalls.length === 0) break;
          const results = [];
          for (const call of turn.toolCalls) {
            progress.push(
              VOCABULARY_ACTIONS[call.name as keyof typeof VOCABULARY_ACTIONS]?.label ?? call.name,
            );
            notify();
            let result: AgentToolResult;
            try {
              const definition = WORKSPACE_AGENT_TOOLS.find((tool) => tool.name === call.name);
              if (!definition || !allowedTools.includes(call.name))
                throw new Error("This tool is unavailable.");
              const problems = validateToolArguments(definition.parameters, call.input);
              if (problems.length) throw new Error(problems.join(" "));
              if (call.name === "write_notes") {
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
              } else if (PROJECT_ASSIST_TOOLS.some((tool) => tool.name === call.name))
                result = driver.execute(call.name, call.input);
              else {
                staged ??= workspace.openToolState();
                result = await executeAgentToolAsync(staged.state, call.name, call.input, {
                  ...runtime,
                  references,
                  readOnly,
                  allowedTools,
                });
              }
              if (
                call.name === "withdraw_changes" &&
                (result.success || staged || notes !== undefined || review?.chatId === chat.id)
              ) {
                staged = undefined;
                notes = undefined;
                reviews.delete(chat.id);
                if (review?.chatId === chat.id) review = null;
                result = { success: true, message: "Discarded the task's pending changes." };
              }
              if (call.name === "propose_changes" && result.success && (autoApprove || automatic)) {
                await offer(String(call.input["label"]));
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
            run.recordTool(call.name, call.input, result, base.revision);
            results.push({ toolCallId: call.id, result });
          }
          provider.appendToolResults(results);
          try {
            turn = await provider.complete();
          } catch (cause) {
            if (cause instanceof LlmResponseError && /output limit|refus/i.test(cause.message)) {
              run.pause(cause.message);
              await run.checkpoint();
              turn = await provider.sendUserMessage(
                "Continue the task from successful tool results.",
              );
            } else throw cause;
          }
        }
        if (!(await offer(turn.text ?? "")))
          chat.messages.push({ id: id(), role: "assistant", text: turn.text ?? "Finished." });
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      if (provider) chat.transcript = provider.getTranscript();
      busy = false;
      activeRun = null;
      await save();
    }
  }
  async function checkpoint(messageId: string, mode: "undo" | "restore") {
    const message = store.chats
      .flatMap((chat) => chat.messages)
      .find((message) => message.id === messageId);
    if (!message?.commit || !message.beforeCommit)
      throw new Error("This message has no applied changes.");
    if (mode === "restore") return session.restore(message.beforeCommit);
    const history = session.history.capture();
    if (history.cursor === message.commit) return session.undo();
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
    return session.submit({
      proposal: session.model.propose(snapshot, "Undo message", changes),
      label: "Undo message",
      author: "creator",
      origin: "history",
    });
  }
  return {
    current,
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
    get progress() {
      return [...progress];
    },
    get task() {
      return activeRun?.snapshot() ?? null;
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
    send(instruction: string, context = "") {
      return drive(
        store.chats.find((chat) => chat.id === store.active)!,
        instruction,
        context,
      );
    },
    async ask(instruction: string, context = "") {
      await drive(
        store.chats.find((chat) => chat.id === store.active)!,
        instruction,
        context,
        true,
      );
      return current().messages.at(-1)?.text ?? "";
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
    reject() {
      if (applying) return;
      if (review) reviews.delete(review.chatId);
      review = null;
      notify();
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

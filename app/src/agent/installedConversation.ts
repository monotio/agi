import type { AgentSession } from "./agentSession.ts";
import type { createWorkspaceAgent, AgentSubmission } from "./workspaceAgent.ts";
import type { AgentChat } from "../../../src/agent/chats.ts";

export type ConversationAgent = ReturnType<typeof createWorkspaceAgent>;

/** Installed editions keep their existing storage adapter and inspection service. */
export function createInstalledConversation(options: {
  readonly id: string;
  readonly title: string;
  readonly author: AgentSession;
  readonly room: () => number;
  readonly save: () => Promise<void>;
  readonly current: () => boolean;
}): ConversationAgent {
  const { author } = options;
  let busy = false;
  let error = "";
  let chatSaveError = "";
  const observers = new Set<() => void>();
  function notify() {
    for (const observer of observers) observer();
  }
  function current(): AgentChat {
    return {
      id: options.id,
      title: options.title,
      ...author.getProviderContext(),
      transcript: author.getTranscript(),
      messages: author.getMessages().map((message, index) => ({
        ...message,
        id: `${options.id}-${index}`,
      })),
    };
  }
  async function retryChatSave() {
    try {
      await options.save();
      chatSaveError = "";
    } catch (cause) {
      chatSaveError = "Saving the conversation failed. Retry save.";
      throw cause;
    } finally {
      notify();
    }
  }
  async function submit(request: AgentSubmission) {
    if (busy) throw new Error("Wait for the current task to finish.");
    if (!options.current()) throw new Error("The game changed. Open its conversation again.");
    if (request.mode !== "play") throw new Error("Open a project in Create to edit it.");
    busy = true;
    error = "";
    const off = author.task.subscribe(notify);
    notify();
    try {
      const text = await author.runAsk(request.instruction, options.room());
      try {
        await retryChatSave();
      } catch {
        // Keep the reply available and let Retry save persist without another request.
      }
      return text;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      off();
      busy = false;
      notify();
    }
  }
  function unavailable(): never {
    throw new Error("Open a project in Create to edit it.");
  }
  return {
    current,
    chats: () => [current()],
    get canSteer() {
      return false;
    },
    steer: unavailable,
    get activeRequest() {
      return null;
    },
    reviewFor: () => undefined,
    reviewOutcome: () => undefined,
    pending: () => null,
    get autoApprove() {
      return false;
    },
    set autoApprove(_value: boolean) {},
    get busy() {
      return busy;
    },
    get error() {
      return error;
    },
    get chatSaveError() {
      return chatSaveError;
    },
    get progress() {
      return [];
    },
    get task() {
      return author.task.snapshot();
    },
    subscribe(observer) {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    submit,
    ask(instruction, context = "", formatReply, turnContext = {}) {
      return submit({
        instruction,
        context,
        ...turnContext,
        mode: "play",
        ...(formatReply ? { formatReply } : {}),
      });
    },
    send: unavailable,
    newChat: unavailable,
    resume: unavailable,
    deleteChat: unavailable,
    background: unavailable,
    approve: unavailable,
    reject: unavailable,
    undoMessage: unavailable,
    restoreBefore: unavailable,
    retryChatSave,
    stop() {
      author.task.stop();
    },
    continue(requests) {
      author.task.resume(requests);
    },
    cancel() {
      author.task.cancel();
    },
  };
}

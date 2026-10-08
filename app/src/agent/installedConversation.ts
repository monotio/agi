import { createWorkspaceAgent, type ConversationSession } from "./workspaceAgent.ts";
import type { ProfileId } from "../../../src/runtime/profile.ts";
import type { LlmConfig } from "./llmClient.ts";
import type { AgentRuntimeDeps } from "../../../src/agent/tools.ts";
import { migrateAgentChats, readAgentChats } from "../../../src/agent/chats.ts";
import { ProjectModel } from "../../../src/authoring/projectModel.ts";
import { ProjectHistory } from "../../../src/authoring/projectHistory.ts";
import { sha256Hex } from "../../../src/crypto.ts";
import { requireProjectId } from "../../../src/gameIdentity.ts";
import { inspectEditableProject } from "../project/projectWorkspaceSource.ts";
import { compileWorkingProjectImage } from "../project/projectWorkingImage.ts";
import { loadGameConversation, saveGameConversationUpdate } from "../project/gameStorage.ts";
import type { BootedGame } from "../project/gameTypes.ts";

export type ConversationAgent = ReturnType<typeof createWorkspaceAgent>;

/** An installed edition stores only conversations. Its detached model has no admission or resource writer. */
export async function createInstalledConversation(options: {
  readonly game: BootedGame;
  readonly locator: string | null;
  readonly profileId?: ProfileId;
  readonly config: () => LlmConfig;
  readonly runtime: () => AgentRuntimeDeps;
  readonly conversation?: Parameters<typeof createWorkspaceAgent>[0]["conversation"];
}) {
  const stored = options.locator === null ? undefined : await loadGameConversation(options.locator);
  let chats = migrateAgentChats(stored ?? {});
  let expectedChats = stored?.chats ?? null;
  const inspection = inspectEditableProject({
    projectId: requireProjectId(`inspection-${options.game.revision}`),
    title: options.game.title,
    authoredAt: "",
    files: options.game.files,
    words: options.game.words,
    ...(options.profileId
      ? {
          library: {
            version: 1 as const,
            revision: options.game.revision,
            source: "folder" as const,
            profile: options.profileId,
            validation: { status: "ready" as const, message: "Running game" },
          },
        }
      : {}),
  });
  const history = new ProjectHistory(sha256Hex);
  const model = new ProjectModel({
    documents: inspection.documents,
    digest: sha256Hex,
    build: compileWorkingProjectImage({
      files: options.game.files,
      documents: inspection.documents,
      fallback: inspection.documents,
      history: history.capture(),
      profileId: inspection.profileId,
    }),
  });
  history.record(inspection.documents, {
    label: "Opened",
    origin: "template",
    author: "creator",
    time: 0,
  });
  let closed = false;
  let tail = Promise.resolve();
  const observers = new Set<() => void>();
  function unavailable(): never {
    throw new Error("Open a project in Create to edit it.");
  }
  const session: ConversationSession = {
    model,
    history,
    allowMissingRooms: false,
    get closed() {
      return closed;
    },
    workingSnapshot: () => model.capture(),
    chats: () => readAgentChats(chats),
    subscribe(observer) {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    saveChats(value) {
      const next = readAgentChats(value);
      chats = next;
      const save = tail
        .catch(() => {})
        .then(async () => {
          if (options.locator === null)
            throw new Error(
              "This installed edition has no conversation storage. Download the conversation before leaving.",
            );
          const active = next.chats.find((chat) => chat.id === next.active);
          await saveGameConversationUpdate(
            options.locator,
            {
              chats: next,
              provider: active?.provider ?? "stub",
              model: active?.model ?? "stub",
              transcript: active?.transcript ?? [],
              ...(active?.sessionId ? { sessionId: active.sessionId } : {}),
              chat: active?.messages ?? [],
            },
            expectedChats,
          );
          expectedChats = next;
        });
      tail = save;
      return save;
    },
    flush: () => tail,
    submit: unavailable,
    undo: unavailable,
    restore: unavailable,
  };
  const agent = createWorkspaceAgent({
    session,
    profileId: inspection.profileId,
    config: options.config,
    runtime: options.runtime,
    readOnly: true,
    ...(options.conversation ? { conversation: options.conversation } : {}),
  });
  return {
    agent,
    dispose() {
      closed = true;
      for (const observer of observers) observer();
    },
  };
}

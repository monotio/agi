import assert from "node:assert/strict";
import { test } from "node:test";
import { computed, effectScope, nextTick, ref, shallowRef, type ShallowRef } from "vue";
import type { UnifiedConversation, LlmTurnResult } from "../src/agent/llmClient.ts";
import {
  createProjectAssist,
  type ProjectAssistOptions,
  type ProjectAssistWorkspace,
} from "../src/agent/projectAssist.ts";
import { openEditableProject, type EditableProject } from "../src/project/editableProject.ts";
import * as storage from "../src/project/gameStorage.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import type { AiSettingsApi } from "../src/settings/useAiSettings.ts";
import type { ModelEffort } from "../../src/agent/modelEffort.ts";
import {
  useLogicProjectAssist,
  type LogicAssistHost,
} from "../src/studio/logic/useLogicProjectAssist.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";

installIndexedDbFixture();
const cache = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => {
      cache.set(key, value);
    },
    removeItem: (key: string) => cache.delete(key),
  },
});

async function seedProject(name: string, kind: "blank" | "starter" = "blank") {
  const prepared = prepareLocalProject({ title: name, kind });
  await prepared.save();
  return prepared.projectId;
}

/** One scripted provider conversation: turns served in order through the real loop. */
function scriptedConversation(turns: readonly LlmTurnResult[]): UnifiedConversation {
  let index = 0;
  const transcript: unknown[] = [];
  const next = (): LlmTurnResult => turns[Math.min(index++, turns.length - 1)]!;
  return {
    setAvailableTools() {},
    async sendUserMessage(text: string): Promise<LlmTurnResult> {
      transcript.push({ role: "user", text });
      return next();
    },
    appendToolResults(results): void {
      transcript.push({ role: "tool", results });
    },
    async complete(): Promise<LlmTurnResult> {
      return next();
    },
    getTranscript(): unknown[] {
      return transcript;
    },
  };
}

/** A conversation factory over a fixed turn sequence. */
function scripted(
  turns: readonly LlmTurnResult[],
): NonNullable<ProjectAssistOptions["conversationFactory"]> {
  return () => scriptedConversation(turns);
}

/** The composable's assistFactory seam with a conversation factory injected. */
function assistWith(
  factory: NonNullable<ProjectAssistOptions["conversationFactory"]>,
): NonNullable<Parameters<typeof useLogicProjectAssist>[0]["assistFactory"]> {
  return (options) => createProjectAssist({ ...options, conversationFactory: factory });
}

/** A conversation that stalls at complete() until released — for cancel/stop. */
function gated() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const factory: ProjectAssistOptions["conversationFactory"] = () => ({
    setAvailableTools() {},
    async sendUserMessage(): Promise<LlmTurnResult> {
      return { toolCalls: [{ id: "g1", name: "read_project_context", input: {} }] };
    },
    appendToolResults() {},
    async complete(): Promise<LlmTurnResult> {
      await gate;
      return { text: "done", toolCalls: [] };
    },
    getTranscript: () => [],
  });
  return { factory, release };
}

/** Minimal settings controller fake: the real shape, plain refs. */
function fakeAi(settings: { provider: "openai" | "stub"; apiKey: string; model: string }) {
  const provider = ref(settings.provider);
  const apiKey = ref(settings.apiKey);
  const model = ref(settings.model);
  const effort = ref<ModelEffort>("low");
  const taskBudget = ref(5);
  const aiConfigured = computed(() => provider.value === "stub" || apiKey.value.trim() !== "");
  const opened: string[] = [];
  const ai = {
    aiConfigured,
    provider,
    apiKey,
    model,
    effort,
    taskBudget,
    llmConfig: () => ({
      provider: provider.value,
      apiKey: apiKey.value,
      model: model.value,
      effort: effort.value,
      budgetUsd: taskBudget.value,
    }),
    openAiSettings: (_event: unknown, context: string) => {
      opened.push(context);
    },
    aiSettingsUnavailable: ref(false),
  };
  return { ai: ai as unknown as AiSettingsApi, opened };
}

interface Harness {
  ws: ShallowRef<EditableProject | undefined>;
  host: LogicAssistHost;
  resynced: string[][];
}

/**
 * A host over a swappable EditableProject — the LogicStudio seam in
 * miniature. shallowRef, like the real component: the service must stay an
 * unproxied instance or its internal structuredClone snapshots break.
 */
function fakeHost(autoApproveEligible = true): Harness {
  const ws = shallowRef<EditableProject>();
  const resynced: string[][] = [];
  const revision = ref(0);
  const host: LogicAssistHost = {
    workspace(): ProjectAssistWorkspace {
      const current = ws.value;
      if (!current) throw new Error("No project is open.");
      return {
        draft: current.draft,
        files: () => current.storedData().files,
        profileId: current.profileId,
        autoApproveEligible,
      };
    },
    editorContext: () => undefined,
    revisionTick: () => revision.value,
    onDraftChanged: (keys) => {
      resynced.push([...keys]);
      revision.value++;
    },
  };
  return { ws: ws as ShallowRef<EditableProject | undefined>, host, resynced };
}

const ROOM1 = "// Room 1\nif (isset(f5)) {\n  accept.input();\n}\nreturn;";
const ROOM1_AGENT =
  "// Room 1\nif (isset(f5)) {\n  accept.input();\n}\n// the assistant was here\nreturn;";

/** Turn list that reads context, proposes a coordinated change, then closes. */
function proposalTurns(
  changes: { key: string; content: string | null }[],
  label = "Assistant edit",
) {
  return [
    { toolCalls: [{ id: "t1", name: "read_project_context", input: {} }] },
    {
      toolCalls: [{ id: "t2", name: "propose_project_documents", input: { label, changes } }],
    },
    { text: "Proposed the change.", toolCalls: [] },
  ];
}

test("no saved key leaves the panel disconnected and manual editing untouched", async () => {
  const projectId = await seedProject("logic-assist-nokey");
  const { ws, host } = fakeHost();
  const { ai } = fakeAi({ provider: "openai", apiKey: "", model: "gpt-6.1-sol" });
  const scope = effectScope();
  const assist = scope.run(() => useLogicProjectAssist({ ai, host }))!;
  assert.equal(assist.connected.value, false);
  assert.equal(assist.phase.value, "disconnected");

  ws.value = await openEditableProject(projectId);
  await assist.ask("rename the room");
  assert.equal(assist.error.value, "Connect AI first.");
  assert.equal(assist.state.value.requestId, null);

  // Manual edits work exactly as without the panel.
  const snap = ws.value.draft.capture();
  ws.value.draft.edit("logic:1", ROOM1, snap.version("logic:1"));
  assert.equal(ws.value.draft.capture().read("logic:1")?.content, ROOM1);
  scope.stop();
});

test("ask drives a validated proposal; approve applies one transaction, undo/redo round-trip", async () => {
  const projectId = await seedProject("logic-assist-review");
  const harness = fakeHost();
  const { ai } = fakeAi({ provider: "openai", apiKey: "test-key", model: "gpt-6.1-sol" });
  const scope = effectScope();
  const assist = scope.run(() =>
    useLogicProjectAssist({
      ai,
      host: harness.host,
      assistFactory: assistWith(
        scripted(proposalTurns([{ key: "logic:1", content: ROOM1_AGENT }], "Comment the room")),
      ),
    }),
  )!;
  harness.ws.value = await openEditableProject(projectId);
  await harness.ws.value.draft.edit(
    "logic:1",
    ROOM1,
    harness.ws.value.draft.capture().version("logic:1"),
  );

  // Bound locally at mount — no provider call has happened yet.
  assert.equal(assist.connected.value, true);
  assert.equal(assist.state.value.model, "gpt-6.1-sol");
  assert.equal(assist.state.value.approval.mode, "review");

  await assist.ask("add a comment to room 1");
  const result = assist.lastResult.value;
  assert.equal(result?.outcome, "review");
  assert.deepEqual([...result!.keys], ["logic:1"]);
  assert.ok(assist.pending.value);
  assert.deepEqual(
    assist.pending.value!.changes().map((c) => [c.key, c.content]),
    [["logic:1", ROOM1_AGENT]],
  );
  assert.equal(assist.pending.value!.before("logic:1"), ROOM1);
  assert.ok(assist.steps.value.some((s) => s.startsWith("Proposed")));
  // The draft is untouched until the reviewer approves.
  assert.equal(harness.ws.value.draft.capture().read("logic:1")?.content, ROOM1);

  assert.equal(assist.accept(), true);
  assert.equal(harness.ws.value.draft.capture().read("logic:1")?.content, ROOM1_AGENT);
  assert.deepEqual(harness.resynced, [["logic:1"]]);
  assert.equal(assist.lastTransaction.value?.label, "Comment the room");
  assert.equal(assist.pending.value, null);

  // Atomic undo across the transaction, then redo.
  assert.equal(assist.undoChanges(), true);
  assert.equal(harness.ws.value.draft.capture().read("logic:1")?.content, ROOM1);
  assert.equal(assist.lastTransaction.value?.undone, true);
  assert.equal(assist.redoChanges(), true);
  assert.equal(harness.ws.value.draft.capture().read("logic:1")?.content, ROOM1_AGENT);
  assert.equal(assist.lastTransaction.value?.undone, false);
  scope.stop();
});

test("typing after the capture makes the proposal stale: approve refuses, the typed text stays", async () => {
  const projectId = await seedProject("logic-assist-stale");
  const harness = fakeHost();
  const { ai } = fakeAi({ provider: "openai", apiKey: "k", model: "gpt-6.1-sol" });
  const scope = effectScope();
  const assist = scope.run(() =>
    useLogicProjectAssist({
      ai,
      host: harness.host,
      assistFactory: assistWith(
        scripted(proposalTurns([{ key: "logic:1", content: ROOM1_AGENT }])),
      ),
    }),
  )!;
  harness.ws.value = await openEditableProject(projectId);
  const ws = harness.ws.value;
  ws.draft.edit("logic:1", ROOM1, ws.draft.capture().version("logic:1"));

  await assist.ask("change the room");
  assert.equal(assist.lastResult.value?.outcome, "review");
  assert.ok(assist.pending.value);

  // Creator types mid-review — the proposal's base revision is now behind.
  const typed = `${ROOM1}\n// creator kept typing`;
  ws.draft.edit("logic:1", typed, ws.draft.capture().version("logic:1"));
  assert.equal(assist.pendingStale.value, true);
  assert.equal(assist.accept(), false);
  assert.match(assist.acceptNote.value ?? "", /stale/i);
  assert.equal(ws.draft.capture().read("logic:1")?.content, typed);
  // The stale proposal stays reviewable until rejected or superseded.
  assert.ok(assist.pending.value);
  assert.equal(assist.pending.value!.before("logic:1"), ROOM1);
  scope.stop();
});

test("a refused proposal surfaces diagnostics and leaves the draft alone", async () => {
  const projectId = await seedProject("logic-assist-refused");
  const harness = fakeHost();
  const { ai } = fakeAi({ provider: "openai", apiKey: "k", model: "gpt-6.1-sol" });
  const scope = effectScope();
  const assist = scope.run(() =>
    useLogicProjectAssist({
      ai,
      host: harness.host,
      assistFactory: assistWith(
        scripted([
          {
            toolCalls: [
              {
                id: "bad",
                name: "propose_project_documents",
                input: {
                  label: "Broken",
                  changes: [{ key: "logic:1", content: "if (broken" }],
                },
              },
            ],
          },
          { text: "It did not compile.", toolCalls: [] },
        ]),
      ),
    }),
  )!;
  harness.ws.value = await openEditableProject(projectId);
  await assist.ask("break the room");
  const result = assist.lastResult.value;
  assert.equal(result?.outcome, "refused");
  assert.ok(result!.diagnostics.length > 0);
  assert.equal(assist.pending.value, null);
  assert.equal(harness.resynced.length, 0);
  scope.stop();
});

test("auto mode applies in-scope changes atomically; deletions still review", async () => {
  const projectId = await seedProject("logic-assist-auto");
  const harness = fakeHost(true);
  const { ai } = fakeAi({ provider: "openai", apiKey: "k", model: "gpt-6.1-sol" });
  const scope = effectScope();
  let nextTurns: readonly LlmTurnResult[] = [];
  const assist = scope.run(() =>
    useLogicProjectAssist({
      ai,
      host: harness.host,
      assistFactory: assistWith(() => scriptedConversation(nextTurns)),
    }),
  )!;
  harness.ws.value = await openEditableProject(projectId);
  const ws = harness.ws.value;
  ws.draft.edit("logic:1", ROOM1, ws.draft.capture().version("logic:1"));

  assist.setApproval({ mode: "auto", scope: ["logic:1"] });
  nextTurns = proposalTurns([{ key: "logic:1", content: ROOM1_AGENT }]);
  await assist.ask("comment it");
  let result = assist.lastResult.value;
  assert.equal(result?.outcome, "applied");
  assert.equal(ws.draft.capture().read("logic:1")?.content, ROOM1_AGENT);
  assert.ok(result?.transaction);
  assert.deepEqual(harness.resynced, [["logic:1"]]);
  // The applied diff stays readable through the handle.
  assert.equal(assist.applied.value?.handle.before("logic:1"), ROOM1);

  // A deletion proposal in auto mode returns to review, never applies.
  nextTurns = proposalTurns([{ key: "inventory", content: null }], "Drop inventory");
  await assist.ask("delete the inventory");
  result = assist.lastResult.value;
  assert.equal(result?.outcome, "review");
  assert.deepEqual([...result!.deletions], ["inventory"]);
  assert.ok(assist.pending.value);
  assert.notEqual(ws.draft.capture().read("inventory"), undefined);
  scope.stop();
});

test("auto apply narrows back to review when the proposal escapes the scope", async () => {
  const projectId = await seedProject("logic-assist-scope");
  const harness = fakeHost(true);
  const { ai } = fakeAi({ provider: "openai", apiKey: "k", model: "gpt-6.1-sol" });
  const scope = effectScope();
  const assist = scope.run(() =>
    useLogicProjectAssist({
      ai,
      host: harness.host,
      assistFactory: assistWith(
        scripted(
          proposalTurns(
            [
              { key: "logic:1", content: ROOM1_AGENT },
              { key: "inventory", content: '[{"name":"brass lamp","startingRoom":1}]' },
            ],
            "Two documents",
          ),
        ),
      ),
    }),
  )!;
  harness.ws.value = await openEditableProject(projectId);
  assist.setApproval({ mode: "auto", scope: ["logic:1"] });
  await assist.ask("change two documents");
  const result = assist.lastResult.value;
  assert.equal(result?.outcome, "review");
  assert.ok(assist.pending.value);
  assert.deepEqual([...result!.keys].sort(), ["inventory", "logic:1"]);
  scope.stop();
});

test("undo refuses a later manual edit conflict; the draft is never forced back", async () => {
  const projectId = await seedProject("logic-assist-conflict");
  const harness = fakeHost();
  const { ai } = fakeAi({ provider: "openai", apiKey: "k", model: "gpt-6.1-sol" });
  const scope = effectScope();
  const assist = scope.run(() =>
    useLogicProjectAssist({
      ai,
      host: harness.host,
      assistFactory: assistWith(
        scripted(proposalTurns([{ key: "logic:1", content: ROOM1_AGENT }])),
      ),
    }),
  )!;
  harness.ws.value = await openEditableProject(projectId);
  const ws = harness.ws.value;
  ws.draft.edit("logic:1", ROOM1, ws.draft.capture().version("logic:1"));
  await assist.ask("comment it");
  assert.equal(assist.accept(), true);

  const later = `${ROOM1_AGENT}\n// creator's later edit`;
  ws.draft.edit("logic:1", later, ws.draft.capture().version("logic:1"));
  assert.equal(assist.undoChanges(), false);
  assert.match(assist.undoNote.value ?? "", /conflict|later edits/i);
  assert.equal(ws.draft.capture().read("logic:1")?.content, later);
  scope.stop();
});

test("a workspace swap closes the old session and drops its review state", async () => {
  const projectId = await seedProject("logic-assist-swap-a");
  const secondId = await seedProject("logic-assist-swap-b");
  const harness = fakeHost();
  const { ai } = fakeAi({ provider: "openai", apiKey: "k", model: "gpt-6.1-sol" });
  const scope = effectScope();
  const assist = scope.run(() =>
    useLogicProjectAssist({
      ai,
      host: harness.host,
      assistFactory: assistWith(
        scripted(proposalTurns([{ key: "logic:1", content: ROOM1_AGENT }])),
      ),
    }),
  )!;
  harness.ws.value = await openEditableProject(projectId);
  const first = harness.ws.value;
  first.draft.edit("logic:1", ROOM1, first.draft.capture().version("logic:1"));
  await assist.ask("comment it");
  assert.ok(assist.pending.value);
  const staleHandle = assist.pending.value!;

  // The host swaps workspaces (a project switch or recovery restore).
  harness.ws.value = await openEditableProject(secondId);
  assist.onWorkspaceSwapped();
  assert.equal(assist.pending.value, null);
  assert.equal(assist.turns.value.length, 0);
  // The old handle is revoked — accepting it must never touch the new draft.
  assert.equal(first.draft.capture().read("logic:1")?.content, ROOM1);
  assert.equal(harness.ws.value.draft.capture().read("logic:1")?.content !== ROOM1_AGENT, true);
  assert.equal(staleHandle.accept().ok, false);

  // The fresh session rebinds locally (still no provider call made).
  assert.equal(assist.connected.value, true);
  assert.equal(assist.state.value.approval.mode, "review");
  scope.stop();
});

test("cancel abandons an in-flight provider wait", async () => {
  const projectId = await seedProject("logic-assist-cancel");
  const harness = fakeHost();
  const { ai } = fakeAi({ provider: "openai", apiKey: "k", model: "gpt-6.1-sol" });
  const { factory, release } = gated();
  const scope = effectScope();
  const assist = scope.run(() =>
    useLogicProjectAssist({
      ai,
      host: harness.host,
      assistFactory: assistWith(factory),
    }),
  )!;
  harness.ws.value = await openEditableProject(projectId);
  const asking = assist.ask("work on the room");
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assist.cancel();
  await asking;
  assert.equal(assist.lastResult.value?.outcome, "cancelled");
  assert.equal(assist.pending.value, null);
  release();
  scope.stop();
});

test("settings changes rebind the session; an explicit disconnect is respected", async () => {
  const projectId = await seedProject("logic-assist-settings");
  const harness = fakeHost();
  const { ai } = fakeAi({ provider: "openai", apiKey: "k", model: "gpt-6.1-sol" });
  const scope = effectScope();
  const assist = scope.run(() =>
    useLogicProjectAssist({
      ai,
      host: harness.host,
      assistFactory: assistWith(scripted([{ text: "ok", toolCalls: [] }])),
    }),
  )!;
  harness.ws.value = await openEditableProject(projectId);
  assert.equal(assist.connected.value, true);
  const epoch = assist.state.value.connectionEpoch;

  // A saved model change rebinds: new epoch, approval reset to Review.
  ai.model.value = "gpt-6.1-mini";
  await nextTick();
  assert.equal(assist.state.value.model, "gpt-6.1-mini");
  assert.ok(assist.state.value.connectionEpoch > epoch);
  assert.equal(assist.state.value.approval.mode, "review");

  // Explicit disconnect: no reactive re-connect until Connect/Ask.
  assist.disconnectNow();
  assert.equal(assist.connected.value, false);
  ai.apiKey.value = "k2";
  await nextTick();
  assert.equal(assist.connected.value, false);
  // Ask itself reconnects with the new settings.
  await assist.ask("ping");
  assert.equal(assist.connected.value, true);
  assert.equal(assist.lastResult.value?.text, "ok");
  scope.stop();
});

test("a kept change leaves the draft clean for it; the room logic is really updated", async () => {
  const projectId = await seedProject("logic-assist-keep");
  const harness = fakeHost();
  const { ai } = fakeAi({ provider: "openai", apiKey: "k", model: "gpt-6.1-sol" });
  const scope = effectScope();
  const assist = scope.run(() =>
    useLogicProjectAssist({
      ai,
      host: harness.host,
      assistFactory: assistWith(
        scripted(proposalTurns([{ key: "logic:1", content: ROOM1_AGENT }])),
      ),
    }),
  )!;
  harness.ws.value = await openEditableProject(projectId);
  const ws = harness.ws.value;
  ws.draft.edit("logic:1", ROOM1, ws.draft.capture().version("logic:1"));
  await assist.ask("comment it");
  assert.equal(assist.accept(), true);
  assert.deepEqual(ws.draft.dirtyKeys(), ["logic:1"]);
  await ws.keepCandidate(ws.buildSelected(["logic:1"]));
  const stored = await storage.loadAuthoredGame(projectId);
  assert.ok(stored);
  assert.deepEqual(ws.draft.dirtyKeys(), []);
  scope.stop();
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createProjectAssist, type ProjectAssistWorkspace } from "../src/agent/projectAssist.ts";
import type { UnifiedConversation } from "../src/agent/llmClient.ts";
import type { AgentRun } from "../src/agent/agentRun.ts";
import { ProjectDraft } from "../../src/authoring/projectDraft.ts";
import { readProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createStarterProject } from "../../src/authoring/starterProject.ts";

function fixture(onEvent?: (kind: string, data?: unknown) => void) {
  const project = createStarterProject("starter");
  const files = Object.fromEntries(project.files());
  const sources: Record<string, string> = {};
  for (const [id, text] of project.sources.logics) sources[`logic:${id}`] = text;
  for (const [id, text] of project.sources.pictures) sources[`picture:${id}`] = text;
  for (const [id, data] of project.sources.views) sources[`view:${id}`] = JSON.stringify(data);
  for (const [id, data] of project.sources.sounds) sources[`sound:${id}`] = JSON.stringify(data);
  sources["words"] = JSON.stringify([...project.sources.words]);
  sources["inventory"] = JSON.stringify(project.sources.objects);
  const documents = readProjectDocuments({
    files,
    sources,
    bindings: project.bindings,
    profileId: project.profileId,
  });
  assert.deepEqual(documents.diagnostics, []);
  const draft = new ProjectDraft(documents.documents);
  const current: {
    workspace: ProjectAssistWorkspace;
    unavailable: boolean;
    beforeRead?: () => void;
  } = {
    workspace: { draft, files, profileId: project.profileId, autoApproveEligible: true },
    unavailable: false,
  };
  const runs: AgentRun[] = [];
  const calls = { sends: 0, completions: 0 };
  let proposeNext = true;
  const assist = createProjectAssist({
    ...(onEvent ? { onEvent: (kind, _detail, data) => onEvent(kind, data) } : {}),
    workspace: () => {
      current.beforeRead?.();
      if (current.unavailable) throw new Error("Workspace has closed");
      return current.workspace;
    },
    conversationFactory: (_config, run) => {
      runs.push(run);
      const propose = proposeNext;
      proposeNext = false;
      const conversation: UnifiedConversation = {
        setAvailableTools() {},
        async sendUserMessage() {
          calls.sends++;
          return {
            toolCalls: propose
              ? [
                  {
                    id: "proposal",
                    name: "propose_project_documents",
                    input: {
                      label: "Add room",
                      changes: [{ key: "logic:9", content: "return;\n" }],
                    },
                  },
                ]
              : [],
          };
        },
        appendToolResults() {},
        async complete() {
          calls.completions++;
          return {
            text: "Ready",
            toolCalls: [],
            ...(onEvent
              ? {
                  telemetry: {
                    provider: "openai" as const,
                    model: "gpt-6.1-sol",
                    requestIndex: 1,
                    promptHash: "prompt",
                    catalogHash: "catalog",
                    responseMs: 1,
                    usageIncomplete: false,
                    toolResultTextBytes: 0,
                    imageCount: 0,
                    imagePixels: 0,
                  },
                }
              : {}),
          };
        },
        getTranscript() {
          return [];
        },
      };
      return conversation;
    },
  });
  assist.connect({ provider: "openai", model: "gpt-6.1-sol", apiKey: "placeholder" });
  return { assist, current, draft, documents: documents.documents, runs, calls };
}

test("a newer request revokes the previous review handle while retaining its diff", async () => {
  const { assist, draft } = fixture();
  const first = await assist.request({ instruction: "Add room" });
  assert.equal(first.outcome, "review");
  assert.ok(first.proposal);
  const before = draft.capture().revision;
  await assist.request({ instruction: "Inspect instead" });
  assert.deepEqual(first.proposal.changes(), [{ key: "logic:9", content: "return;\n" }]);
  assert.equal(first.proposal.accept().ok, false, "superseded request must lose apply authority");
  assert.equal(draft.capture().revision, before);
});

test("reopening the workspace resets explicit auto-approval to Review", () => {
  const { assist, current, documents } = fixture();
  assist.state();
  assist.setApprovalMode({ mode: "auto", scope: ["logic:9"] });
  assert.equal(assist.state().approval.mode, "auto");
  current.workspace = { ...current.workspace, draft: new ProjectDraft(documents) };
  assert.equal(assist.state().approval.mode, "review");
});

test("an unavailable workspace refuses a retained review handle without throwing", async () => {
  const { assist, current, draft } = fixture();
  const result = await assist.request({ instruction: "Add room" });
  assert.equal(result.outcome, "review");
  assert.ok(result.proposal);
  const before = draft.capture().revision;
  current.unavailable = true;
  assert.equal(result.proposal.accept().ok, false);
  assert.equal(draft.capture().revision, before);
});

test("state snapshots cannot mutate the session's request phase", async () => {
  const { assist } = fixture();
  await assist.request({ instruction: "Add room" });
  const state = assist.state();
  assert.equal(state.phase, "idle");
  assert.ok(state.run);
  state.run.status = "paused";
  assert.equal(assist.state().phase, "idle");
});

test("a superseded AgentRun callback cannot overwrite current request state", async () => {
  const { assist, runs } = fixture();
  await assist.request({ instruction: "Add room" });
  await assist.request({ instruction: "Inspect" });
  assert.equal(assist.state().run?.usageIncomplete, false);
  runs[0]!.markUsageIncomplete();
  assert.equal(assist.state().run?.usageIncomplete, false);
});

test("disconnecting during terminal telemetry cancels before issuing a review result", async () => {
  const { assist, draft } = fixture((kind) => {
    if (kind === "telemetry") assist.disconnect();
  });
  const before = draft.capture().revision;
  const result = await assist.request({ instruction: "Add room" });
  assert.equal(result.outcome, "cancelled");
  assert.equal(draft.capture().revision, before);
  assert.equal(assist.state().pendingProposal, null);
});

test("workspace replacement during terminal telemetry cannot auto-apply to the old draft", async () => {
  const { assist, current, draft, documents } = fixture((kind) => {
    if (kind === "telemetry")
      current.workspace = { ...current.workspace, draft: new ProjectDraft(documents) };
  });
  assist.setApprovalMode({ mode: "auto", scope: ["logic:9"] });
  const before = draft.capture().revision;
  const result = await assist.request({ instruction: "Add room" });
  assert.equal(result.outcome, "cancelled");
  assert.equal(
    draft.capture().revision,
    before,
    "old draft is not an apply target after navigation",
  );
  assert.equal(assist.state().approval.mode, "review");
});

test("disconnecting on the initial request event prevents a provider call", async () => {
  const { assist, calls } = fixture((kind) => {
    if (kind === "request") assist.disconnect();
  });
  const result = await assist.request({ instruction: "Add room" });
  assert.equal(result.outcome, "cancelled");
  assert.equal(calls.sends, 0, "a closed connection must not start a paid request");
});

test("disconnecting after a tool result prevents another provider call", async () => {
  const { assist, calls } = fixture((kind) => {
    if (kind === "log") assist.disconnect();
  });
  const result = await assist.request({ instruction: "Add room" });
  assert.equal(result.outcome, "cancelled");
  assert.equal(calls.completions, 0, "no follow-up provider request after disconnect");
});

test("terminal auto-approval uses current host eligibility on the same draft", async () => {
  const { assist, current, draft } = fixture((kind) => {
    if (kind === "telemetry")
      current.workspace = { ...current.workspace, autoApproveEligible: false };
  });
  assist.setApprovalMode({ mode: "auto", scope: ["logic:9"] });
  const before = draft.capture().revision;
  const result = await assist.request({ instruction: "Add room" });
  assert.equal(result.outcome, "review");
  assert.equal(draft.capture().revision, before);
});

test("result data from a state snapshot cannot change the session's retained result", async () => {
  const { assist } = fixture();
  await assist.request({ instruction: "Add room" });
  const observed = assist.state().lastResult;
  assert.ok(observed);
  Reflect.set(observed.keys, 0, "logic:255");
  assert.deepEqual(assist.state().lastResult?.keys, ["logic:9"]);
});

test("a host event sink cannot mutate retained AgentRun state", async () => {
  const { assist } = fixture((kind, data) => {
    if (kind === "state" && data !== null && typeof data === "object" && "status" in data)
      Reflect.set(data, "status", "paused");
  });
  await assist.request({ instruction: "Add room" });
  assert.equal(assist.state().phase, "idle");
});

test("human approval rechecks connection authority after the workspace accessor", async () => {
  const { assist, current, draft } = fixture();
  const result = await assist.request({ instruction: "Add room" });
  assert.equal(result.outcome, "review");
  assert.ok(result.proposal);
  const before = draft.capture().revision;
  current.beforeRead = () => assist.disconnect();
  assert.equal(result.proposal.accept().ok, false);
  assert.equal(draft.capture().revision, before);
});

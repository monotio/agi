import assert from "node:assert/strict";
import { test } from "node:test";
import { createProjectAgent, type ProjectAgentWorkspace } from "../src/agent/projectAgent.ts";
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
    workspace: ProjectAgentWorkspace;
    unavailable: boolean;
    beforeRead?: () => void;
  } = {
    workspace: { draft, files, profileId: project.profileId, autoApproveEligible: true },
    unavailable: false,
  };
  const runs: AgentRun[] = [];
  const calls = { sends: 0, completions: 0 };
  let proposeNext = true;
  const agent = createProjectAgent({
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
                    name: "propose_changes",
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
  agent.connect({ provider: "openai", model: "gpt-6.1-sol", apiKey: "placeholder" });
  return { agent, current, draft, documents: documents.documents, runs, calls };
}

test("a newer request revokes the previous review handle while retaining its diff", async () => {
  const { agent, draft } = fixture();
  const first = await agent.request({ instruction: "Add room" });
  assert.equal(first.outcome, "review");
  assert.ok(first.proposal);
  const before = draft.capture().revision;
  await agent.request({ instruction: "Inspect instead" });
  assert.deepEqual(first.proposal.changes(), [{ key: "logic:9", content: "return;\n" }]);
  assert.equal(first.proposal.accept().ok, false, "superseded request must lose apply authority");
  assert.equal(draft.capture().revision, before);
});

test("reopening the workspace resets explicit auto-approval to Review", () => {
  const { agent, current, documents } = fixture();
  agent.state();
  agent.setApprovalMode({ mode: "auto", scope: ["logic:9"] });
  assert.equal(agent.state().approval.mode, "auto");
  current.workspace = { ...current.workspace, draft: new ProjectDraft(documents) };
  assert.equal(agent.state().approval.mode, "review");
});

test("an unavailable workspace refuses a retained review handle without throwing", async () => {
  const { agent, current, draft } = fixture();
  const result = await agent.request({ instruction: "Add room" });
  assert.equal(result.outcome, "review");
  assert.ok(result.proposal);
  const before = draft.capture().revision;
  current.unavailable = true;
  assert.equal(result.proposal.accept().ok, false);
  assert.equal(draft.capture().revision, before);
});

test("state snapshots cannot mutate the session's request phase", async () => {
  const { agent } = fixture();
  await agent.request({ instruction: "Add room" });
  const state = agent.state();
  assert.equal(state.phase, "idle");
  assert.ok(state.run);
  state.run.status = "paused";
  assert.equal(agent.state().phase, "idle");
});

test("a superseded AgentRun callback cannot overwrite current request state", async () => {
  const { agent, runs } = fixture();
  await agent.request({ instruction: "Add room" });
  await agent.request({ instruction: "Inspect" });
  assert.equal(agent.state().run?.usageIncomplete, false);
  runs[0]!.markUsageIncomplete();
  assert.equal(agent.state().run?.usageIncomplete, false);
});

test("disconnecting during terminal telemetry cancels before issuing a review result", async () => {
  const { agent, draft } = fixture((kind) => {
    if (kind === "telemetry") agent.disconnect();
  });
  const before = draft.capture().revision;
  const result = await agent.request({ instruction: "Add room" });
  assert.equal(result.outcome, "cancelled");
  assert.equal(draft.capture().revision, before);
  assert.equal(agent.state().pendingProposal, null);
});

test("workspace replacement during terminal telemetry cannot auto-apply to the old draft", async () => {
  const { agent, current, draft, documents } = fixture((kind) => {
    if (kind === "telemetry")
      current.workspace = { ...current.workspace, draft: new ProjectDraft(documents) };
  });
  agent.setApprovalMode({ mode: "auto", scope: ["logic:9"] });
  const before = draft.capture().revision;
  const result = await agent.request({ instruction: "Add room" });
  assert.equal(result.outcome, "cancelled");
  assert.equal(
    draft.capture().revision,
    before,
    "old draft is not an apply target after navigation",
  );
  assert.equal(agent.state().approval.mode, "review");
});

test("disconnecting on the initial request event prevents a provider call", async () => {
  const { agent, calls } = fixture((kind) => {
    if (kind === "request") agent.disconnect();
  });
  const result = await agent.request({ instruction: "Add room" });
  assert.equal(result.outcome, "cancelled");
  assert.equal(calls.sends, 0, "a closed connection must not start a paid request");
});

test("disconnecting after a tool result prevents another provider call", async () => {
  const { agent, calls } = fixture((kind) => {
    if (kind === "log") agent.disconnect();
  });
  const result = await agent.request({ instruction: "Add room" });
  assert.equal(result.outcome, "cancelled");
  assert.equal(calls.completions, 0, "no follow-up provider request after disconnect");
});

test("terminal auto-approval uses current host eligibility on the same draft", async () => {
  const { agent, current, draft } = fixture((kind) => {
    if (kind === "telemetry")
      current.workspace = { ...current.workspace, autoApproveEligible: false };
  });
  agent.setApprovalMode({ mode: "auto", scope: ["logic:9"] });
  const before = draft.capture().revision;
  const result = await agent.request({ instruction: "Add room" });
  assert.equal(result.outcome, "review");
  assert.equal(draft.capture().revision, before);
});

test("result data from a state snapshot cannot change the session's retained result", async () => {
  const { agent } = fixture();
  await agent.request({ instruction: "Add room" });
  const observed = agent.state().lastResult;
  assert.ok(observed);
  Reflect.set(observed.keys, 0, "logic:255");
  assert.deepEqual(agent.state().lastResult?.keys, ["logic:9"]);
});

test("a host event sink cannot mutate retained AgentRun state", async () => {
  const { agent } = fixture((kind, data) => {
    if (kind === "state" && data !== null && typeof data === "object" && "status" in data)
      Reflect.set(data, "status", "paused");
  });
  await agent.request({ instruction: "Add room" });
  assert.equal(agent.state().phase, "idle");
});

test("human approval rechecks connection authority after the workspace accessor", async () => {
  const { agent, current, draft } = fixture();
  const result = await agent.request({ instruction: "Add room" });
  assert.equal(result.outcome, "review");
  assert.ok(result.proposal);
  const before = draft.capture().revision;
  current.beforeRead = () => agent.disconnect();
  assert.equal(result.proposal.accept().ok, false);
  assert.equal(draft.capture().revision, before);
});

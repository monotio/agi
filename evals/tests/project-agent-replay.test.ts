/** Replay whole-project task failures through the real coordinated candidate pipeline. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { createWorkspaceAgent } from "../../app/src/agent/workspaceAgent.ts";
import type { LlmTurnResult } from "../../app/src/agent/llmClient.ts";
import { openProjectSession } from "../../app/src/project/projectSession.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { createContainer } from "../../src/container/container.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
interface Case {
  name: string;
  projectAgent?: {
    documents: Record<string, string | number[]>;
    request: string;
    turns: LlmTurnResult[];
    expectedKeys: string[];
    expectedOutcomes?: Record<string, boolean>;
    expectedError?: string;
    autoApprove?: boolean;
    expectedCommits?: number;
    expectedDocuments?: Record<string, string | null>;
  };
}
const directory = new URL("../fixtures/bad-cases/", import.meta.url);
for (const file of readdirSync(directory).filter((file) => file.endsWith(".json"))) {
  const stored = JSON.parse(readFileSync(new URL(file, directory), "utf8")) as Case;
  const content = stored.projectAgent;
  if (!content) continue;
  test(`replays project agent bad case: ${stored.name}`, async () => {
    const documents = Object.fromEntries(
      Object.entries(content.documents).map(([key, value]) => [
        key,
        typeof value === "string" ? value : Uint8Array.from(value),
      ]),
    );
    const compiled = compileProjectDocuments({
      files: Object.fromEntries(createContainer().files),
      documents,
      profileId: "2.936",
    });
    const session = openProjectSession({
      data: {
        projectId: requireProjectId(stored.name),
        title: "Replay",
        authoredAt: "",
        files: Object.fromEntries(compiled.files()),
        words: [],
        workspace: writeProjectWorkspace(documents),
      },
      lifetime: "replay",
      admission: {
        runToken: "replay",
        async admit() {
          return { status: "committed", expected: null, current: null, patchGeneration: 1 };
        },
      },
      async write(request) {
        return {
          commitId: request.commitId,
          workspaceId: request.workspaceId,
          candidateHash: "a",
          documents: request.documents,
          saved: {
            ...request.expected!,
            generation: request.expected!.generation + 1,
            buildId: request.buildId,
          },
        };
      },
    });
    let round = 0;
    const agent = createWorkspaceAgent({
      session,
      profileId: "2.936",
      config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
      conversation() {
        return {
          setAvailableTools() {},
          async sendUserMessage() {
            return content.turns[round++]!;
          },
          appendToolResults(results) {
            for (const entry of results)
              assert.equal(
                entry.result.success,
                content.expectedOutcomes?.[entry.toolCallId] ?? true,
                JSON.stringify({
                  toolCallId: entry.toolCallId,
                  success: entry.result.success,
                  error: entry.result.error,
                }),
              );
          },
          async complete() {
            return content.turns[round++]!;
          },
          getTranscript() {
            return [];
          },
        };
      },
    });
    agent.autoApprove = content.autoApprove ?? false;
    try {
      if (content.expectedError)
        await assert.rejects(agent.send(content.request), new RegExp(content.expectedError));
      else await agent.send(content.request);
      assert.deepEqual(
        agent
          .pending()
          ?.changes()
          .map((change) => change.key) ?? [],
        content.expectedKeys,
      );
      assert.equal(session.history.capture().commits.length, content.expectedCommits ?? 1);
      for (const [key, value] of Object.entries(content.expectedDocuments ?? {}))
        assert.equal(session.model.capture().read(key)?.content ?? null, value);
    } finally {
      session.dispose();
    }
  });
}

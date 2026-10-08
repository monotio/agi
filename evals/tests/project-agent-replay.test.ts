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
import { prepareLocalProject } from "../../app/src/project/localProject.ts";
import { inspectEditableProject } from "../../app/src/project/projectWorkspaceSource.ts";
import { buildProjectZip } from "../../app/src/archive/projectArchive.ts";
import { readGameZip } from "../../app/src/archive/gameZip.ts";
import type { CachedGameData } from "../../app/src/project/gameTypes.ts";
import { openContainer } from "../../src/container/container.ts";
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
    readOnly?: boolean;
    unreadableSound?: number;
    starterProject?: boolean;
    approveAndExportSound?: number;
    expectedSoundPayload?: number[];
  };
}
const directory = new URL("../fixtures/bad-cases/", import.meta.url);
for (const file of readdirSync(directory).filter((file) => file.endsWith(".json"))) {
  const stored = JSON.parse(readFileSync(new URL(file, directory), "utf8")) as Case;
  const content = stored.projectAgent;
  if (!content) continue;
  test(`replays project agent bad case: ${stored.name}`, async () => {
    const starter = content.starterProject
      ? prepareLocalProject({ title: "Replay", kind: "starter" }).data()
      : undefined;
    const documents = Object.fromEntries(
      Object.entries(content.documents).map(([key, value]) => [
        key,
        typeof value === "string" ? value : Uint8Array.from(value),
      ]),
    );
    const compiled = compileProjectDocuments({
      files: starter?.files ?? Object.fromEntries(createContainer().files),
      documents: {
        ...(starter === undefined
          ? {}
          : inspectEditableProject({
              ...starter,
              projectId: requireProjectId(stored.name),
              authoredAt: "",
            }).documents),
        ...documents,
      },
      profileId: "2.936",
    });
    const files = Object.fromEntries(compiled.files());
    if (content.unreadableSound !== undefined) {
      const directory = new Uint8Array((content.unreadableSound + 1) * 3).fill(255);
      directory.set(files["SNDDIR"]!);
      directory.set([1, 255, 255], content.unreadableSound * 3);
      files["SNDDIR"] = directory;
    }
    let published: CachedGameData | undefined;
    let saved: CachedGameData | undefined;
    const session = openProjectSession({
      data: {
        ...starter,
        projectId: requireProjectId(stored.name),
        title: "Replay",
        authoredAt: "",
        files,
        words: [],
        workspace: writeProjectWorkspace(compiled.documents()),
      },
      lifetime: "replay",
      admission: {
        runToken: "replay",
        async admit() {
          return { status: "committed", expected: null, current: null, patchGeneration: 1 };
        },
      },
      publish(_snapshot, data) {
        published = { ...data, projectId: requireProjectId(stored.name), authoredAt: "" };
      },
      async write(request) {
        saved = { ...request.data, projectId: requireProjectId(stored.name), authoredAt: "" };
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
      else if (content.readOnly) {
        const before = session.model.capture();
        await agent.ask(content.request);
        assert.equal(session.model.capture().documentId, before.documentId);
        assert.deepEqual(
          Object.fromEntries(session.model.capture().lastAdmissibleBuild!.files()),
          files,
        );
      } else await agent.send(content.request);
      assert.deepEqual(
        agent
          .pending()
          ?.changes()
          .map((change) => change.key) ?? [],
        content.expectedKeys,
      );
      assert.equal(session.history.capture().commits.length, content.expectedCommits ?? 1);
      if (content.approveAndExportSound !== undefined) {
        assert.ok(content.expectedSoundPayload);
        const key = `sound:${content.approveAndExportSound}`;
        const source = agent
          .pending()!
          .changes()
          .find((change) => change.key === key)!.content;
        await agent.approve();
        assert.ok(published);
        const immediate = await readGameZip(await buildProjectZip(published));
        await session.flush();
        assert.ok(saved);
        const reopened = await readGameZip(await buildProjectZip(saved));
        for (const archive of [immediate, reopened]) {
          assert.deepEqual(
            archive.files,
            Object.fromEntries(session.model.capture().lastAdmissibleBuild!.files()),
          );
          const claims = archive.project!.authoringState!["sources"] as {
            sounds: [number, unknown][];
          };
          assert.deepEqual(
            claims.sounds.find(([num]) => num === content.approveAndExportSound)![1],
            JSON.parse(String(source)),
          );
          assert.deepEqual(
            openContainer(new Map(Object.entries(archive.files))).getResource(
              "sound",
              content.approveAndExportSound,
            ),
            Uint8Array.from(content.expectedSoundPayload!),
          );
        }
      }
      for (const [key, value] of Object.entries(content.expectedDocuments ?? {}))
        assert.equal(session.model.capture().read(key)?.content ?? null, value);
    } finally {
      session.dispose();
    }
  });
}

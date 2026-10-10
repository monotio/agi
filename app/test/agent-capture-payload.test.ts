import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceAgent } from "../src/agent/workspaceAgent.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import {
  readProjectWorkspace,
  writeProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import { createContainer } from "../../src/container/container.ts";
import { traceImageChanges } from "../../src/creative/imageOperations.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import type { ProjectContent } from "../../src/authoring/projectContent.ts";
import { readAgentChats } from "../../src/agent/chats.ts";
import { capturedResourceDocuments } from "../src/agent/agentResultPreview.ts";
import { testProjectId } from "./identity.ts";

function fixture() {
  const rgba = new Uint8Array(512 * 512 * 4).fill(255);
  const image = {
    title: "Reference",
    mime: "image/png",
    width: 512,
    height: 512,
    rgba,
    encoded: encodePngRgba(512, 512, rgba),
  };
  const documents: Record<string, ProjectContent> = {
    words: "[]",
    inventory: "[]",
    bindings: "{}",
    "picture:7": "end",
    ...Object.fromEntries(Array.from({ length: 5 }, (_, n) => [`logic:${n}`, "return;"])),
  };
  for (const change of traceImageChanges(documents, "picture:7", image))
    documents[change.key] = change.content!;
  const compiled = compileProjectDocuments({
    documents,
    files: Object.fromEntries(createContainer().files),
    profileId: "2.936",
  });
  const session = openProjectSession({
    data: {
      projectId: testProjectId("capture-payload"),
      title: "Capture",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(documents),
    },
    lifetime: "capture",
    admission: {
      runToken: "capture",
      async admit() {
        assert.fail("Inspection attempted admission");
      },
    },
    async write(request) {
      return {
        commitId: request.commitId,
        workspaceId: request.workspaceId,
        candidateHash: "a",
        documents: request.documents,
        saved: { ...request.expected!, generation: request.expected!.generation + 1 },
      };
    },
  });
  let model = "first";
  const requests: string[] = [];
  const reopenAgent = () =>
    createWorkspaceAgent({
      session,
      profileId: "2.936",
      config: () => ({ provider: "stub", model, apiKey: "" }),
      conversation() {
        return {
          setAvailableTools() {},
          async sendUserMessage(text) {
            requests.push(text);
            if (text.includes("compaction summary pattern"))
              return { text: "Objective: inspect the five logics. Next: continue.", toolCalls: [] };
            if (model === "second") return { text: "Continued", toolCalls: [] };
            return {
              toolCalls: Array.from({ length: 5 }, (_, n) => ({
                id: `read-${n}`,
                name: "read_document",
                input: { key: `logic:${n}`, offset: null, limit: null },
              })),
            };
          },
          appendToolResults(entries) {
            assert.ok(entries.every((entry) => entry.result.success));
          },
          async complete() {
            return { text: "Inspected five logics", toolCalls: [] };
          },
          getTranscript() {
            return [];
          },
        };
      },
    });
  return {
    agent: reopenAgent(),
    reopenAgent,
    session,
    documents,
    requests,
    switchModel() {
      model = "second";
    },
  };
}

test("five unrelated LOGIC reads retain metadata without the real image attachment or aggregate copy", async (t) => {
  const { agent, session, documents } = fixture();
  try {
    const attachments = Object.values(documents).filter((content) => content instanceof Uint8Array);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.byteLength, 1_049_249);
    await agent.submit({ instruction: "Inspect five logics", mode: "play" });
    const result = agent.current().messages.at(-1)!.result;
    if (result?.kind !== "resources") assert.fail("Missing capture");
    const snapshots = [
      ...Object.values(result.resourceSnapshots ?? {}),
      ...(result.snapshot ? [result.snapshot] : []),
    ];
    const attachmentCopies = snapshots
      .flatMap((snapshot) => Object.entries(readProjectWorkspace(snapshot)))
      .filter(([key, content]) => key.startsWith("attachment:") && content instanceof Uint8Array);
    t.diagnostic(
      `Captured result: ${attachmentCopies.length} attachment copies, ${JSON.stringify(result).length} characters`,
    );
    assert.equal(
      attachmentCopies.reduce(
        (bytes, [, content]) => bytes + (content as Uint8Array).byteLength,
        0,
      ),
      0,
    );
    for (const snapshot of Object.values(result.resourceSnapshots!)) {
      const captured = readProjectWorkspace(snapshot);
      assert.deepEqual(
        Object.keys(captured).filter((key) => key.startsWith("attachment:")),
        [],
      );
      assert.equal(captured["images"], undefined);
      assert.equal(captured["words"], "[]");
      assert.equal(captured["bindings"], "{}");
    }
    assert.equal(result.snapshot, undefined);
    const loaded = readAgentChats(
      JSON.parse(
        JSON.stringify({
          format: "monotio.agi.chats",
          version: 1,
          active: agent.current().id,
          chats: [agent.current()],
        }),
      ),
    );
    const saved = loaded.chats[0]!.messages.at(-1)!.result;
    if (saved?.kind !== "resources") assert.fail("Missing saved capture");
    for (const key of saved.resources)
      assert.equal(capturedResourceDocuments(saved, key)[key], "return;");
  } finally {
    session.dispose();
  }
});

test("model handoff sends conversation and resource identities without legacy preview bytes", async (t) => {
  const { agent, reopenAgent, session, documents, requests, switchModel } = fixture();
  try {
    await agent.submit({ instruction: "Inspect five logics", mode: "play" });
    const chat = agent.current();
    // A saved aggregate-only preview from the previous writer must also be safe to hand off.
    chat.messages = chat.messages.map((message) =>
      message.result?.kind === "resources"
        ? {
            ...message,
            result: {
              kind: "resources",
              documentId: message.result.documentId,
              resources: message.result.resources,
              snapshot: writeProjectWorkspace(documents),
            },
          }
        : message,
    );
    await session.saveChats({
      format: "monotio.agi.chats",
      version: 1,
      active: chat.id,
      chats: [chat],
    });
    const reloaded = reopenAgent();
    switchModel();
    await reloaded.submit({ instruction: "Continue", mode: "play" });
    const handoff = requests.find((text) => text.includes("compaction summary pattern"))!;
    assert.ok(handoff);
    t.diagnostic(`Handoff input: ${handoff.length} characters`);
    assert.doesNotMatch(handoff, /snapshot|attachment:|agi\.project-workspace|1049249/);
    assert.match(handoff, /Inspected five logics/);
    for (let n = 0; n < 5; n++) assert.ok(handoff.includes(`logic:${n}`));
  } finally {
    session.dispose();
  }
});

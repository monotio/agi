import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkspaceAgent } from "../src/agent/workspaceAgent.ts";
import { WORKSPACE_AGENT_TOOLS } from "../src/agent/workspaceAgentTools.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { traceImageChanges, readImageReferences } from "../../src/creative/imageOperations.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { parseView } from "../../src/view/view.ts";
import type { ProjectContent } from "../../src/authoring/projectContent.ts";
import type { LlmTurnResult } from "../src/agent/llmClient.ts";
import { testProjectId } from "./identity.ts";

const rgba = Uint8Array.of(255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255);
const image = {
  title: "Two frames",
  mime: "image/png",
  encoded: encodePngRgba(3, 1, rgba),
  width: 3,
  height: 1,
  rgba,
};
const hash = sha256Hex(image.encoded);
function fixture(turns: LlmTurnResult[]) {
  const documents: Record<string, ProjectContent> = {
    "logic:0": "return;",
    "picture:1": "end",
    "picture:2": "end",
    words: "[]",
    bindings: "{}",
  };
  for (const change of traceImageChanges(documents, "picture:1", image))
    documents[change.key] = change.content!;
  const compiled = compileProjectDocuments({
    documents,
    files: Object.fromEntries(createContainer().files),
    profileId: "2.936",
  });
  const writes: string[] = [];
  const session = openProjectSession({
    data: {
      projectId: testProjectId("agent-images"),
      title: "Images",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(documents),
    },
    lifetime: "images",
    admission: {
      runToken: "images",
      async admit() {
        return { status: "committed", expected: null, current: null, patchGeneration: 1 };
      },
    },
    async write(request) {
      writes.push(request.commitId);
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
  const results: boolean[] = [];
  const agent = createWorkspaceAgent({
    session,
    profileId: "2.936",
    config: () => ({ provider: "stub", model: "stub", apiKey: "" }),
    conversation() {
      return {
        setAvailableTools() {},
        async sendUserMessage() {
          return turns[round++]!;
        },
        appendToolResults(entries) {
          results.push(...entries.map((entry) => entry.result.success));
        },
        async complete() {
          return turns[round++]!;
        },
        getTranscript() {
          return [];
        },
      };
    },
  });
  return { agent, session, writes, results, documents };
}
const call = (name: string, input: Record<string, unknown>): LlmTurnResult => ({
  toolCalls: [{ id: name, name, input }],
});
const done: LlmTurnResult = { text: "Prepared the image.", toolCalls: [] };

test("image tools have canonical vocabulary descriptions and stage complete review proposals", async () => {
  for (const name of ["trace_an_image", "make_cels_from_an_image"])
    assert.ok(
      WORKSPACE_AGENT_TOOLS.some((tool) => tool.name === name),
      name,
    );
  const { agent, session, results, documents } = fixture([
    call("trace_an_image", { target: "picture:2", image: hash, opacity: 0.6 }),
    call("make_cels_from_an_image", { target: "view:3", image: hash, frames: null }),
    call("write_picture", { room: 2, source: "vis 4\nfill 0,0\nend" }),
    call("propose_changes", {
      label: "Image task",
      changes: [{ key: "logic:0", content: 'print("Art"); return;' }],
    }),
    done,
  ]);
  try {
    await agent.send("Use the saved image for tracing and cels");
    assert.deepEqual(results, [true, true, true, true]);
    assert.deepEqual(
      agent
        .pending()!
        .changes()
        .map((change) => change.key),
      ["images", "logic:0", "picture:2", "view:3"],
    );
    assert.equal(session.history.capture().commits.length, 1);
    assert.deepEqual(session.model.capture().documents(), documents);
    await agent.approve();
    const commit = session.history.capture().commits.at(-1)!;
    assert.equal(commit.author, "agent");
    assert.equal(commit.origin, "agent");
    const after = session.model.capture();
    assert.equal(readImageReferences(after.documents()).traces["picture:2"]?.opacity, 0.6);
    const container = openContainer(after.lastAdmissibleBuild!.files());
    const cels = parseView(container.getResource("view", 3)!).loops[0]!.cels;
    assert.equal(cels.length, 2);
    assert.deepEqual(Array.from(cels[0]!.pixels), [4]);
    assert.deepEqual(Array.from(cels[1]!.pixels), [2]);
    await session.undo();
    assert.deepEqual(session.model.capture().documents(), documents);
  } finally {
    session.dispose();
  }
});

test("image tools auto-approve through History, withdraw cleanly and refuse unknown images", async () => {
  const { agent, session, results } = fixture([
    call("trace_an_image", { target: "picture:2", image: hash, opacity: 0.7 }),
    done,
  ]);
  try {
    agent.autoApprove = true;
    await agent.send("Trace the image");
    assert.deepEqual(results, [true]);
    assert.equal(agent.pending(), null);
    assert.equal(session.history.capture().commits.length, 2);
  } finally {
    session.dispose();
  }
  for (const turns of [
    [call("trace_an_image", { target: "picture:2", image: "0".repeat(64), opacity: 0.5 }), done],
    [
      call("trace_an_image", { target: "picture:2", image: hash, opacity: 0.5 }),
      call("withdraw_changes", { reason: null }),
      done,
    ],
  ]) {
    const { agent, session, results } = fixture(turns);
    try {
      await agent.send("Prepare tracing");
      assert.deepEqual(results, turns.length === 2 ? [false] : [true, true]);
      assert.equal(agent.pending(), null);
      assert.equal(session.history.capture().commits.length, 1);
    } finally {
      session.dispose();
    }
  }
});

test("PICTURE review draws an image traced over the art across every pixel, as the editor does", async () => {
  const { pictureReviewPixels } = await import("../src/agent/workspaceImageReview.ts");
  const documents: Record<string, ProjectContent> = {};
  for (const change of traceImageChanges(documents, "picture:2", image, 0.6))
    documents[change.key] = change.content!;
  const visual = new Uint8Array(160 * 168).fill(15);
  visual[84 * 160 + 40] = 1;
  const after = pictureReviewPixels(visual, documents, "picture:2");
  // 60% EGA red over the blue mark: (0, 0, 170) * 0.4 + (170, 0, 0) * 0.6.
  assert.deepEqual(
    Array.from(after.slice((84 * 320 + 80) * 4, (84 * 320 + 80) * 4 + 4)),
    [102, 0, 68, 255],
  );
  assert.deepEqual(
    Array.from(after.slice((84 * 320 + 82) * 4, (84 * 320 + 82) * 4 + 4)),
    [204, 102, 102, 255],
  );
});

test("PICTURE review shows a changed tracing layer below native marks", async () => {
  const { pictureReviewPixels, imageReviewTargets } =
    await import("../src/agent/workspaceImageReview.ts");
  const documents: Record<string, ProjectContent> = {};
  for (const change of traceImageChanges(documents, "picture:2", image, 0.6, true))
    documents[change.key] = change.content!;
  const visual = new Uint8Array(160 * 168).fill(15);
  visual[84 * 160 + 40] = 1;
  const before = pictureReviewPixels(visual, {}, "picture:2");
  const after = pictureReviewPixels(visual, documents, "picture:2");
  assert.deepEqual(
    Array.from(after.slice((84 * 320 + 80) * 4, (84 * 320 + 80) * 4 + 4)),
    [0, 0, 170, 255],
  );
  assert.deepEqual(
    Array.from(before.slice((84 * 320 + 82) * 4, (84 * 320 + 82) * 4 + 4)),
    [255, 255, 255, 255],
  );
  assert.deepEqual(
    Array.from(after.slice((84 * 320 + 82) * 4, (84 * 320 + 82) * 4 + 4)),
    [204, 102, 102, 255],
  );
  assert.deepEqual(Array.from(after.slice(0, 4)), [255, 255, 255, 255]);
  assert.deepEqual(imageReviewTargets({}, documents), ["picture:2"]);
  assert.deepEqual(imageReviewTargets(documents, documents), []);
});

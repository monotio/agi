import { compilePictureSource } from "../../src/picture/source.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerContext } from "../src/worker/context.ts";
import { createEngineHost } from "../src/worker/host.ts";
import { onWorkerMessage } from "../src/worker/dispatch.ts";
import { openProjectSession } from "../src/project/projectSession.ts";
import { createMainProjectAdmission } from "../src/engine/mainProjectAdmission.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import { decodeTextRows } from "../src/project/gameTypes.ts";
import { requireProjectId } from "../../src/gameIdentity.ts";
import type {
  WorkerControl,
  WorkerInbound,
  WorkerPresentation,
  WorkerQueryFn,
} from "../src/worker/workerProtocol.ts";

test("an authored room answer joins History and keeps its parked print in every frame", async () => {
  const roomSource =
    'if (isset(f5)) { assignn(v50,2); load.pic(v50); draw.pic(v50); show.pic(); print("You stand in generated room 2."); } return;';
  const documents = {
    "logic:0": "if (v40 == 0) { assignn(v40,1); new.room(2); } call.v(v0); return;",
    words: "[]",
  };
  const compiled = compileProjectDocuments({
    files: Object.fromEntries(createContainer().files),
    documents,
    profileId: "2.936",
  });
  const messages: WorkerControl[] = [];
  const frames: Extract<WorkerPresentation, { type: "frame" }>[] = [];
  let now = 0;
  const ctx = createWorkerContext({
    control: (message) => messages.push(message),
    presentation: (message) => {
      if (message.type === "frame") frames.push(message);
    },
    now: () => now,
    seedWord: () => 1,
  });
  ctx.host = createEngineHost(ctx);
  onWorkerMessage(ctx, {
    type: "boot",
    files: Object.fromEntries(compiled.files()),
    words: [],
    profile: "2.936",
    authorRooms: true,
    projectMode: "create",
  });
  await ctx.projectLoader.loading;
  ctx.fns.stopTimers();
  const ack = messages.find((message) => message.type === "booted");
  assert.ok(ack?.type === "booted" && ack.projectAdmission);
  let queryId = 100;
  const query = (async (type, extra) => {
    const id = ++queryId;
    onWorkerMessage(ctx, { type, id, ...extra } as WorkerInbound);
    return messages.findLast((message) => "id" in message && message.id === id);
  }) as WorkerQueryFn;
  const admission = createMainProjectAdmission({
    ...ack.projectAdmission,
    query,
    current: () => ctx.run.engine !== null,
  });
  const session = openProjectSession({
    data: {
      projectId: requireProjectId("agent-room-worker"),
      title: "Room",
      authoredAt: "",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(documents),
      roomGeneration: true,
    },
    lifetime: "test",
    admission,
    boundary: async () => {
      now += 100;
      ctx.fns.tickEngine();
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
  now += 100;
  ctx.fns.tickEngine();
  const request = messages.find(
    (message) => message.type === "hostRequest" && message.op === "room",
  );
  assert.ok(request?.type === "hostRequest");
  const base = session.model.capture();
  const changes = [
    { key: "logic:2", content: roomSource },
    { key: "picture:2", content: "vis 2\nfill 0,0\nend\n" },
  ];
  const candidate = compileProjectDocuments({
    files: Object.fromEntries(compiled.files()),
    documents: { ...documents, "logic:2": roomSource, "picture:2": "vis 2\nfill 0,0\nend\n" },
    profileId: "2.936",
  });
  const image = openContainer(candidate.files());
  onWorkerMessage(ctx, {
    type: "hostAnswer",
    generation: ctx.run.generation,
    id: request.id,
    response: JSON.stringify({
      room: 2,
      resources: ["logic", "picture"].map((kind) => ({
        kind,
        num: 2,
        data: Array.from(image.getResource(kind as "logic" | "picture", 2)!),
      })),
    }),
  });
  ctx.fns.postFrame();
  assert.equal(ctx.run.engine!.modalKind, "print");
  const parked = ctx.run.engine!.getPresentation().text;
  assert.match(decodeTextRows(parked).join(" "), /You stand in generated room 2\./);
  const firstPrint = frames.length - 1;
  const result = await session.submitPreparedRoom({
    proposal: session.model.propose(base, "Built room 2", changes),
    label: "AI: Built room 2",
    author: "agent",
    origin: "agent",
    chatId: "room-task",
    messageId: "result",
  });
  assert.ok(["committed", "unchanged"].includes(result.status), JSON.stringify(result));
  assert.equal(session.history.capture().commits.at(-1)!.chatId, "room-task");
  assert.equal(session.model.capture().read("logic:2")!.content, roomSource);
  ctx.fns.postFrame();
  assert.equal(
    ctx.run.engine!.modalKind,
    "print",
    "adopting the authored bytes keeps the window parked",
  );
  for (const frame of frames.slice(firstPrint)) {
    assert.equal(frame.modal, "print");
    assert.deepEqual(frame.text, parked, `cycle ${frame.cycle} keeps the complete print surface`);
  }
  const cursor = session.history.capture().cursor;
  const lateAdmission = createMainProjectAdmission({
    ...ack.projectAdmission,
    query,
    current: () => ctx.run.engine !== null,
    acceptedImage: () => session.model.capture().lastAdmissibleBuild,
  });
  const next = compileProjectDocuments({
    files: Object.fromEntries(candidate.files()),
    documents: { ...candidate.documents(), notes: "Edited after the live room." },
    profileId: "2.936",
  });
  const following = await lateAdmission.admit(next, []);
  assert.ok(["committed", "unchanged"].includes(following.status), JSON.stringify(following));
  ctx.run.engine!.patchResources([
    { kind: "picture", num: 2, payload: compilePictureSource("vis 3\nfill 0,0\nend\n").bytes },
  ]);
  const unowned = await lateAdmission.admit(next, []);
  assert.equal(unowned.status, "refused", "an unrelated native change cannot be rebased");
  await assert.rejects(
    () =>
      session.submitPreparedRoom({
        proposal: session.model.propose(session.model.capture(), "Conflict", [
          { key: "notes", content: "A later lesson." },
        ]),
        label: "AI: Conflict",
        author: "agent",
        origin: "agent",
        chatId: "room-task",
        messageId: "later",
      }),
    /The game changed while this room was being built\. Reopen the game, then try again\./,
  );
  assert.equal(session.history.capture().cursor, cursor);
  assert.equal(session.model.capture().read("notes"), undefined);
  session.dispose();
  ctx.fns.stopTimers();
});

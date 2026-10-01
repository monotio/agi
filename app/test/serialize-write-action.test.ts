import assert from "node:assert/strict";
import { test } from "node:test";
import { testProjectId } from "./identity.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import {
  runInWriteTurn,
  serializeWrite,
  serializeWriteAction,
  type OwnedWriteTurn,
} from "../src/project/gameStorage.ts";
import { captureCreativeProjectInTurn } from "../src/project/creativeProjectSnapshot.ts";

installIndexedDbFixture();

test("a loading action runs its nested writes inside the turn it was issued", async () => {
  const events: string[] = [];
  await serializeWriteAction("turn-nested", async (turn) => {
    events.push("action");
    await runInWriteTurn(turn, "turn-nested", async () => {
      events.push("nested");
    });
    events.push("done");
  });
  assert.deepEqual(events, ["action", "nested", "done"]);
});

test("an external writer stays behind while a suspended action's nested work completes", async () => {
  const key = "turn-external";
  const events: string[] = [];
  let entered!: () => void;
  const running = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const suspended = new Promise<void>((resolve) => (release = resolve));
  const action = serializeWriteAction(key, async (turn) => {
    events.push("capture-start");
    entered();
    // The suspended point stands in for the module load a lazy boundary
    // makes: the slot is still held while it resolves.
    await suspended;
    await runInWriteTurn(turn, key, async () => {
      events.push("nested-read");
    });
    events.push("capture-end");
  });
  await running;
  const external = serializeWrite(key, async () => {
    events.push("external-delete");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["capture-start"], "the external writer must wait out the load");
  release();
  await Promise.all([action, external]);
  assert.deepEqual(events, ["capture-start", "nested-read", "capture-end", "external-delete"]);
});

test("a refusing nested write releases the queue for waiting writers", async () => {
  const key = "turn-refusal";
  const events: string[] = [];
  let release!: () => void;
  const suspended = new Promise<void>((resolve) => (release = resolve));
  const action = serializeWriteAction(key, async (turn) => {
    await suspended;
    await runInWriteTurn(turn, key, async () => {
      throw new Error("Named nested refusal");
    });
  });
  const settled = assert.rejects(action, /Named nested refusal/);
  const external = serializeWrite(key, async () => {
    events.push("external");
  });
  release();
  await Promise.all([settled, external]);
  assert.deepEqual(events, ["external"]);
});

test("a turn never issued refuses instead of running", async () => {
  const events: string[] = [];
  await assert.rejects(
    runInWriteTurn({} as OwnedWriteTurn, "turn-foreign", async () => {
      events.push("foreign");
    }),
    /write turn/,
  );
  assert.deepEqual(events, []);
});

test("a settled turn and a turn for another key both refuse", async () => {
  let held!: OwnedWriteTurn;
  await serializeWriteAction("turn-a", async (turn) => {
    held = turn;
    await assert.rejects(
      runInWriteTurn(turn, "turn-b", async () => {}),
      /write turn/,
    );
  });
  await assert.rejects(
    runInWriteTurn(held, "turn-a", async () => {}),
    /write turn/,
  );
});

test("a suspended loading action never holds another key's queue", async () => {
  const events: string[] = [];
  let release!: () => void;
  const suspended = new Promise<void>((resolve) => (release = resolve));
  const action = serializeWriteAction("turn-key-a", async () => {
    await suspended;
    events.push("a");
  });
  await serializeWrite("turn-key-b", async () => {
    events.push("b");
  });
  assert.deepEqual(events, ["b"]);
  release();
  await action;
  assert.deepEqual(events, ["b", "a"]);
});

test("the in-turn capture reads inside the held slot and refuses a foreign turn", async () => {
  const project = testProjectId("turn-capture");
  // A fabricated turn refuses before a single record is read.
  await assert.rejects(captureCreativeProjectInTurn({} as OwnedWriteTurn, project), /write turn/);
  // Inside the owned turn the capture runs to its storage contract: a
  // missing body refuses by name rather than answering an empty snapshot.
  await serializeWriteAction(project, async (turn) =>
    assert.rejects(captureCreativeProjectInTurn(turn, project), /body record is missing/),
  );
});

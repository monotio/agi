import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeWrite, serializeWriteAction } from "../src/project/gameStorage.ts";

for (const outcome of ["complete", "refuse"] as const) {
  test(`an unrelated same-project writer waits for a suspended loading action to ${outcome}`, async () => {
    const key = `loading-review-${outcome}`;
    const events: string[] = [];
    let entered!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const suspended = new Promise<void>((resolve) => {
      release = resolve;
    });
    const action = serializeWriteAction(key, async () => {
      events.push("capture-start");
      entered();
      await suspended;
      events.push("capture-end");
      if (outcome === "refuse") throw new Error("Named capture refusal");
    });
    const settled = action.catch((error: unknown) => {
      assert.equal(outcome, "refuse");
      assert.match(String(error), /Named capture refusal/);
    });
    await running;
    const external = serializeWrite(key, async () => {
      events.push("external-delete");
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      assert.deepEqual(
        events,
        ["capture-start"],
        "another caller must remain behind the owned loading turn",
      );
    } finally {
      release();
      await Promise.all([settled, external]);
    }
    assert.deepEqual(events, ["capture-start", "capture-end", "external-delete"]);
  });
}

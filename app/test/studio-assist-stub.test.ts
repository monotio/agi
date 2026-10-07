import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSelectionStub } from "../src/agent/selectionStub.ts";

/** A read_edit_context details payload in the shape the real tool returns. */
const PICTURE_CONTEXT = {
  kind: "picture",
  baseRevision: "rev-1",
  selection: [{ id: "bridge", label: "Bridge", lines: [4, 9] }],
  selectionArea: { cells: 80, bbox: { x0: 60, y0: 120, x1: 99, y1: 139 } },
  controls: [
    { value: 0, cells: 80, bbox: { x0: 60, y0: 120, x1: 99, y1: 139 } },
    { value: 3, cells: 40, bbox: null },
  ],
};

describe("the Studio assist stub", () => {
  it("rejects a malformed read_edit_context payload instead of trusting it", async () => {
    const stub = createSelectionStub("make this walkable");
    const turn = await stub.sendUserMessage("make this walkable");
    const id = turn.toolCalls[0]!.id;
    assert.equal(turn.toolCalls[0]!.name, "read_edit_context");
    assert.throws(
      () =>
        stub.appendToolResults([
          {
            toolCallId: id,
            result: { success: true, details: { kind: "picture", selection: "bridge" } },
          },
        ]),
      /read_edit_context returned an unrecognised edit context/,
    );
  });

  it("takes a well-formed context and proceeds to edit_selection", async () => {
    const stub = createSelectionStub("make this walkable");
    const turn = await stub.sendUserMessage("make this walkable");
    stub.appendToolResults([
      { toolCallId: turn.toolCalls[0]!.id, result: { success: true, details: PICTURE_CONTEXT } },
    ]);
    const next = await stub.complete();
    assert.equal(next.toolCalls[0]?.name, "edit_selection");
  });
});

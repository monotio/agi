import assert from "node:assert/strict";
import { test } from "node:test";
import { createPanels, registerCreatePanel } from "../src/shell/createDocks.ts";

test("panel replacement keeps order and an old disposer preserves its replacement", () => {
  const first = registerCreatePanel({
    id: "inspect-test",
    dock: "right",
    title: "First",
    order: 2,
  });
  const second = registerCreatePanel({
    id: "inspect-test",
    dock: "right",
    title: "Second",
    order: -1,
  });
  try {
    first();
    assert.equal(createPanels("right")[0]?.title, "Second");
    assert.equal(createPanels("right").filter((panel) => panel.id === "inspect-test").length, 1);
    assert.ok(!createPanels("left").some((panel) => panel.id === "inspect-test"));
  } finally {
    second();
  }
  assert.ok(!createPanels("right").some((panel) => panel.id === "inspect-test"));
});

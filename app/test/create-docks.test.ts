import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component } from "vue";
import { createPanels, registerCreatePanel } from "../src/shell/createDocks.ts";

const ids = (dock: "left" | "right") => createPanels(dock).map((panel) => panel.id);

test("the shell's placeholders are World on the left and Assistant on the right", () => {
  assert.deepEqual(ids("left"), ["world"]);
  assert.deepEqual(ids("right"), ["assistant"]);
  assert.equal(createPanels("left")[0]!.component, undefined);
});

test("panels add tabs by order, replace a placeholder by id, and unregister cleanly", () => {
  const Inspect: Component = { render: () => null };
  const World: Component = { render: () => null };
  const offActivity = registerCreatePanel({
    id: "activity",
    dock: "right",
    title: "Activity",
    order: 2,
  });
  const offInspect = registerCreatePanel({
    id: "inspect",
    dock: "right",
    title: "Inspect",
    order: 1,
    component: Inspect,
  });
  const offWorld = registerCreatePanel({
    id: "world",
    dock: "left",
    title: "World",
    component: World,
  });
  assert.deepEqual(ids("right"), ["assistant", "inspect", "activity"]);
  assert.equal(createPanels("left")[0]!.component, World);
  offInspect();
  offActivity();
  assert.deepEqual(ids("right"), ["assistant"]);
  offWorld();
  assert.deepEqual(ids("left"), []);
});

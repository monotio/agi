import assert from "node:assert/strict";
import { test } from "node:test";
import { createNewGameChoice } from "../src/home/newGameChoice.ts";

test("manual templates select independently and AI reveals its outline", () => {
  const choice = createNewGameChoice();
  assert.equal(choice.selected.value, "starter");
  assert.equal(choice.aiVisible.value, false);
  for (const kind of ["boilerplate", "blank", "starter"] as const) {
    choice.select(kind);
    assert.equal(choice.selected.value, kind);
    assert.equal(choice.aiVisible.value, false);
  }
  choice.select("ai");
  assert.equal(choice.aiVisible.value, true);
  choice.select("blank");
  assert.equal(choice.aiVisible.value, false);
});

test("radio arrow keys move and wrap; Enter and Space choose the focused card", () => {
  const choice = createNewGameChoice();
  assert.equal(choice.key("starter", "ArrowRight"), "boilerplate");
  assert.equal(choice.selected.value, "boilerplate");
  assert.equal(choice.key("boilerplate", "ArrowDown"), "blank");
  assert.equal(choice.key("starter", "ArrowLeft"), "ai");
  assert.equal(choice.key("ai", "ArrowRight"), "starter");
  assert.equal(choice.key("starter", "ArrowUp"), "ai");
  assert.equal(choice.key("blank", "Enter"), "blank");
  assert.equal(choice.key("ai", " "), "ai");
  assert.equal(choice.key("ai", "Tab"), undefined);
  assert.equal(choice.selected.value, "ai");
});

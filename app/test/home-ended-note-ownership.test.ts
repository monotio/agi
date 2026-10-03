import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { computed, reactive } from "vue";
import { installedProgressTarget } from "../src/project/progressTarget.ts";

// Exercise the component's real projection and action predicate with Vue's
// actual computed invalidation. A note replacement may have identical text.
test("an ended action belongs to the exact quit note, including an unbound game", () => {
  const source = readFileSync(new URL("../src/home/HomeHero.vue", import.meta.url), "utf8");
  const start = source.indexOf("const ended = ");
  const end = source.indexOf("/** Play again", start);
  assert.ok(start >= 0 && end > start);
  const state = reactive({
    gameEnded: { projectId: "unbound-game", title: "Unbound game" },
    installedGames: [] as never[],
  });
  const evaluate = new Function(
    "computed",
    "state",
    "savedGames",
    "installedProgressTarget",
    "gameStorageKey",
    "savedProgress",
    "installedProgress",
    "shelfTitle",
    "catalogEntries",
    "pendingProgressTarget",
    stripTypeScriptTypes(source.slice(start, end)) + "; return { ended, ownsAction };",
  );
  const result = evaluate(
    computed,
    state,
    { value: [] },
    installedProgressTarget,
    () => "",
    () => undefined,
    () => undefined,
    (game: { title: string }) => game.title,
    { value: [] },
    { value: undefined },
  );
  const owns = result.ownsAction(result.ended.value);
  assert.equal(owns(), true);
  state.gameEnded = { projectId: "unbound-game", title: "Unbound game" };
  assert.equal(
    owns(),
    false,
    "A newly published note owns its own actions even with identical text",
  );
});

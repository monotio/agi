import assert from "node:assert/strict";
import { test } from "node:test";
import { gameHash, isGameRoute, parseGameHash } from "../src/shell/shellRoute.ts";

test("play and create routes name the same target and round-trip", () => {
  for (const mode of ["play", "create"] as const) {
    const hash = gameHash(mode, "remix-1f/ä b");
    assert.equal(hash, `#${mode}/remix-1f%2F%C3%A4%20b`);
    assert.deepEqual(parseGameHash(hash), { mode, key: "remix-1f/ä b" });
  }
});

test("hashes that name no game are not routes", () => {
  for (const hash of ["", "#play/", "#create-adventure", "#watch/kq1/40", "#play/%", "#tutorial"])
    assert.equal(parseGameHash(hash), null, hash);
});

test("the menu recognizes every game route, including unreadable ones", () => {
  for (const hash of ["#play/%", "#create/%E0", "#play/kq1", "#create/"])
    assert.equal(isGameRoute(hash), true, hash);
  for (const hash of ["", "#watch/kq1", "#create-adventure", "#tutorial"])
    assert.equal(isGameRoute(hash), false, hash);
});

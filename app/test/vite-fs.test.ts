import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import config from "../vite.config.ts";
import { startFixtureServer } from "./fixtureServerHarness.ts";

for (const module of [
  "../../games/knights-trial/SKILL.md?raw",
  "../../games/adventure-department/game.ts",
]) {
  test(`a fresh dev server serves ${module} before the app imports it`, async (t) => {
    const fs = config.server?.fs;
    assert.ok(fs);
    const running = await startFixtureServer([], { server: { fs } });
    t.after(() => running.close());
    const url = new URL(module, import.meta.url);
    const response = await fetch(
      `${running.url}/@fs${fileURLToPath(url)}${url.search}${url.search ? "&" : "?"}import`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /javascript/);
    const source = await response.text();
    assert.match(source, module.endsWith("?raw") ? /export default/ : /buildTutorial/);
  });
}

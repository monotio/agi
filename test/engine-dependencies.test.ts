import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/check-engine-dependencies.ts", import.meta.url));

test("the install gate rejects package imports even when hoisting makes them resolvable", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "agi-engine-dependencies-")));
  try {
    mkdirSync(join(directory, "src", "nested"), { recursive: true });
    mkdirSync(join(directory, "node_modules", "vue"), { recursive: true });
    writeFileSync(join(directory, "node_modules", "vue", "index.js"), "export const ref = 1;");
    assert.equal(
      createRequire(join(directory, "package.json")).resolve("vue"),
      join(directory, "node_modules", "vue", "index.js"),
    );
    writeFileSync(join(directory, "src", "local.ts"), "export const value = 1;");
    const source = join(directory, "src", "nested", "probe.ts");
    const run = () =>
      spawnSync(process.execPath, ["--experimental-strip-types", script], {
        cwd: directory,
        encoding: "utf8",
      });
    for (const code of [
      'import "vue";',
      'export { ref } from "vue";',
      'export const lazy = () => import("vue");',
      'export type Ref = import("vue").Ref;',
      'import "../../node_modules/vue/index.js";',
      'import "../../app/src/main.ts";',
      'import "node:fs";',
    ]) {
      writeFileSync(source, code);
      const result = run();
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, code);
      assert.match(result.stderr, /src\/nested\/probe\.ts.*engine imports must stay inside src\//);
    }
    writeFileSync(
      source,
      'export { value } from "../local.ts"; export const lazy = () => import("../local.ts");',
    );
    const allowed = run();
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /Engine dependency boundary passed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const configUrl = new URL("../configs/genesis.ts", import.meta.url);
for (const location of ["../../", "../"]) {
  const cwd = fileURLToPath(new URL(location, import.meta.url));
  test(`Genesis config loads original templates from ${location} working directory`, () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `const { default: config } = await import(${JSON.stringify(configUrl.href)});
         if (config.tests.length !== 4 || config.tests.some(test => !test.vars.templateText.trim()))
           throw new Error("The Genesis template cases did not load");`,
      ],
      {
        cwd,
        env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(
      result.status,
      0,
      result.stderr || result.error?.message || "Config import failed",
    );
  });
}

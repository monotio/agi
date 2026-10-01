import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));

async function proofFiles(folder: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) files.push(...(await proofFiles(path)));
    else if (entry.name === "production-proof.txt") files.push(path);
  }
  return files;
}

test("production runs retain sibling evidence and the preceding port's artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agi-production-artifacts-"));
  try {
    await mkdir(join(root, "tests"));
    await mkdir(join(root, "test-results", "sibling"), { recursive: true });
    const sibling = join(root, "test-results", "sibling", "evidence.txt");
    await writeFile(sibling, "another run's evidence");
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await symlink(join(appRoot, "node_modules"), join(root, "node_modules"), "dir");
    await writeFile(
      join(root, "production.config.ts"),
      await readFile(join(appRoot, "playwright.production.config.ts"), "utf8"),
    );
    await writeFile(
      join(root, "proof.config.ts"),
      'import { defineConfig } from "@playwright/test";\n' +
        'import production from "./production.config.ts";\n' +
        'export default defineConfig({ ...production, testDir: "./tests", reporter: "line" });\n',
    );
    await writeFile(
      join(root, "tests", "artifact.spec.ts"),
      'import { test } from "@playwright/test";\n' +
        'import { writeFileSync } from "node:fs";\n' +
        'test("artifact", async ({}, info) => { writeFileSync(info.outputPath("production-proof.txt"), "proof"); });\n',
    );
    let previous: string | undefined;
    for (const port of [5781, 5782]) {
      const run = spawnSync(
        process.execPath,
        [
          join(appRoot, "node_modules", "@playwright", "test", "cli.js"),
          "test",
          "--config=proof.config.ts",
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            AGI_E2E_PORT: String(port),
            // This proof writes an artifact without requesting a browser or server.
            AGI_DEPLOY_URL: "http://unused.invalid",
          },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      assert.equal(run.status, 0, `${run.error?.message ?? ""}\n${run.stdout}\n${run.stderr}`);
      assert.ok(existsSync(sibling), "production must retain a sibling run's evidence");
      assert.equal(await readFile(sibling, "utf8"), "another run's evidence");
      if (previous !== undefined)
        assert.ok(existsSync(previous), "a second port must retain the first port's artifact");
      const proofs = await proofFiles(join(root, "test-results"));
      assert.equal(proofs.length, previous === undefined ? 1 : 2);
      previous = proofs.find((path) => path !== previous);
      assert.ok(previous);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

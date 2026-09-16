import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (/^rc\d+.*-(?:plan|backlog)\.md$/.test(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(?:ts|vue|mjs|md|yml|yaml|json)$/.test(entry.name)) yield path;
  }
}

test("source and documentation do not reference local release plans", () => {
  const paths = ["AGENTS.md", "README.md", "CONTRIBUTING.md"];
  for (const root of [
    ".ast-grep",
    "src",
    "app/src",
    "test",
    "app/test",
    "app/e2e",
    "scripts",
    "docs",
  ])
    paths.push(...sourceFiles(root));
  const references = paths.filter((path) =>
    /\brc\d+(?:-[a-z]+)*-(?:plan|backlog)\.md\b/i.test(readFileSync(path, "utf8")),
  );
  assert.deepEqual(references, [], "Committed sources must explain their contracts directly.");
});

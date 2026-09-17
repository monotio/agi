import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("published text excludes personal filesystem and investigation provenance", () => {
  const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0");
  const violations: string[] = [];
  const personalPath = /(?:\/(?:Users|home)\/[^\s/]+\/|[A-Z]:\\Users\\[^\s\\]+\\)/i;
  const privateInventory =
    /\b(?:local|private)\s+(?:inventory|collection)\s+(?:found|contains|contained)\b/i;
  const datedInvestigation =
    /(?:\b(?:executed|repaired)\s+on\s+\d{4}-\d{2}-\d{2}|\bbinary investigation[^\n]{0,30}\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}\s+(?:local inventory|QA run))/i;
  for (const path of paths) {
    if (!path) continue;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    if (personalPath.test(text)) violations.push(`${path}: personal filesystem path`);
    if (path.endsWith(".md") && (privateInventory.test(text) || datedInvestigation.test(text))) {
      violations.push(`${path}: private inventory or dated investigation provenance`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    "Publish portable instructions, hashes and behavioral evidence.",
  );
});

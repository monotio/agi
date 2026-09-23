import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Code comments cite interpreter findings by heading, e.g.
// docs/fidelity.md "Original click-to-walk". A renamed or missing heading
// silently orphans the citation, so every quoted citation must name a heading
// verbatim or by its leading words ("Apple IIgs interpreter" for "Apple IIgs
// interpreter (SQ2 1.014)").

const ROOTS = ["src", "app/src", "app/e2e", "test", "app/test", "scripts"];
const CITATION = /docs\/fidelity\.md[,:]?\s*\(?\s*"([^"\n]+)"/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|vue|mjs|py)$/.test(name) ? [path] : [];
  });
}

test("every quoted docs/fidelity.md citation names an existing heading", () => {
  const headings = readFileSync("docs/fidelity.md", "utf8")
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => line.replace(/^#{1,6} /, "").trim());
  const orphans: string[] = [];
  for (const file of ROOTS.flatMap(files).filter((f) => !f.endsWith("doc-citations.test.ts"))) {
    // Comments wrap, so join continuation lines before matching.
    const text = readFileSync(file, "utf8").replace(/\n\s*(\/\/|\*|#)\s*/g, " ");
    for (const [, cited] of text.matchAll(CITATION)) {
      if (!headings.some((heading) => heading.startsWith(cited!)))
        orphans.push(`${file}: "${cited}"`);
    }
  }
  assert.deepEqual(orphans, []);
});

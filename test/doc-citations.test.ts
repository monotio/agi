import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Code comments cite interpreter findings by heading, e.g.
// docs/fidelity.md "Original click-to-walk", or by the heading's GitHub anchor,
// e.g. docs/fidelity.md: parked-host-waits. A renamed or missing heading
// silently orphans the citation, so every quoted citation must name a heading
// verbatim or by its leading words ("Apple IIgs interpreter" for "Apple IIgs
// interpreter (SQ2 1.014)"), and every anchor citation must be a heading's
// anchor exactly.

const ROOTS = ["src", "app/src", "app/e2e", "test", "app/test", "scripts"];
const CITATION = /docs\/fidelity\.md[,:]?\s*\(?\s*"([^"\n]+)"/g;
// A lowercase token with at least one hyphen, so prose such as
// "docs/fidelity.md, sound timing" is not mistaken for an anchor.
const ANCHOR_CITATION =
  /docs\/fidelity\.md(?:#|[,:]?\s*\(?\s*)((?:[a-z0-9]+(?:\.[a-z0-9]+)*)(?:-[a-z0-9]+(?:\.[a-z0-9]+)*)+)(?=[.,;:)]*(?:\s|$))/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|vue|mjs|py)$/.test(name) ? [path] : [];
  });
}

// GitHub's heading anchors: lowercase, punctuation other than hyphens and
// underscores dropped, spaces to hyphens, and a -1, -2 suffix on repeats.
export function headingAnchors(headings: readonly string[]): Set<string> {
  const anchors = new Set<string>();
  for (const heading of headings) {
    const base = heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    let anchor = base;
    for (let n = 1; anchors.has(anchor); n++) anchor = `${base}-${n}`;
    anchors.add(anchor);
  }
  return anchors;
}

test("heading anchors follow GitHub's rules", () => {
  assert.deepEqual(
    [
      ...headingAnchors([
        "PC booter 2.001 profile",
        "Action 0x8f (max.drawn.objects)",
        "Notes",
        "Notes",
      ]),
    ],
    ["pc-booter-2001-profile", "action-0x8f-maxdrawnobjects", "notes", "notes-1"],
  );
});

test("every docs/fidelity.md citation names an existing heading or anchor", () => {
  const headings = readFileSync("docs/fidelity.md", "utf8")
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => line.replace(/^#{1,6} /, "").trim());
  const anchors = headingAnchors(headings);
  const orphans: string[] = [];
  for (const file of ROOTS.flatMap(files).filter((f) => !f.endsWith("doc-citations.test.ts"))) {
    // Comments wrap, so join continuation lines before matching.
    const text = readFileSync(file, "utf8").replace(/\n\s*(\/\/|\*|#)\s*/g, " ");
    for (const [, cited] of text.matchAll(CITATION)) {
      if (!headings.some((heading) => heading.startsWith(cited!)))
        orphans.push(`${file}: "${cited}"`);
    }
    for (const [, cited] of text.matchAll(ANCHOR_CITATION)) {
      if (!anchors.has(cited!)) orphans.push(`${file}: #${cited}`);
    }
  }
  assert.deepEqual(orphans, []);
});

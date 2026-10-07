import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

test("LOGIC command reference matches the shared command vocabulary", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/generate-logic-reference.ts", "--check"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("public documentation local links resolve", () => {
  const files = [
    ...markdownFiles(join(ROOT, "docs")),
    ...markdownFiles(join(ROOT, ".github")),
    ...[
      "README.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "CODE_OF_CONDUCT.md",
      "SUPPORT.md",
      "CHANGELOG.md",
      "games/README.md",
      "evals/README.md",
    ].map((path) => join(ROOT, path)),
  ];
  const broken: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
    const links = [
      ...source.matchAll(/!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g),
      ...source.matchAll(/(?:src|href)="([^"]+)"/g),
      ...source.matchAll(/^\[[^\]]+\]:\s+(\S+)/gm),
    ];
    for (const match of links) {
      const href = match[1]!;
      if (/^(?:[a-z]+:|\/\/)/i.test(href)) continue;
      const [path, fragment] = href.split("#");
      const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
      if (!existsSync(target)) {
        broken.push(`${file}: ${href}`);
        continue;
      }
      if (fragment && target.endsWith(".md")) {
        const headings = readFileSync(target, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm);
        const ids = [...headings].map((heading) =>
          heading[1]!
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
            .replace(/\s/g, "-"),
        );
        if (!ids.includes(decodeURIComponent(fragment))) broken.push(`${file}: ${href}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

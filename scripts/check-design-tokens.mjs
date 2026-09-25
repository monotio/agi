#!/usr/bin/env node
// Design-token ratchet: app chrome takes colours, font sizes and radii from
// app/src/styles/tokens.css. This counts raw values in each component's styles
// and fails when a file gains any beyond its recorded baseline. Migrations
// lower the baseline with `--update`; it can never go up through this script.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const baselinePath = join(root, "scripts/design-token-baseline.json");
const TOKENS_FILE = "app/src/styles/tokens.css";

const RULES = [
  ["raw colour", /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(\s*\d/g],
  ["raw font size", /font(?:-size)?\s*:[^;{}]*?\b\d+(?:\.\d+)?(?:px|rem|em)\b/g],
  ["raw radius", /border(?:-[a-z]+)*-radius\s*:\s*[^;{}]*?\b[1-9]\d*(?:\.\d+)?px\b/g],
];

function styleText(path, text) {
  if (path.endsWith(".css")) return text;
  return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(vue|css)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const counts = {};
const details = {};
for (const path of walk(join(root, "app/src"))) {
  const rel = relative(root, path);
  if (rel === TOKENS_FILE) continue;
  const css = styleText(rel, readFileSync(path, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  let total = 0;
  for (const [label, pattern] of RULES) {
    const hits = css.match(pattern) ?? [];
    total += hits.length;
    if (hits.length) (details[rel] ??= []).push(`${hits.length} ${label}`);
  }
  if (total) counts[rel] = total;
}

const sorted = (object) =>
  Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};

if (process.argv.includes("--update")) {
  const next = {};
  for (const [file, count] of Object.entries(counts))
    next[file] = Math.min(count, baseline[file] ?? count);
  writeFileSync(baselinePath, `${JSON.stringify(sorted(next), null, 2)}\n`);
  const total = Object.values(next).reduce((sum, n) => sum + n, 0);
  console.log(`design-token baseline: ${total} raw values in ${Object.keys(next).length} files`);
  process.exit(0);
}

const failures = [];
const improved = [];
for (const [file, count] of Object.entries(counts)) {
  const allowed = baseline[file] ?? 0;
  if (count > allowed)
    failures.push(
      `${file}: ${count} raw values (baseline ${allowed}): ${details[file].join(", ")}`,
    );
  else if (count < allowed) improved.push(`${file}: ${allowed} → ${count}`);
}
for (const file of Object.keys(baseline))
  if (!(file in counts)) improved.push(`${file}: ${baseline[file]} → 0`);

if (failures.length) {
  console.error("Raw style values outside app/src/styles/tokens.css; use a token:");
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
if (improved.length) {
  console.log(
    "Fewer raw style values; lock it in with `node scripts/check-design-tokens.mjs --update`:",
  );
  for (const line of improved) console.log(`  ${line}`);
}

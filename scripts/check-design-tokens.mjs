#!/usr/bin/env node
// Design-token ratchet: app chrome takes colours, font sizes and radii from
// app/src/styles/tokens.css. This counts raw values in every file that can
// style the page: stylesheets, whole Vue components (their styles, inline
// `style` attributes and the colours their scripts hand a canvas), the app's
// TypeScript (inline style strings, canvas `fillStyle`/`strokeStyle`) and its
// HTML entry pages. It fails when a file gains any beyond its recorded
// baseline. Migrations lower the baseline with `--update`; it can never go up
// through this script. Canvas code reads tokens from the computed style, or
// the AGI palette (app/src/palette.ts) when the colour is a game colour.
// An HTML page paints before tokens.css loads, so it may give a token a
// fallback, `var(--surface-0, #070b0d)`, only with the token's own value.
// It also refuses a scoped `:global(.a) .b`: Vue compiles that selector to the
// bare `.a`, so the rule styles the ancestor instead of `.b`.
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

/** A Vue component's <style> blocks. */
const vueStyles = (text) =>
  [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");

/** Block, HTML and line comments out; a `//` counts only after whitespace or punctuation (not `https://`). */
const uncommented = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|[\s;{}(),])\/\/.*$/gm, "$1");

/** Each token's value as tokens.css declares it first. */
function tokenValues() {
  const values = {};
  const css = readFileSync(join(root, TOKENS_FILE), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, name, value] of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    values[name] ??= value.trim();
  return values;
}

/** An HTML page's `var(--token, fallback)` whose fallback is the token's own value, reduced to the token. */
function withoutTokenFallbacks(text, values) {
  return text.replace(
    /var\(\s*(--[\w-]+)\s*,\s*([^()]*(?:\([^()]*\))?[^()]*)\)/g,
    (all, name, fallback) =>
      values[name] !== undefined && values[name] === fallback.trim() ? `var(${name})` : all,
  );
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(vue|css|ts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** The HTML entry pages beside app/src (index.html and the harnesses). */
const htmlPages = () =>
  readdirSync(join(root, "app"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => join(root, "app", entry.name));

/** A `:global(...)` with more selector after it, which Vue drops. */
const GLOBAL_PREFIX = /:global\([^()]*\)(?!\s*[,{])[^,{]*/g;

const counts = {};
const details = {};
const globalPrefixes = [];
const tokens = tokenValues();
for (const path of [...walk(join(root, "app/src")), ...htmlPages()]) {
  const rel = relative(root, path);
  if (rel === TOKENS_FILE) continue;
  const raw = readFileSync(path, "utf8");
  if (rel.endsWith(".vue"))
    for (const hit of uncommented(vueStyles(raw)).match(GLOBAL_PREFIX) ?? [])
      globalPrefixes.push(`${rel}: ${hit.trim()}`);
  const text = rel.endsWith(".html")
    ? withoutTokenFallbacks(uncommented(raw), tokens)
    : uncommented(raw);
  let total = 0;
  for (const [label, pattern] of RULES) {
    const hits = text.match(pattern) ?? [];
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

if (globalPrefixes.length) {
  console.error(
    "Scoped `:global(.a) .b` compiles to the bare `.a`; write `.a .b` (scoped) or `:global(.a .b)`:",
  );
  for (const line of globalPrefixes) console.error(`  ${line}`);
  process.exit(1);
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

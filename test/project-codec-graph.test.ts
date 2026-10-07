import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

/**
 * The startup codec boundary: the eager project reader and the portable
 * workspace/recovery codecs must not statically reach ProjectDraft — the
 * class-backed workspace lives behind the restore facade so the boot path
 * never fetches it. Edges are source-level `import`/`export ... from`
 * statements; type-only and dynamic edges are erased at build time and do
 * not count, matching .dependency-cruiser.mjs's runtime-cycle analysis.
 */

const PROJECT_DRAFT = join("src", "authoring", "projectDraft.ts");
const RUNTIME_ENGINE = join("src", "runtime", "engine.ts");

const PURE_CODEC_ENTRIES = [
  join("app", "src", "project", "gameStorage.ts"),
  join("app", "src", "project", "projectDrafts.ts"),
  join("app", "src", "archive", "projectArchive.ts"),
  join("app", "src", "archive", "projectArchiveWriter.ts"),
  join("src", "authoring", "projectRecoveryCodec.ts"),
  join("src", "authoring", "projectWorkspace.ts"),
];

/**
 * The eager browser-storage progress module and the project body store are
 * on the startup path; the archive progress reader's Engine restore check
 * is not — it runs behind the dynamic gameZip import. A static edge from
 * either entry to the runtime Engine pulls the interpreter into the entry
 * chunk.
 */
const ENGINE_FREE_ENTRIES = [
  join("app", "src", "saves", "gameProgress.ts"),
  join("app", "src", "project", "gameStorage.ts"),
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

/** A named-only clause where every specifier is `type` erases at compile time. */
function clauseAllType(clause: string): boolean {
  const trimmed = clause.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  const specifiers = trimmed
    .slice(1, -1)
    .split(",")
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier.length > 0);
  return specifiers.length > 0 && specifiers.every((specifier) => /^type\b/.test(specifier));
}

const IMPORT_CLAUSE = /\bimport\s+(?!type\b)([^;()]*?)\bfrom\s*["']([^"']+)["']/g;
const IMPORT_BARE = /\bimport\s*["']([^"']+)["']/g;
const EXPORT_FROM = /\bexport\s+(?!type\b)([^;()]*?)\bfrom\s*["']([^"']+)["']/g;

function runtimeSpecifiers(file: string): string[] {
  const text = stripComments(readFileSync(file, "utf8"));
  const specifiers: string[] = [];
  for (const match of text.matchAll(IMPORT_CLAUSE))
    if (!clauseAllType(match[1]!)) specifiers.push(match[2]!);
  for (const match of text.matchAll(IMPORT_BARE)) specifiers.push(match[1]!);
  for (const match of text.matchAll(EXPORT_FROM))
    if (!clauseAllType(match[1]!)) specifiers.push(match[2]!);
  return specifiers;
}

function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.vue`,
    `${base}.mjs`,
    join(base, "index.ts"),
  ])
    if (existsSync(candidate)) return candidate;
  return undefined;
}

function firstPathTo(entry: string, target: string): string[] | undefined {
  const parent = new Map<string, string>();
  const queue = [entry];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const specifier of runtimeSpecifiers(file)) {
      const next = resolveSpecifier(specifier, file);
      if (next === undefined || seen.has(next)) continue;
      parent.set(next, file);
      if (next === target) {
        const path = [target];
        while (parent.has(path[0]!)) path.unshift(parent.get(path[0]!)!);
        return path;
      }
      seen.add(next);
      queue.push(next);
    }
  }
  return undefined;
}

test("portable project codec readers cannot statically reach ProjectDraft", () => {
  const target = resolve(PROJECT_DRAFT);
  for (const entry of PURE_CODEC_ENTRIES) {
    const path = firstPathTo(resolve(entry), target);
    assert.equal(
      path,
      undefined,
      `${entry} reaches ${PROJECT_DRAFT} statically:\n  ${path?.join("\n  -> ")}`,
    );
  }
});

test("eager progress and storage modules cannot statically reach the runtime Engine", () => {
  const target = resolve(RUNTIME_ENGINE);
  for (const entry of ENGINE_FREE_ENTRIES) {
    const path = firstPathTo(resolve(entry), target);
    assert.equal(
      path,
      undefined,
      `${entry} reaches ${RUNTIME_ENGINE} statically:\n  ${path?.join("\n  -> ")}`,
    );
  }
});

test("the lazy archive progress reader keeps its runtime Engine restore check", () => {
  const path = firstPathTo(
    resolve(join("app", "src", "saves", "gameProgressImport.ts")),
    resolve(RUNTIME_ENGINE),
  );
  assert.ok(path, "gameProgressImport.ts must keep a static path to the runtime Engine");
});

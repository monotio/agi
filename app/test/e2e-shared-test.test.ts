/**
 * Every browser spec takes `test` and `expect` from app/e2e/test.ts, the only
 * place that runs the pause-agreement check after each test. A spec that
 * imports a value from @playwright/test skips that check silently, so this
 * static read fails naming each such spec. Type-only imports are fine.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const E2E = fileURLToPath(new URL("../e2e/", import.meta.url));

/**
 * Specs that run only against a production build or a deployed site, where the
 * test hooks the pause check reads are absent. Each entry needs its reason.
 */
const EXCEPTIONS: Record<string, string> = {};

/** True when the import clause binds at least one runtime value (not `type`). */
function bindsValue(clause: string): boolean {
  if (/^type\s/.test(clause)) return false;
  const names = clause
    .replace(/[{}]/g, ",")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return names.some((name) => !/^type\s/.test(name));
}

function importsPlaywrightValue(source: string): boolean {
  const from = /\bimport\s+([^;'"]*?)\s*from\s*["']@playwright\/test["']/g;
  for (const match of source.matchAll(from)) {
    if (bindsValue(match[1] ?? "")) return true;
  }
  return (
    /\bimport\s*["']@playwright\/test["']/.test(source) ||
    /\bimport\(\s*["']@playwright\/test["']\s*\)/.test(source)
  );
}

function specFiles(): string[] {
  return readdirSync(E2E, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".spec.ts"))
    .sort();
}

test("every e2e spec takes test and expect from the shared test module", () => {
  const offenders = specFiles().filter(
    (file) =>
      !(file in EXCEPTIONS) && importsPlaywrightValue(readFileSync(join(E2E, file), "utf8")),
  );
  assert.deepEqual(
    offenders,
    [],
    `these specs import a value from @playwright/test, so the pause check does not run for them; import test and expect from ./test.ts: ${offenders.join(", ")}`,
  );
});

test("every listed exception is a spec that still exists", () => {
  const missing = Object.keys(EXCEPTIONS).filter((file) => !existsSync(join(E2E, file)));
  assert.deepEqual(missing, [], `these exceptions name specs that no longer exist`);
});

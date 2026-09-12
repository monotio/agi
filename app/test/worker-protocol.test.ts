import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Drift guard for the shared worker protocol: every message `type` literal
 * used in the worker source must be a member of the unions declared in
 * workerProtocol.ts, and every declared member must be used. The typed
 * dispatchers make this a compile-time property; this test fails first when
 * a literal sneaks in around them.
 */
const workerSource = readFileSync(
  fileURLToPath(new URL("../src/engine.worker.ts", import.meta.url)),
  "utf8",
);
const protocolSource = readFileSync(
  fileURLToPath(new URL("../src/workerProtocol.ts", import.meta.url)),
  "utf8",
);

const used = new Set(
  [...workerSource.matchAll(/type:\s*"([a-zA-Z]+)"|type\s*===\s*"([a-zA-Z]+)"/g)].map(
    (m) => (m[1] ?? m[2])!,
  ),
);
const declared = new Set([...protocolSource.matchAll(/type:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]!));

test("every message type literal in the worker is declared in workerProtocol", () => {
  for (const type of used) {
    assert.ok(declared.has(type), `worker uses type "${type}" not declared in workerProtocol.ts`);
  }
});

test("every declared message type is used by the worker", () => {
  for (const type of declared) {
    assert.ok(
      used.has(type),
      `workerProtocol.ts declares type "${type}" the worker never sends or reads`,
    );
  }
});

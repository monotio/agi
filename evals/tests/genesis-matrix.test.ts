import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const BENCHMARKS = resolve(import.meta.dirname, "../benchmarks/genesis");

/**
 * Every committed Genesis snapshot must still analyse to the metrics committed
 * beside it. A change to the analyser, or to the engine code it reads games
 * with, that moves a number shows up here instead of silently making later
 * snapshots incomparable with earlier ones.
 */
for (const version of readdirSync(BENCHMARKS)) {
  test(`genesis benchmark ${version} reproduces its committed metrics`, () => {
    const snapshot = join(BENCHMARKS, version);
    const out = mkdtempSync(join(tmpdir(), "agi-genesis-matrix-"));
    try {
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          resolve(import.meta.dirname, "../genesis-matrix.ts"),
          join(snapshot, "runs"),
          out,
        ],
        { stdio: "pipe" },
      );
      assert.deepEqual(
        JSON.parse(readFileSync(join(out, "metrics.json"), "utf8")),
        JSON.parse(readFileSync(join(snapshot, "matrix", "metrics.json"), "utf8")),
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
}

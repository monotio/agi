import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixtureDir, fixtureFiles } from "../fixtures.ts";
import { loadGame } from "../game-fixture.ts";
import type { Action } from "./runner.ts";
import { walkthrough, type Walkthrough } from "./walkthroughs.ts";

export interface WalkthroughArtifact {
  schema: "monotio_agi.walkthrough.v1";
  game: string;
  coverage: Walkthrough["coverage"];
  profile: string;
  seed: number;
  fixtureHashes: Record<string, string>;
  status: "completed" | "failed";
  failure: string | null;
  elapsedMs: number;
  virtualTicks: number;
  cycles: number;
  actions: Action[];
  finalState: unknown;
}

/** Hash the same canonical resource/interpreter files the fixture loader consumes. */
export function walkthroughFixtureHashes(slug: string): Record<string, string> {
  const { files } = loadGame(slug, { interpreterFiles: true });
  const wordsName = fixtureFiles(slug)!.get("words.tok")!;
  const inputs = new Map(files);
  inputs.set("WORDS.TOK", new Uint8Array(readFileSync(fixtureDir(slug) + wordsName)));
  return Object.fromEntries(
    [...inputs]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")]),
  );
}

/** Read a completed replay; consumers also match its hashes to their fixture files. */
export function readWalkthroughArtifact(path: string): WalkthroughArtifact {
  const recording = JSON.parse(readFileSync(path, "utf8")) as WalkthroughArtifact;
  assert.equal(recording.schema, "monotio_agi.walkthrough.v1");
  walkthrough(recording.game);
  assert.equal(recording.status, "completed", "the recorded route completed");
  assert.ok(Array.isArray(recording.actions), "recorded input tape");
  assert.ok(Number.isSafeInteger(recording.seed), "recorded seed");
  assert.ok(
    Number.isSafeInteger(recording.virtualTicks) && recording.virtualTicks >= 0,
    "recorded duration",
  );
  return recording;
}

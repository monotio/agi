import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixtureDir, fixtureFiles } from "../fixtures.ts";
import { loadGame } from "../game-fixture.ts";
import type { Action } from "./runner.ts";
import { walkthrough, type Walkthrough } from "./walkthroughs.ts";

export interface WalkthroughArtifact {
  schema: "monotio.agi.walkthrough.v1";
  game: string;
  targetHash?: string | undefined;
  supportedHashes?: readonly string[] | undefined;
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
export function walkthroughFixtureHashes(target: string): Record<string, string> {
  const { files } = loadGame(target, { interpreterFiles: true });
  const wordsName = fixtureFiles(target)!.get("words.tok")!;
  const inputs = new Map(files);
  inputs.set("WORDS.TOK", new Uint8Array(readFileSync(fixtureDir(target) + wordsName)));
  return Object.fromEntries(
    [...inputs]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")]),
  );
}

/** Read a completed replay; consumers also match its hashes to their fixture files. */
export function readWalkthroughArtifact(path: string): WalkthroughArtifact {
  const recording = JSON.parse(readFileSync(path, "utf8")) as WalkthroughArtifact;
  assert.equal(recording.schema, "monotio.agi.walkthrough.v1");
  const route = walkthrough(recording.game);
  if (recording.targetHash) {
    assert.equal(
      recording.targetHash.toLowerCase(),
      route.hash.toLowerCase(),
      "target hash matches route",
    );
  }
  if (recording.supportedHashes) {
    assert.ok(
      recording.supportedHashes.map((h) => h.toLowerCase()).includes(route.hash.toLowerCase()),
      "route hash included in supported hashes",
    );
  }
  assert.equal(recording.status, "completed", "the recorded route completed");
  assert.ok(Array.isArray(recording.actions), "recorded input tape");
  assert.ok(Number.isSafeInteger(recording.seed), "recorded seed");
  assert.ok(
    Number.isSafeInteger(recording.virtualTicks) && recording.virtualTicks >= 0,
    "recorded duration",
  );
  return recording;
}

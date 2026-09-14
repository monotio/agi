import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fixtureDir, fixtureFiles } from "../fixtures.ts";
import { BUILTIN_GAME_BUILDERS, loadGame } from "../game-fixture.ts";
import { resolveGameHash } from "../../src/games/knownGames.ts";
import { gameRevision } from "../../app/src/gameMetadata.ts";
import type { Action } from "./runner.ts";
import { walkthrough, type Walkthrough } from "./walkthroughs.ts";

export interface WalkthroughArtifact {
  schema: "monotio.agi.walkthrough.v2";
  game: string;
  targetRevision: string;
  supportedRevisions?: readonly string[] | undefined;
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

/**
 * The file set a client actually fetches when it boots this target — what
 * `BootedGame.revision` covers. The offer gate compares against this, so a
 * remixed copy with untouched vocabulary does not inherit the tape.
 */
const SERVED_FILE_PATTERN =
  /^([A-Z0-9_]*DIR|[A-Z0-9_]*VOL\.(?:[0-9]|1[0-5])|WORDS\.TOK|OBJECT|AGIDATA\.OVL|AGI|[A-Z0-9_-]+\.COM)$/i;

/**
 * The bundle revisions a walkthrough may be offered for: the served fixture
 * set first, then — for builtins also reachable through the catalog — the
 * full builder set.
 */
export async function walkthroughServedRevisions(target: string): Promise<string[]> {
  const builder =
    BUILTIN_GAME_BUILDERS[target.toLowerCase()] ??
    BUILTIN_GAME_BUILDERS[resolveGameHash(target.toLowerCase()) ?? ""];
  const all = new Map<string, Uint8Array>();
  if (builder) {
    for (const [name, bytes] of Object.entries(builder().files)) all.set(name, bytes);
  } else {
    const dir = fixtureDir(target);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile())
        all.set(entry.name.toUpperCase(), new Uint8Array(readFileSync(dir + entry.name)));
    }
  }
  const served = new Map([...all].filter(([name]) => SERVED_FILE_PATTERN.test(name)));
  const revisions = [await gameRevision(Object.fromEntries(served))];
  if (builder) {
    const full = await gameRevision(Object.fromEntries(all));
    if (full !== revisions[0]) revisions.push(full);
  }
  return revisions;
}

/** Hash the same canonical resource/interpreter files the fixture loader consumes. */
export function walkthroughFixtureHashes(target: string): Record<string, string> {
  const { files } = loadGame(target, { interpreterFiles: true });
  const fFiles = fixtureFiles(target);
  if (!fFiles) {
    return Object.fromEntries(
      [...files]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")]),
    );
  }
  const wordsName = fFiles.get("words.tok")!;
  const inputs = new Map(files);
  inputs.set("WORDS.TOK", new Uint8Array(readFileSync(fixtureDir(target) + wordsName)));
  return Object.fromEntries(
    [...inputs]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")]),
  );
}

/** Read a completed replay; consumers also match its hashes to their fixture files. */
export async function readWalkthroughArtifact(path: string): Promise<WalkthroughArtifact> {
  const recording = JSON.parse(readFileSync(path, "utf8")) as WalkthroughArtifact;
  assert.equal(recording.schema, "monotio.agi.walkthrough.v2");
  const route = walkthrough(recording.game);
  const served = await walkthroughServedRevisions(route.hash);
  assert.ok(
    typeof recording.targetRevision === "string" &&
      /^[0-9a-f]{64}$/i.test(recording.targetRevision),
    "the tape declares the bundle revision it was recorded on",
  );
  assert.equal(
    recording.targetRevision.toLowerCase(),
    served[0]!.toLowerCase(),
    "target revision matches the served bundle",
  );
  if (recording.supportedRevisions) {
    assert.ok(
      recording.supportedRevisions.map((h) => h.toLowerCase()).includes(served[0]!.toLowerCase()),
      "served bundle revision included in supported revisions",
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

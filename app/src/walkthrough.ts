/**
 * Walkthrough definitions and loaders for autonomous real-time playback.
 */
import type { ReplayAction } from "./replay.ts";
import {
  KNOWN_GAMES,
  getKnownGameByAlias,
  getKnownGameByRevision,
  type KnownAgiGame,
} from "../../src/games/knownGames.ts";

/** Bundle revisions a recorded walkthrough supports beyond its catalog targetRevision. */
const BY_WALKTHROUGH_REVISION = new Map<string, KnownAgiGame>();
for (const game of KNOWN_GAMES) {
  for (const revision of game.walkthroughRevisions ?? [])
    BY_WALKTHROUGH_REVISION.set(revision.toLowerCase(), game);
}

export interface WalkthroughArtifact {
  schema: "monotio.agi.walkthrough.v2";
  game: string;
  /** The full bundle revision (sorted-name SHA-256) the tape was recorded on. */
  targetRevision: string;
  supportedRevisions?: readonly string[] | undefined;
  coverage: "complete-game" | "chapter" | "partial";
  profile: string;
  seed: number;
  elapsedMs: number;
  virtualTicks: number;
  cycles: number;
  actions: readonly ReplayAction[];
}

export interface WalkthroughMeta {
  readonly alias: string;
  readonly title: string;
  readonly label: string;
  readonly coverage: "complete-game" | "chapter" | "partial";
}

export const KNOWN_WALKTHROUGHS: Record<string, WalkthroughMeta> = Object.fromEntries(
  KNOWN_GAMES.filter((g): g is KnownAgiGame & { walkthroughLabel: string } =>
    Boolean(g.walkthroughLabel),
  ).map((g) => [
    g.alias,
    {
      alias: g.alias,
      title: g.title,
      label: g.walkthroughLabel,
      coverage: g.walkthroughCoverage ?? "complete-game",
    },
  ]),
);

/**
 * Resolve a walkthrough offer to its catalog entry — by alias (a canonical
 * edition name) or by the full bundle revision of the copy being played.
 * The WORDS.TOK fingerprint deliberately does not resolve here: a remix that
 * leaves vocabulary alone keeps it, and the replay would refuse at the
 * per-file check after offering.
 */
function knownGameFor(idOrRevision: string): KnownAgiGame | null {
  const normalized = idOrRevision.toLowerCase();
  return (
    getKnownGameByAlias(normalized) ??
    getKnownGameByRevision(normalized) ??
    BY_WALKTHROUGH_REVISION.get(normalized) ??
    null
  );
}

export function hasWalkthrough(hashOrAlias: string): boolean {
  if (!hashOrAlias) return false;
  return Boolean(knownGameFor(hashOrAlias)?.walkthroughLabel);
}

export function resolveWalkthrough(hashOrAlias: string): string | null {
  if (!hashOrAlias) return null;
  const known = knownGameFor(hashOrAlias);
  return known?.walkthroughLabel ? known.alias : null;
}

export function validateWalkthroughArtifact(data: unknown): WalkthroughArtifact {
  if (!data || typeof data !== "object") {
    throw new Error("Walkthrough artifact must be an object.");
  }
  const obj = data as Record<string, unknown>;
  if (obj["schema"] !== "monotio.agi.walkthrough.v2") {
    throw new Error(`Unsupported walkthrough schema: ${String(obj["schema"])}`);
  }
  if (typeof obj["game"] !== "string" || !KNOWN_WALKTHROUGHS[obj["game"].toLowerCase()]) {
    throw new Error(`Unsupported game in walkthrough: ${String(obj["game"])}`);
  }
  const game = obj["game"].toLowerCase();
  const HASH_REGEX = /^[0-9a-f]{64}$/i;

  if (typeof obj["targetRevision"] !== "string" || !HASH_REGEX.test(obj["targetRevision"])) {
    throw new Error(`Invalid walkthrough targetRevision: ${String(obj["targetRevision"])}`);
  }
  const targetRevision = obj["targetRevision"].toLowerCase();

  let supportedRevisions: string[] | undefined;
  if (obj["supportedRevisions"] !== undefined) {
    if (!Array.isArray(obj["supportedRevisions"])) {
      throw new Error("Walkthrough supportedRevisions must be an array.");
    }
    supportedRevisions = [];
    for (let i = 0; i < obj["supportedRevisions"].length; i++) {
      const h = obj["supportedRevisions"][i];
      if (typeof h !== "string" || !HASH_REGEX.test(h)) {
        throw new Error(`Invalid walkthrough supportedRevision at index ${i}: ${String(h)}`);
      }
      supportedRevisions.push(h.toLowerCase());
    }
  }

  const coverage = obj["coverage"];
  if (coverage !== "complete-game" && coverage !== "chapter" && coverage !== "partial") {
    throw new Error(`Invalid walkthrough coverage: ${String(coverage)}`);
  }
  if (typeof obj["profile"] !== "string" || !obj["profile"]) {
    throw new Error(`Invalid walkthrough profile: ${String(obj["profile"])}`);
  }
  const seed = obj["seed"];
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0) {
    throw new Error(`Invalid walkthrough seed: ${String(seed)}`);
  }
  const virtualTicks = obj["virtualTicks"];
  if (typeof virtualTicks !== "number" || !Number.isInteger(virtualTicks) || virtualTicks <= 0) {
    throw new Error(`Invalid walkthrough virtualTicks: ${String(virtualTicks)}`);
  }
  const cycles = obj["cycles"];
  if (typeof cycles !== "number" || !Number.isInteger(cycles) || cycles < 0) {
    throw new Error(`Invalid walkthrough cycles: ${String(cycles)}`);
  }
  const elapsedMs = obj["elapsedMs"];
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new Error(`Invalid walkthrough elapsedMs: ${String(elapsedMs)}`);
  }
  if (!Array.isArray(obj["actions"])) {
    throw new Error("Walkthrough actions must be an array.");
  }
  const rawActions = obj["actions"] as unknown[];
  if (rawActions.length > 500_000) {
    throw new Error(`Walkthrough action count exceeds limit (${rawActions.length})`);
  }
  const actions: ReplayAction[] = [];
  for (let i = 0; i < rawActions.length; i++) {
    const a = rawActions[i];
    if (!a || typeof a !== "object") {
      throw new Error(`Action at index ${i} is not an object.`);
    }
    const act = a as Record<string, unknown>;
    switch (act["kind"]) {
      case "key": {
        const code = act["code"];
        if (typeof code !== "number" || !Number.isInteger(code) || code < 1 || code > 65535) {
          throw new Error(`Invalid key code at action ${i}: ${String(code)}`);
        }
        actions.push({ kind: "key", code });
        break;
      }
      case "direction": {
        const dir = act["dir"];
        if (typeof dir !== "number" || !Number.isInteger(dir) || dir < 0 || dir > 8) {
          throw new Error(`Invalid direction at action ${i}: ${String(dir)}`);
        }
        actions.push({ kind: "direction", dir });
        break;
      }
      case "answer": {
        const text = act["text"];
        if (typeof text !== "string" || text.length > 256) {
          throw new Error(`Invalid answer text at action ${i}`);
        }
        actions.push({ kind: "answer", text });
        break;
      }
      case "advance": {
        const ticks = act["ticks"];
        if (typeof ticks !== "number" || !Number.isInteger(ticks) || ticks < 1 || ticks > 100_000) {
          throw new Error(`Invalid advance ticks at action ${i}: ${String(ticks)}`);
        }
        actions.push({ kind: "advance", ticks });
        break;
      }
      case "checkpoint": {
        const label = act["label"];
        const room = act["room"];
        const score = act["score"];
        const x = act["x"];
        const y = act["y"];
        if (typeof label !== "string" || !label) {
          throw new Error(`Invalid checkpoint label at action ${i}`);
        }
        if (typeof room !== "number" || !Number.isInteger(room) || room < 0 || room > 255) {
          throw new Error(`Invalid checkpoint room at action ${i}`);
        }
        if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 255) {
          throw new Error(`Invalid checkpoint score at action ${i}`);
        }
        if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > 255) {
          throw new Error(`Invalid checkpoint x coordinate at action ${i}`);
        }
        if (typeof y !== "number" || !Number.isInteger(y) || y < 0 || y > 255) {
          throw new Error(`Invalid checkpoint y coordinate at action ${i}`);
        }
        actions.push({ kind: "checkpoint", label, room, score, x, y });
        break;
      }
      default:
        throw new Error(`Unknown action kind at action ${i}: ${String(act["kind"])}`);
    }
  }

  return {
    schema: "monotio.agi.walkthrough.v2",
    game,
    targetRevision,
    ...(supportedRevisions !== undefined ? { supportedRevisions } : {}),
    coverage,
    profile: String(obj["profile"]),
    seed,
    virtualTicks,
    cycles,
    elapsedMs,
    actions,
  };
}

const artifactCache = new Map<string, Promise<WalkthroughArtifact>>();

export function clearWalkthroughCache(): void {
  artifactCache.clear();
}

export function loadWalkthrough(hashOrId: string): Promise<WalkthroughArtifact> {
  const resolved = resolveWalkthrough(hashOrId) ?? hashOrId.toLowerCase();
  const cached = artifactCache.get(resolved);
  if (cached) return cached;

  const promise = (async () => {
    const base =
      typeof import.meta !== "undefined" && import.meta.env?.BASE_URL
        ? import.meta.env.BASE_URL
        : "/";
    const url = `${base}walkthroughs/${resolved}.json`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Walkthrough for "${hashOrId}" not found (HTTP ${response.status})`);
    }
    const json = await response.json();
    return validateWalkthroughArtifact(json);
  })().catch((err) => {
    // Evict failures so retries can succeed
    artifactCache.delete(resolved);
    throw err;
  });

  artifactCache.set(resolved, promise);
  return promise;
}

export interface WalkthroughCheckpoint {
  readonly index: number;
  readonly label: string;
  readonly room: number;
  readonly score: number;
  readonly tick: number;
  readonly percent: number;
  readonly actionIndex: number;
}

export function extractCheckpoints(
  actions: readonly ReplayAction[],
  totalTicks: number,
): WalkthroughCheckpoint[] {
  let currentTick = 0;
  const checkpoints: WalkthroughCheckpoint[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!;
    if (a.kind === "advance") {
      currentTick += a.ticks;
    } else if (a.kind === "checkpoint") {
      checkpoints.push({
        index: checkpoints.length,
        label: a.label,
        room: a.room,
        score: a.score,
        tick: currentTick,
        percent: totalTicks > 0 ? (currentTick / totalTicks) * 100 : 0,
        actionIndex: i,
      });
    }
  }
  return checkpoints;
}

const checkpointsCache = new WeakMap<WalkthroughArtifact, readonly WalkthroughCheckpoint[]>();

export function getOrExtractCheckpoints(
  artifact: WalkthroughArtifact,
): readonly WalkthroughCheckpoint[] {
  let cp = checkpointsCache.get(artifact);
  if (!cp) {
    cp = extractCheckpoints(artifact.actions, artifact.virtualTicks);
    checkpointsCache.set(artifact, cp);
  }
  return cp;
}

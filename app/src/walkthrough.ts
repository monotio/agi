/**
 * Walkthrough definitions and loaders for autonomous real-time playback.
 */
import type { ReplayAction } from "./replay.ts";

export interface WalkthroughArtifact {
  schema: "monotio_agi.walkthrough.v1";
  game: string;
  coverage: "complete-game" | "chapter" | "partial";
  profile: string;
  seed: number;
  elapsedMs: number;
  virtualTicks: number;
  cycles: number;
  actions: readonly ReplayAction[];
}

export interface WalkthroughMeta {
  readonly slug: string;
  readonly title: string;
  readonly label: string;
  readonly coverage: "complete-game" | "chapter" | "partial";
}

export const KNOWN_WALKTHROUGHS: Record<string, WalkthroughMeta> = {
  kq1: {
    slug: "kq1",
    title: "King's Quest I",
    label: "Completed throne-room ending (159 pts)",
    coverage: "complete-game",
  },
  kq2: {
    slug: "kq2",
    title: "King's Quest II",
    label: "Completed wedding & credits (185 pts)",
    coverage: "complete-game",
  },
  sq1: {
    slug: "sq1",
    title: "Space Quest I",
    label: "Completed ceremony & credits (202 pts)",
    coverage: "complete-game",
  },
  mh1: {
    slug: "mh1",
    title: "Manhunter: New York",
    label: "Completed Day 1",
    coverage: "chapter",
  },
};

export function hasWalkthrough(slug: string): boolean {
  return Boolean(KNOWN_WALKTHROUGHS[slug.toLowerCase()]);
}

export function validateWalkthroughArtifact(data: unknown): WalkthroughArtifact {
  if (!data || typeof data !== "object") {
    throw new Error("Walkthrough artifact must be an object.");
  }
  const obj = data as Record<string, unknown>;
  if (obj["schema"] !== "monotio_agi.walkthrough.v1") {
    throw new Error(`Unsupported walkthrough schema: ${String(obj["schema"])}`);
  }
  if (typeof obj["game"] !== "string" || !KNOWN_WALKTHROUGHS[obj["game"].toLowerCase()]) {
    throw new Error(`Unsupported game in walkthrough: ${String(obj["game"])}`);
  }
  const game = obj["game"].toLowerCase();
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
      case "command": {
        const text = act["text"];
        if (typeof text !== "string" || text.length > 256) {
          throw new Error(`Invalid command text at action ${i}`);
        }
        actions.push({ kind: "command", text });
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
    schema: "monotio_agi.walkthrough.v1",
    game,
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

export function loadWalkthrough(slug: string): Promise<WalkthroughArtifact> {
  const norm = slug.toLowerCase();
  const cached = artifactCache.get(norm);
  if (cached) return cached;

  const promise = (async () => {
    const base =
      typeof import.meta !== "undefined" && import.meta.env?.BASE_URL
        ? import.meta.env.BASE_URL
        : "/";
    const url = `${base}walkthroughs/${norm}.json`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Walkthrough for "${slug}" not found (HTTP ${response.status})`);
    }
    const json = await response.json();
    return validateWalkthroughArtifact(json);
  })().catch((err) => {
    // Evict failures so retries can succeed
    artifactCache.delete(norm);
    throw err;
  });

  artifactCache.set(norm, promise);
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

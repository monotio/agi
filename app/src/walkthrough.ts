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

export async function loadWalkthrough(slug: string): Promise<WalkthroughArtifact> {
  const norm = slug.toLowerCase();
  const base =
    typeof import.meta !== "undefined" && import.meta.env?.BASE_URL
      ? import.meta.env.BASE_URL
      : "/";
  const url = `${base}walkthroughs/${norm}.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Walkthrough for "${slug}" not found (HTTP ${response.status})`);
  }
  return (await response.json()) as WalkthroughArtifact;
}

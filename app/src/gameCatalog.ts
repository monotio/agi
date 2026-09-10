import type { OpenedGame } from "./gameZip.ts";

export interface GameCatalogEntry {
  id: string;
  version: string;
  title: string;
  description: string;
  author: string;
  license: string;
  load: () => Promise<OpenedGame>;
}

export const GAME_CATALOG: readonly GameCatalogEntry[] = [
  {
    id: "adventure-department",
    version: "1.0.0",
    title: "Adventure Department",
    description: "Learn pictures, sprites and priority in a three-room tutorial.",
    author: "Monotio",
    license: "MIT",
    load: async () => (await import("../../games/adventure-department/game.ts")).buildTutorial(),
  },
  {
    id: "synthetic",
    version: "1.0.0",
    title: "Synthetic Test Chamber",
    description: "Autonomous verification fixture for simulation, replay, and playback.",
    author: "Monotio",
    license: "MIT",
    load: async () => (await import("../../src/games/syntheticGame.ts")).buildSyntheticGame(),
  },
];

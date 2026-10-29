/** Hang deadlines, shared by step kind; elapsed performance is reported separately. */
export const DEADLINES = {
  ui: 15_000,
  project: 60_000,
  editor: 45_000,
  image: 45_000,
  analysis: 60_000,
  save: 30_000,
  agent: 45_000,
} as const;

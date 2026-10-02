/** Where a project's "Players tried" list lives; library removal forgets it with the project. */
export const playerSentencesKey = (project: string): string => `monotio_agi.tried.${project}`;

/** Forget what players typed in a removed project, so a game added again starts clean. */
export function clearPlayerSentences(storage: Pick<Storage, "removeItem">, project: string): void {
  storage.removeItem(playerSentencesKey(project));
}

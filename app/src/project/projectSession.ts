/** Bind the editable session to the browser's durable project storage. */
import { authoringFingerprint, commitProject } from "./gameStorage.ts";
import { openOwnedProjectSession } from "./projectSessionCore.ts";

export function openProjectSession(input: Parameters<typeof openOwnedProjectSession>[0]) {
  return openOwnedProjectSession(input, {
    commit: commitProject,
    fingerprint: authoringFingerprint,
  });
}
export type { ProjectSession, PendingProjectRestart } from "./projectSessionCore.ts";

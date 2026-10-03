/** The library action's local intent, carried into final native admission. */
import { resourceRevisionBytes } from "../../../src/authoring/resourceRevision.ts";
import { detectProfile, type ProfileId } from "../../../src/runtime/profile.ts";
import { gameRevision } from "../project/gameMetadata.ts";
import { loadAuthoredGameWithHistoryLifetime } from "../project/gameStorage.ts";
import type { BootedGame, InstalledGameDescriptor } from "../project/gameTypes.ts";
import { resolveProgressTarget } from "../project/progressBinding.ts";
import type { ProgressTarget } from "../project/progressTarget.ts";

export interface QualifiedGameOpening {
  readonly target?: ProgressTarget;
  readonly isCurrent: () => boolean;
}

/** Prove the prepared native candidate after all prior boot preparation awaits. */
export async function admitQualifiedOpening(
  opening: QualifiedGameOpening | undefined,
  game: BootedGame,
  files: Record<string, Uint8Array>,
  profile: ProfileId | undefined,
  bootCurrent: () => boolean,
  getInstalledGames?: () => readonly InstalledGameDescriptor[] | null,
): Promise<(() => boolean) | null> {
  const current = () => bootCurrent() && (opening?.isCurrent() ?? true);
  if (!current()) return null;
  if (opening?.target === undefined) return current;
  const expected = opening.target;
  const native = resourceRevisionBytes(files);
  const declared = game.revision;
  const revision = await gameRevision(files);
  if (!current() || declared !== revision) return null;
  const actual = resolveProgressTarget(game);
  if (
    actual === null ||
    actual.kind !== expected.kind ||
    actual.locator !== expected.locator ||
    actual.identity.project !== expected.identity.project ||
    actual.identity.revision !== expected.identity.revision ||
    revision !== expected.identity.revision
  )
    return null;
  const effective = detectProfile(new Map(Object.entries(files)), profile).id;
  if (!game.installed) {
    if (actual.kind !== "project" || game.projectId !== actual.project) return null;
    const live = await loadAuthoredGameWithHistoryLifetime(actual.project);
    if (!current() || live === null || live.lifetime !== actual.bodyEpoch) return null;
    const latest = resourceRevisionBytes(live.data.files);
    if (
      latest.length !== native.length ||
      !latest.every((byte, i) => byte === native[i]) ||
      detectProfile(new Map(Object.entries(live.data.files)), live.data.library?.profile).id !==
        effective
    )
      return null;
  }
  // The live descriptor owns an installed interpreter override. Removing an
  // override returns to detection; the captured profile cannot stand in for it.
  const installedCurrent = () => {
    if (!game.installed) return true;
    const served = getInstalledGames?.()?.find((entry) => entry.folder === game.folder);
    if (served === undefined) return false;
    return (
      (served.revision === undefined || served.revision === revision) &&
      detectProfile(new Map(Object.entries(files)), served.profile).id === effective
    );
  };
  if (!installedCurrent()) return null;
  // The last awaited proof is complete. Recheck candidate bytes and action
  // synchronously immediately before the caller installs its worker/session.
  return () => {
    const latest = resourceRevisionBytes(files);
    const bound = resolveProgressTarget(game);
    return (
      current() &&
      installedCurrent() &&
      bound !== null &&
      bound.kind === expected.kind &&
      bound.locator === expected.locator &&
      bound.identity.project === expected.identity.project &&
      bound.identity.revision === expected.identity.revision &&
      !game.removed &&
      !game.behindStorage &&
      game.revision === declared &&
      latest.length === native.length &&
      latest.every((byte, i) => byte === native[i]) &&
      detectProfile(new Map(Object.entries(files)), profile).id === effective
    );
  };
}

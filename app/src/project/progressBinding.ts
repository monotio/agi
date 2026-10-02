/**
 * Bind a game's physical progress target from live evidence.
 *
 * progressTarget.ts mints the pure target; this module is where a booted
 * game, a catalog card or a stored body proves the evidence one needs: an
 * installed instance binds its exact served folder and the full revision
 * it runs, and a saved project binds the live body epoch — captured at
 * boot (`BootedGame.historyLifetime`) or read atomically with the body
 * itself (`loadAuthoredGameWithHistoryLifetime`). Neither path mints a
 * lifetime, guesses a folder from an alias, or resurrects a removed body:
 * the target carries only what the evidence shows, and missing evidence
 * resolves to null rather than to a shared legacy key.
 */
import { projectId } from "../../../src/gameIdentity.ts";
import { gameRevision } from "./gameMetadata.ts";
import { loadAuthoredGameWithHistoryLifetime } from "./gameStorage.ts";
import {
  installedProgressTarget,
  parseProgressLocator,
  projectProgressTarget,
  type ProgressTarget,
  type ProjectProgressTarget,
} from "./progressTarget.ts";

/**
 * The evidence a live game carries for its progress binding: the installed
 * fields the served descriptor proved, or the saved project's id plus the
 * body lifetime its boot captured atomically. `progressTarget` is the
 * target bound earlier (the ephemeral BootedGame/CurrentGame field); it
 * supplies the epoch for shapes that carry the binding but no
 * `historyLifetime` field of their own.
 */
export interface ProgressBindingSource {
  readonly installed: boolean;
  readonly revision: string;
  readonly folder?: string | undefined;
  readonly hash?: string | undefined;
  readonly alias?: string | undefined;
  readonly projectId?: string | undefined;
  readonly historyLifetime?: string | null | undefined;
  readonly progressTarget?: ProgressTarget | undefined;
}

/**
 * The physical progress target a live game resolves to — the one address
 * its save slots, autosave record and history write under.
 *
 * An installed game binds synchronously from its exact folder spelling and
 * the full revision it runs; without a folder it is legacy read context
 * and names no current instance. A saved project binds its unchanged id to
 * the live body epoch the boot captured: a removed body (a null captured
 * lifetime) and one that never captured an epoch both refuse rather than
 * fabricate one.
 */
export function resolveProgressTarget(game: ProgressBindingSource): ProgressTarget | null {
  if (game.installed) {
    return installedProgressTarget(
      { folder: game.folder, hash: game.hash, alias: game.alias },
      game.revision,
    );
  }
  if (game.projectId === undefined || game.historyLifetime === null) return null;
  let epoch = game.historyLifetime;
  if (epoch === undefined) {
    const captured = game.progressTarget;
    if (captured?.kind !== "project") return null;
    const locator = parseProgressLocator(captured.locator);
    if (
      captured.project !== game.projectId ||
      captured.identity.project !== game.projectId ||
      locator?.kind !== "project" ||
      locator.project !== game.projectId ||
      locator.bodyEpoch !== captured.bodyEpoch
    )
      return null;
    epoch = captured.bodyEpoch;
  }
  return projectProgressTarget(game.projectId, game.revision, epoch);
}

/**
 * Resolve and store the game's progress target on the object itself — the
 * ephemeral `progressTarget` field a boot or a card resolution fills. A
 * refusal clears the field rather than leaving a stale binding behind.
 */
export function bindProgressTarget(
  game: ProgressBindingSource & { progressTarget?: ProgressTarget | undefined },
): ProgressTarget | null {
  const target = resolveProgressTarget(game);
  const previous = game.progressTarget;
  if (
    target !== null &&
    previous !== undefined &&
    target.locator === previous.locator &&
    target.identity.project === previous.identity.project &&
    target.identity.revision === previous.identity.revision &&
    JSON.stringify(target.legacyKeys) === JSON.stringify(previous.legacyKeys)
  )
    return previous;
  game.progressTarget = target ?? undefined;
  return target;
}

/**
 * The progress target of a stored project body, bound against live
 * storage: the body and its `lifetime/<id>` receipt are read in one atomic
 * snapshot, so the epoch is genuinely the body's — `initial` only when the
 * live body truly carries no receipt. A missing body or a deleted lifetime
 * resolves to null; nothing is minted or defaulted here. The embedded
 * identity is the stored body's own: its unchanged project id and the full
 * revision its index records (or its playable bytes hash).
 */
export async function bindSavedProgressTarget(
  project: string,
): Promise<ProjectProgressTarget | null> {
  const id = projectId(project);
  if (id === null) return null;
  const loaded = await loadAuthoredGameWithHistoryLifetime(id);
  if (loaded === null || loaded.lifetime === null) return null;
  const revision = loaded.data.library?.revision ?? (await gameRevision(loaded.data.files));
  return projectProgressTarget(id, revision, loaded.lifetime);
}

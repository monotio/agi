import type { ProjectProgressTarget } from "./progressTarget.ts";
import { bindSavedProgressTarget } from "./progressBinding.ts";
import { loadAuthoredGameWithHistoryLifetime } from "./gameStorage.ts";
import { gameRevision } from "./gameMetadata.ts";
import { readEarlierProgress } from "./earlierProgress.ts";
import { earlierProgressReceiptKey } from "./earlierProgressReceipt.ts";
import { readBodyRecordSet } from "./gameBodyStorage.ts";
import { base64ToBytes, bytesToBase64 } from "./bytes.ts";
import { listEarlierCheckpoints, prepareEarlierCheckpoint } from "../saves/earlierCheckpoint.ts";
import { autosaveKey, withCheckpointLock, writeAutosave } from "../saves/gameProgress.ts";
import { gameSavesKey, readGameSaveRecord } from "../saves/gameSaves.ts";
import { readProgressWriter } from "../saves/progressWriter.ts";
import { mapKey, readMapSidecar } from "../world/roomMapStore.ts";
import type { ProjectHistory } from "../archive/historyArchive.ts";
import { detectProfile } from "../../../src/runtime/profile.ts";

/** Adopt released progress once into the live project's physical address. */
export async function adoptEarlierProjectProgress(
  storage: Pick<Storage, "getItem" | "setItem">,
  target: ProjectProgressTarget,
): Promise<void> {
  // Share the publication lock with checkpoint/slot writers, including other
  // pages. The receipt belongs to the project id: a later recreated body must
  // never inherit the retained bare-id progress again.
  await withCheckpointLock(target.locator, async () => {
    const receiptKey = earlierProgressReceiptKey(target.project);
    if (storage.getItem(receiptKey) !== null) return;
    const sourceKeys = [
      autosaveKey(target.project),
      gameSavesKey(target.project),
      mapKey(target.project),
    ];
    if (
      sourceKeys.every((key) => storage.getItem(key) === null) &&
      (await readBodyRecordSet([`history/${target.project}`])).get(`history/${target.project}`) ===
        undefined
    ) {
      storage.setItem(receiptKey, JSON.stringify({ version: 1, locator: target.locator }));
      return;
    }
    const loaded = await loadAuthoredGameWithHistoryLifetime(target.project);
    if (loaded === null || loaded.lifetime !== target.bodyEpoch) return;
    const files = loaded.data.files;
    if ((await gameRevision(files)) !== target.identity.revision) return;
    const profile = detectProfile(new Map(Object.entries(files)), loaded.data.library?.profile).id;
    const read = await readEarlierProgress(
      { kind: "live", legacyKey: target.project },
      {
        local: { getItem: (key) => storage.getItem(key), listKeys: () => [...sourceKeys] },
      },
    );
    if (read.kind !== "live") return;
    const source = new Map(read.local.map(({ key, value }) => [key, value]));
    const sourceStorage = { getItem: (key: string) => source.get(key) ?? null };

    let checkpoint: Awaited<ReturnType<typeof prepareEarlierCheckpoint>> | undefined;
    const choice = listEarlierCheckpoints(read)[0];
    if (choice !== undefined && !choice.record.game.installed) {
      try {
        checkpoint = await prepareEarlierCheckpoint({
          read,
          entryIndex: choice.index,
          target,
          files,
          profile,
        });
      } catch {
        /* Unreadable or incompatible progress stays at its released address. */
      }
    }
    const slots: Record<string, { image: string; region: "ntsc" | "pal" }> = {};
    try {
      const released = readGameSaveRecord(sourceStorage, target.project);
      for (const [slot, image] of Object.entries(released.slots)) {
        try {
          const { readProgressEntries } = await import("../saves/gameProgressImport.ts");
          const entries = new Map([[`SAVES/SG.${slot}`, base64ToBytes(image)]]);
          const region = released.amigaRegions[slot] ?? "ntsc";
          if (region === "pal")
            entries.set(
              "SAVES/TIMING.JSON",
              new TextEncoder().encode(JSON.stringify({ amigaRegions: { [slot]: region } })),
            );
          const checked = readProgressEntries(entries, "", files, profile)?.saves[slot];
          if (checked) slots[slot] = { image: bytesToBase64(checked), region };
        } catch {
          /* A bad slot does not prevent adopting the other slots. */
        }
      }
    } catch {
      /* Keep an unsupported or unreadable slot list untouched. */
    }
    let map: string | null = null;
    try {
      readMapSidecar(sourceStorage, target.project);
      map = sourceStorage.getItem(mapKey(target.project));
    } catch {
      /* Keep unsupported or unreadable map bytes untouched. */
    }
    const { importGameHistory, loadProjectHistory } = await import("../history/historyStorage.ts");
    let history: ProjectHistory | null = null;
    try {
      const released = await loadProjectHistory(target.project);
      if (
        released?.recording.identity.project === target.project &&
        released.recording.identity.revision === target.identity.revision &&
        released.recording.profile === profile
      )
        history = released;
    } catch {
      /* Keep unsupported or unreadable recordings untouched. */
    }

    // All expensive reads/proofs happened before publication. Rebind after
    // their awaits; a removed/replaced body refuses. Existing stores always win.
    const live = await bindSavedProgressTarget(target.project);
    if (live?.locator !== target.locator || live.identity.revision !== target.identity.revision)
      return;
    if (history && !(await importGameHistory(target, history, undefined, true))) return;
    const current = await bindSavedProgressTarget(target.project);
    if (
      current?.locator !== target.locator ||
      current.identity.revision !== target.identity.revision
    )
      return;
    // A writer receipt outlives its page. Keep its fence and generation;
    // adoption neither claims ownership nor retires a live page's writer.
    const writer = readProgressWriter(storage, target.locator);
    if (
      checkpoint &&
      storage.getItem(autosaveKey(target.locator)) === null &&
      writeAutosave(storage, target, {
        ...checkpoint.record,
        ...(writer ? { writerGeneration: writer.generation } : {}),
      }) === null
    )
      return;
    if (Object.keys(slots).length && storage.getItem(gameSavesKey(target.locator)) === null) {
      // Publish the validated list in one localStorage write. A refused write
      // leaves every slot available for a later opening to adopt together.
      const amigaRegions = Object.fromEntries(
        Object.entries(slots)
          .filter(([, save]) => save.region === "pal")
          .map(([slot]) => [slot, "pal"]),
      );
      storage.setItem(
        gameSavesKey(target.locator),
        JSON.stringify({
          format: "monotio.agi.saves",
          version: 1,
          slots: Object.fromEntries(
            Object.entries(slots).map(([slot, save]) => [slot, save.image]),
          ),
          ...(Object.keys(amigaRegions).length ? { amigaRegions } : {}),
        }),
      );
    }
    if (map !== null && storage.getItem(mapKey(target.locator)) === null)
      storage.setItem(mapKey(target.locator), map);
    storage.setItem(receiptKey, JSON.stringify({ version: 1, locator: target.locator }));
  });
}

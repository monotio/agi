import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { bindSavedProgressTarget } from "../src/project/progressBinding.ts";
import { adoptEarlierProjectProgress } from "../src/project/earlierProgressAdoption.ts";
import { autosaveKey, readGameProgress } from "../src/saves/gameProgress.ts";
import { readGameSaves } from "../src/saves/gameSaves.ts";
import { mapKey, readMapSidecar } from "../src/world/roomMapStore.ts";
import { loadGameHistory } from "../src/history/historyStorage.ts";
import { earlierProgressReceiptKey } from "../src/project/earlierProgressReceipt.ts";
import { claimProgressWriter } from "../src/saves/progressWriter.ts";

// Frozen browser records written by v1.1.0 (745c05b), using its tutorial,
// Engine, project writer and all four progress writers. The clock and UUID
// were fixed synthetic inputs. No current serializer produced these records.
const fixture = JSON.parse(
  await readFile(new URL("./fixtures/progress-v1.1.json", import.meta.url), "utf8"),
) as {
  local: Record<string, string>;
  records: { projectId: string; files?: Record<string, number[]> }[];
};
const records = installIndexedDbFixture();
const project = "migration-probe";

async function rig() {
  records.clear();
  for (const record of fixture.records)
    records.set(record.projectId, {
      ...structuredClone(record),
      ...(record.files
        ? {
            files: Object.fromEntries(
              Object.entries(record.files).map(([name, bytes]) => [name, new Uint8Array(bytes)]),
            ),
          }
        : {}),
    });
  const local = new Map(Object.entries(fixture.local));
  const storage = {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => {
      local.set(key, value);
    },
  };
  const target = await bindSavedProgressTarget(project);
  assert.ok(target);
  assert.notEqual(target.bodyEpoch, "initial");
  return { local, storage, target };
}

test("adopts the released checkpoint once, preserving the legacy string", async () => {
  const { local, storage, target } = await rig();
  const legacy = local.get(autosaveKey(project));
  await adoptEarlierProjectProgress(storage, target);
  assert.equal(
    readGameProgress(storage, target).autosave?.image,
    readGameProgress(storage, project).autosave?.image,
  );
  assert.ok(local.has(autosaveKey(target.locator)));
  assert.equal(local.get(autosaveKey(project)), legacy);
  local.delete(autosaveKey(target.locator));
  await adoptEarlierProjectProgress(storage, target);
  assert.equal(local.has(autosaveKey(target.locator)), false);

  const departed = await rig();
  const writer = claimProgressWriter(departed.storage, departed.target, "departed page");
  await adoptEarlierProjectProgress(departed.storage, departed.target);
  assert.equal(
    readGameProgress(departed.storage, departed.target).autosave?.writerGeneration,
    writer.generation,
  );

  for (const patch of [{ version: 99 }, { image: "unreadable" }]) {
    const next = await rig();
    const raw = JSON.stringify({ ...JSON.parse(legacy!), ...patch });
    next.local.set(autosaveKey(project), raw);
    await adoptEarlierProjectProgress(next.storage, next.target);
    assert.equal(next.local.get(autosaveKey(project)), raw);
    assert.equal(next.local.has(autosaveKey(next.target.locator)), false);
    next.local.set(autosaveKey(project), legacy!);
    await adoptEarlierProjectProgress(next.storage, next.target);
    assert.equal(next.local.has(autosaveKey(next.target.locator)), false);
  }
});

test("adopts native slots once after restoring them against the project's files", async () => {
  const { local, storage, target } = await rig();
  await adoptEarlierProjectProgress(storage, target);
  assert.deepEqual(readGameSaves(storage, target), readGameSaves(storage, project));
  const key = `monotio_agi.saves.${encodeURIComponent(target.locator)}`;
  assert.ok(local.has(key));
  local.delete(key);
  await adoptEarlierProjectProgress(storage, target);
  assert.deepEqual(readGameSaves(storage, target), {});

  const next = await rig();
  const sourceKey = `monotio_agi.saves.${project}`;
  const raw = JSON.stringify({ ...JSON.parse(next.local.get(sourceKey)!), version: 99 });
  next.local.set(sourceKey, raw);
  await adoptEarlierProjectProgress(next.storage, next.target);
  assert.equal(next.local.get(sourceKey), raw);
  assert.deepEqual(readGameSaves(next.storage, next.target), {});
});

test("adopts map notes once and keeps later old-tab map writes separate", async () => {
  const { local, storage, target } = await rig();
  const legacy = local.get(mapKey(project));
  await adoptEarlierProjectProgress(storage, target);
  assert.equal(readMapSidecar(storage, target).notes["1"], "A 1.1 map note");
  assert.equal(local.get(mapKey(project)), legacy);
  local.delete(mapKey(target.locator));
  local.set(mapKey(project), legacy!.replace("A 1.1 map note", "Old tab changed it"));
  await adoptEarlierProjectProgress(storage, target);
  assert.deepEqual(readMapSidecar(storage, target).notes, {});

  const next = await rig();
  const raw = JSON.stringify({ ...JSON.parse(legacy!), version: 99 });
  next.local.set(mapKey(project), raw);
  next.local.set(mapKey(next.target.locator), "{unreadable destination");
  await adoptEarlierProjectProgress(next.storage, next.target);
  assert.equal(next.local.get(mapKey(project)), raw);
  assert.equal(next.local.get(mapKey(next.target.locator)), "{unreadable destination");
});

test("adopts the released rewind recording once without changing its source", async () => {
  const { storage, target } = await rig();
  const source = structuredClone([...records.entries()]);
  await adoptEarlierProjectProgress(storage, target);
  const history = await loadGameHistory(target.locator);
  assert.equal(history?.version, 1);
  assert.equal(history?.segments[0]?.id, "s-probe.1");
  for (const [key, value] of source) assert.deepEqual(records.get(key), value);
  records.delete(`history/${target.locator}`);
  await adoptEarlierProjectProgress(storage, target);
  assert.equal(await loadGameHistory(target.locator), null);

  const next = await rig();
  const raw = { ...(records.get(`history/${project}`) as object), version: 99 };
  records.set(`history/${project}`, raw);
  await adoptEarlierProjectProgress(next.storage, next.target);
  assert.deepEqual(records.get(`history/${project}`), raw);
  assert.equal(await loadGameHistory(next.target.locator), null);
});

test("the adoption uses the pinned source when an old tab writes during preparation", async () => {
  const { local, storage, target } = await rig();
  let observed = false;
  await adoptEarlierProjectProgress(
    {
      ...storage,
      getItem(key) {
        const value = storage.getItem(key);
        if (key === mapKey(project) && !observed) {
          observed = true;
          local.set(key, "{unreadable old-tab write");
        }
        return value;
      },
    },
    target,
  );
  assert.equal(readMapSidecar(storage, target).notes["1"], "A 1.1 map note");
});

test("a slot list publishes in one write and a rejected write leaves it available", async () => {
  const { local, storage, target } = await rig();
  const sourceKey = `monotio_agi.saves.${project}`;
  const source = JSON.parse(local.get(sourceKey)!) as { slots: Record<string, string> };
  source.slots["2"] = source.slots["1"]!;
  local.set(sourceKey, JSON.stringify(source));
  const destinationKey = `monotio_agi.saves.${encodeURIComponent(target.locator)}`;
  let writes = 0;
  await assert.rejects(
    adoptEarlierProjectProgress(
      {
        ...storage,
        setItem(key, value) {
          if (key === destinationKey && ++writes === 1) throw new Error("Storage refused");
          storage.setItem(key, value);
        },
      },
      target,
    ),
    /Storage refused/,
  );
  assert.deepEqual(Object.keys(readGameSaves(storage, target)), []);
  assert.equal(local.has(earlierProgressReceiptKey(project)), false);
  writes = 0;
  await adoptEarlierProjectProgress(
    {
      ...storage,
      setItem(key, value) {
        if (key === destinationKey) writes++;
        storage.setItem(key, value);
      },
    },
    target,
  );
  assert.equal(writes, 1);
  assert.deepEqual(Object.keys(readGameSaves(storage, target)), ["1", "2"]);
});

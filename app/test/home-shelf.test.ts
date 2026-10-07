import { scheduler as testScheduler } from "node:timers/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GAME_CATALOG } from "../src/library/gameCatalog.ts";
import { formatRelativeTime } from "../src/home/relativeTime.ts";
import {
  coalescesInstalled,
  isInstalledCatalogCopy,
  parentDisplayTitle,
  releaseName,
  shelfTitle,
} from "../src/home/shelfIdentity.ts";
import { createThumbnailQueue } from "../src/home/thumbnailQueue.ts";
import type { CachedGameMeta } from "../src/project/gameStorage.ts";
import type { LibraryMetadata } from "../src/project/gameMetadata.ts";
import type { InstalledGameDescriptor } from "../src/project/gameTypes.ts";
import { getKnownGameByAlias } from "../../src/games/knownGames.ts";
import { testProjectId, testRevision } from "./identity.ts";

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const MINUTE = 60_000;

test("relative time reads in minutes, hours and days, then names the date", () => {
  assert.equal(formatRelativeTime(NOW - 20_000, NOW), "just now");
  assert.equal(formatRelativeTime(NOW + 5 * MINUTE, NOW), "just now");
  assert.equal(formatRelativeTime(NOW - MINUTE, NOW), "1 min ago");
  assert.equal(formatRelativeTime(NOW - 12 * MINUTE - 30_000, NOW), "12 min ago");
  assert.equal(formatRelativeTime(NOW - 60 * MINUTE, NOW), "1 hour ago");
  assert.equal(formatRelativeTime(NOW - 5 * 60 * MINUTE, NOW), "5 hours ago");
  assert.equal(formatRelativeTime(NOW - 24 * 60 * MINUTE, NOW), "1 day ago");
  assert.equal(formatRelativeTime(NOW - 6 * 24 * 60 * MINUTE, NOW), "6 days ago");
  assert.equal(formatRelativeTime(Date.UTC(2026, 8, 3, 12), NOW), "on Sep 3");
  assert.equal(formatRelativeTime(Date.UTC(2025, 11, 24, 12), NOW), "on Dec 24, 2025");
  assert.equal(formatRelativeTime(Number.NaN, NOW), "");
});

interface Deferred {
  resolve(value: string): void;
  reject(error: Error): void;
}

/** A render whose completion the test controls, recording when it started. */
function controlledRenders() {
  const started: string[] = [];
  const pending = new Map<string, Deferred>();
  const render = (key: string) => () => {
    started.push(key);
    return new Promise<string>((resolve, reject) => pending.set(key, { resolve, reject }));
  };
  return { started, pending, render };
}

const tick = () => testScheduler.yield();

test("the thumbnail queue runs at most two renders at a time, in request order", async () => {
  const queue = createThumbnailQueue(2);
  const { started, pending, render } = controlledRenders();
  const results = Promise.allSettled(
    ["a", "b", "c", "d"].map((key) => queue.request(key, render(key))),
  );
  await tick();
  assert.deepEqual(started, ["a", "b"]);
  pending.get("b")!.resolve("B");
  await tick();
  assert.deepEqual(started, ["a", "b", "c"]);
  pending.get("a")!.reject(new Error("broken game"));
  await tick();
  assert.deepEqual(started, ["a", "b", "c", "d"]);
  pending.get("c")!.resolve("C");
  pending.get("d")!.resolve("D");
  assert.deepEqual(
    (await results).map((result) => (result.status === "fulfilled" ? result.value : "failed")),
    ["failed", "B", "C", "D"],
  );
});

test("each key renders once per session, successes and failures alike", async () => {
  const queue = createThumbnailQueue(2);
  const { started, pending, render } = controlledRenders();
  const first = queue.request("game", render("game"));
  const again = queue.request("game", render("game"));
  assert.equal(first, again);
  await tick();
  pending.get("game")!.resolve("data:image/png;base64,AA");
  assert.equal(await first, "data:image/png;base64,AA");
  assert.equal(queue.cached("game"), "data:image/png;base64,AA");
  assert.equal(await queue.request("game", render("game")), "data:image/png;base64,AA");

  const failed = queue.request("broken", render("broken"));
  await tick();
  pending.get("broken")!.reject(new Error("no picture"));
  await assert.rejects(failed, /no picture/);
  await assert.rejects(queue.request("broken", render("broken")), /no picture/);
  assert.equal(queue.cached("broken"), undefined);
  assert.deepEqual(started, ["game", "broken"]);
});

/** A stored library copy; `catalog` marks it as Play-stored for that release. */
const storedGame = (
  library?: Pick<LibraryMetadata, "source"> & Partial<LibraryMetadata>,
): CachedGameMeta => ({
  projectId: testProjectId("stored-game"),
  title: "Adventure Department",
  authoredAt: "2026-09-26T00:00:00.000Z",
  provider: "stub",
  model: "offline-tutorial",
  ...(library
    ? {
        library: {
          version: 1,
          revision: testRevision("stored-game"),
          validation: { status: "ready", message: "Checked." },
          ...library,
        } as LibraryMetadata,
      }
    : {}),
});

test("a stored copy of an older catalog release is titled with its release", () => {
  const older = storedGame({
    source: "catalog",
    catalog: { id: "adventure-department", version: "1.0.0" },
  });
  assert.equal(shelfTitle(older, GAME_CATALOG), "Adventure Department 1.0");
  const played11 = storedGame({
    source: "catalog",
    catalog: { id: "adventure-department", version: "1.1.0" },
  });
  assert.equal(shelfTitle(played11, GAME_CATALOG), "Adventure Department 1.1");
});

test("the current release and other stored games keep their stored title", () => {
  const current = storedGame({
    source: "catalog",
    catalog: { id: "adventure-department", version: GAME_CATALOG[0]!.version },
  });
  assert.equal(shelfTitle(current, GAME_CATALOG), "Adventure Department");
  assert.equal(shelfTitle(storedGame({ source: "remix" }), GAME_CATALOG), "Adventure Department");
  assert.equal(shelfTitle(storedGame(), GAME_CATALOG), "Adventure Department");
});

test("an imported, unchanged copy of an older release keeps its release name", () => {
  // A 1.0 Project download added with Add game: its bytes are the released
  // 1.0.0 tutorial, whatever the archive's provenance says.
  const revision = getKnownGameByAlias("adventure-department-1.0")!.targetRevision!;
  const imported = storedGame({ source: "zip", revision });
  assert.equal(shelfTitle(imported, GAME_CATALOG), "Adventure Department 1.0");
  // A renamed copy is the player's name; other bytes are another game.
  assert.equal(shelfTitle({ ...imported, title: "My gallery" }, GAME_CATALOG), "My gallery");
  assert.equal(shelfTitle(storedGame({ source: "zip" }), GAME_CATALOG), "Adventure Department");
  // 1.1.0 shares 1.2.0's vocabulary; its revision alone names the release.
  const revision11 = getKnownGameByAlias("adventure-department-1.1")!.targetRevision!;
  assert.equal(
    shelfTitle(storedGame({ source: "zip", revision: revision11 }), GAME_CATALOG),
    "Adventure Department 1.1",
  );
  // The current release's bytes need no release name.
  const current = getKnownGameByAlias("adventure-department")!.targetRevision!;
  assert.equal(
    shelfTitle(storedGame({ source: "zip", revision: current }), GAME_CATALOG),
    "Adventure Department",
  );
});

test("releaseName shortens a release version for the shelf", () => {
  assert.equal(releaseName("1.0.0"), "1.0");
  assert.equal(releaseName("1.1.0"), "1.1");
});

/** An installed fixture descriptor for the tutorial's exact release. */
const installedTutorial = (extra?: Partial<InstalledGameDescriptor>): InstalledGameDescriptor => ({
  hash: getKnownGameByAlias("adventure-department")!.wordsSha256,
  alias: "adventure-department",
  title: "Adventure Department",
  folder: "adventure-department",
  revision: getKnownGameByAlias("adventure-department")!.targetRevision,
  ...extra,
});

test("an installed fixture folds into the catalog card only as the verified release", () => {
  const entry = GAME_CATALOG[0]!;
  // The tutorial's intentional single card: the served bundle is the
  // catalog's exact revision.
  assert.equal(isInstalledCatalogCopy(installedTutorial(), entry), true);
  assert.equal(
    isInstalledCatalogCopy({ ...installedTutorial(), alias: "sample", title: "SAMPLE" }, entry),
    false,
    "a separately named installed instance retains its own progress card",
  );
  // A supplied revision is evidence: an unknown bundle and a changed
  // bundle both keep their own cards rather than folding on the alias.
  const changed = installedTutorial({ revision: testRevision("tutorial-remix") });
  assert.equal(changed.alias, entry.id);
  assert.equal(isInstalledCatalogCopy(changed, entry), false);
  // Same dictionary, different volumes: the same alias cannot fold a
  // derivative into the catalog.
  const differentVolumes = installedTutorial({ revision: testRevision("other-volumes") });
  assert.equal(isInstalledCatalogCopy(differentVolumes, entry), false);
  // Explicit ancestry is its own game even when the bytes match the release.
  const remix = installedTutorial({
    parent: {
      project: testProjectId("adventure-department"),
      revision: getKnownGameByAlias("adventure-department")!.targetRevision!,
    },
  });
  assert.equal(isInstalledCatalogCopy(remix, entry), false);
  // A descriptor still awaiting its fingerprint supplies no verified
  // revision: the alias alone never folds it into the catalog card.
  const { revision: _rev, ...legacy } = installedTutorial();
  assert.equal(isInstalledCatalogCopy(legacy, entry), false);
  assert.equal(isInstalledCatalogCopy({ ...legacy, alias: "other-alias" }, entry), false);
});

test("a saved project coalesces with an installed instance only on symmetric interpreter evidence", () => {
  const installed = installedTutorial();
  const sameInstance: CachedGameMeta = {
    ...storedGame({ source: "folder", revision: installed.revision! }),
    projectId: testProjectId("adventure-department"),
  };
  // A declared interpreter choice is never equal to an undeclared default on
  // the other side, in either direction.
  const explicitSaved: CachedGameMeta = {
    ...sameInstance,
    library: { ...sameInstance.library!, profile: "3.002.149" },
  };
  assert.equal(coalescesInstalled(explicitSaved, installed), false);
  assert.equal(
    coalescesInstalled(sameInstance, installedTutorial({ profile: "3.002.149" })),
    false,
  );
  // Both sides declaring the same interpreter still fold; two different
  // declared interpreters never do.
  assert.equal(
    coalescesInstalled(explicitSaved, installedTutorial({ profile: "3.002.149" })),
    true,
  );
  assert.equal(
    coalescesInstalled(explicitSaved, installedTutorial({ profile: "amiga-2.202" })),
    false,
  );
  // Neither side declaring keeps the catalog's intentional single card.
  assert.equal(coalescesInstalled(sameInstance, installed), true);
});

test("a saved project coalesces with an installed instance only on intentional evidence", () => {
  const installed = installedTutorial();
  const sameBytes = storedGame({
    source: "folder",
    revision: installed.revision!,
  });
  // The saved project's id is the instance's own storage key (its folder).
  const sameInstance: CachedGameMeta = {
    ...sameBytes,
    projectId: testProjectId("adventure-department"),
  };
  assert.equal(coalescesInstalled(sameInstance, installed), true);
  // A preferred-alias/id collision cannot hide a distinct local original:
  // a supplied different revision keeps its own card.
  const differentBytes: CachedGameMeta = {
    ...sameInstance,
    library: { ...sameInstance.library!, revision: testRevision("distinct-original") },
  };
  assert.equal(coalescesInstalled(differentBytes, installed), false);
  // Unknown supplied revisions stay separate as well.
  const unknownRevision: CachedGameMeta = {
    ...sameInstance,
    library: { ...sameInstance.library!, revision: testRevision("unknown-bundle") },
  };
  assert.equal(coalescesInstalled(unknownRevision, installed), false);
  // An independent explicit parent stands alone even when the bytes and
  // the id both match.
  const independent: CachedGameMeta = {
    ...sameInstance,
    library: {
      ...sameInstance.library!,
      parent: { project: testProjectId("some-parent"), revision: installed.revision! },
    },
  };
  assert.equal(coalescesInstalled(independent, installed), false);
  const installedRemix = installedTutorial({
    parent: { project: testProjectId("some-parent"), revision: installed.revision! },
  });
  assert.equal(coalescesInstalled(sameInstance, installedRemix), false);
  // A declared interpreter difference never silently equates instances.
  const amiga = installedTutorial({ profile: "amiga-2.202" });
  assert.equal(coalescesInstalled(sameInstance, amiga), false);
  const amigaSaved: CachedGameMeta = {
    ...sameInstance,
    library: { ...sameInstance.library!, profile: "amiga-2.202" },
  };
  assert.equal(coalescesInstalled(amigaSaved, amiga), true);
  // A descriptor still awaiting its fingerprint mints no identity: the
  // shared storage-key spelling alone never hides its card.
  const { revision: _rev, ...legacy } = installedTutorial();
  assert.equal(coalescesInstalled(sameInstance, legacy), false);
  // Nothing about a different instance coalesces.
  const other = storedGame({ source: "folder", revision: installed.revision! });
  assert.equal(coalescesInstalled(other, installed), false);
});

test("a parent identity resolves to a title from saves, installs or the catalog", () => {
  const revision = getKnownGameByAlias("adventure-department")!.targetRevision!;
  const parentId = { project: testProjectId("adventure-department"), revision };
  // A stored project names the parent only when its own revision is the
  // declared one: the full {project, revision} pair is the evidence. (This
  // assertion previously relied on an id-only lookup — the stored fixture's
  // id did not even match, so it only exercised the catalog fallback.)
  const storedParent: CachedGameMeta = {
    ...storedGame({ source: "authored", revision }),
    projectId: testProjectId("adventure-department"),
  };
  assert.equal(parentDisplayTitle(parentId, [storedParent], []), "Adventure Department");
  // The same stored project at a different revision does not lend its title.
  const storedOther: CachedGameMeta = {
    ...storedGame({ source: "authored", revision: testRevision("changed-bytes") }),
    projectId: testProjectId("adventure-department"),
  };
  assert.equal(
    parentDisplayTitle(parentId, [storedOther], []),
    "Adventure Department", // falls back to the declared revision's known release
  );
  assert.equal(
    parentDisplayTitle(
      { project: testProjectId("adventure-department"), revision: testRevision("x") },
      [storedOther],
      [],
    ),
    "adventure-department",
  );
  // An installed instance named by its storage key (folder) names the parent
  // when its served revision is the declared one.
  const installed = installedTutorial();
  const installedId = {
    project: testProjectId("adventure-department"),
    revision: installed.revision!,
  };
  assert.equal(parentDisplayTitle(installedId, [], [installed]), "Adventure Department");
  // An untitled identity verifies against the known release's revision.
  const releaseParent = { project: testProjectId("does-not-exist"), revision };
  assert.equal(parentDisplayTitle(releaseParent, [], []), "Adventure Department");
  // Otherwise the raw project spelling shows, unchanged.
  const raw = { project: testProjectId("my-remix-source"), revision: testRevision("x") };
  assert.equal(parentDisplayTitle(raw, [], []), "my-remix-source");
});

test("a parent title needs the complete declared pair across saved and installed domains", () => {
  const revisionA = testRevision("chamber-a");
  const revisionB = testRevision("chamber-b");
  const chamberId = testProjectId("chamber");
  // Saved chamber at revision B must not lend its title to a declared parent
  // naming chamber at revision A while the installed chamber at A exists.
  const savedAltered: CachedGameMeta = {
    ...storedGame({ source: "zip", revision: revisionB }),
    projectId: chamberId,
    title: "Altered chamber",
  };
  const installedOriginal: InstalledGameDescriptor = {
    hash: "c".repeat(64),
    alias: "chamber",
    folder: "chamber",
    title: "Original chamber",
    revision: revisionA,
  };
  assert.equal(
    parentDisplayTitle(
      { project: chamberId, revision: revisionA },
      [savedAltered],
      [installedOriginal],
    ),
    "Original chamber",
  );
  // The saved entry's own complete pair still supplies its title.
  assert.equal(
    parentDisplayTitle(
      { project: chamberId, revision: revisionB },
      [savedAltered],
      [installedOriginal],
    ),
    "Altered chamber",
  );
  // A parent project whose revision changed since the declaration resolves to
  // the raw project spelling — never the other revision's title.
  assert.equal(
    parentDisplayTitle(
      { project: chamberId, revision: testRevision("chamber-c") },
      [savedAltered],
      [installedOriginal],
    ),
    "chamber",
  );
  // Conflicting complete matches stay visibly unresolved rather than lending
  // an arbitrary first title.
  const savedConflict: CachedGameMeta = {
    ...storedGame({ source: "zip", revision: revisionA }),
    projectId: chamberId,
    title: "Altered chamber",
  };
  assert.equal(
    parentDisplayTitle(
      { project: chamberId, revision: revisionA },
      [savedConflict],
      [installedOriginal],
    ),
    "chamber",
  );
  // Equal complete-pair titles across domains still resolve.
  const savedSame: CachedGameMeta = {
    ...storedGame({ source: "zip", revision: revisionA }),
    projectId: chamberId,
    title: "Original chamber",
  };
  assert.equal(
    parentDisplayTitle(
      { project: chamberId, revision: revisionA },
      [savedSame],
      [installedOriginal],
    ),
    "Original chamber",
  );
});

test("a request abandoned before its turn never renders and can be asked for again", async () => {
  const queue = createThumbnailQueue(1);
  const { started, pending, render } = controlledRenders();
  const busy = queue.request("busy", render("busy"));
  const controller = new AbortController();
  const abandoned = queue.request("scrolled-away", render("scrolled-away"), controller.signal);
  controller.abort();
  await tick();
  pending.get("busy")!.resolve("BUSY");
  await busy;
  await assert.rejects(abandoned, { name: "AbortError" });
  assert.deepEqual(started, ["busy"]);
  const retried = queue.request("scrolled-away", render("scrolled-away"));
  await tick();
  pending.get("scrolled-away")!.resolve("BACK");
  assert.equal(await retried, "BACK");
  assert.deepEqual(started, ["busy", "scrolled-away"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { GAME_CATALOG } from "../src/library/gameCatalog.ts";
import {
  coalescesInstalled,
  isInstalledCatalogCopy,
  parentDisplayTitle,
} from "../src/home/shelfIdentity.ts";
import type { CachedGameMeta, InstalledGameDescriptor } from "../src/project/gameTypes.ts";
import { installedProgressTarget } from "../src/project/progressTarget.ts";
import { testProjectId, testRevision } from "./identity.ts";

test("an installed descriptor awaiting its fingerprint keeps its own shelf card", () => {
  const saved: CachedGameMeta = {
    projectId: testProjectId("chamber"),
    title: "My chamber",
    authoredAt: "2026-01-01T00:00:00.000Z",
    provider: "stub",
    model: "offline-tutorial",
    library: {
      version: 1,
      source: "folder",
      revision: testRevision("altered-chamber"),
      validation: { status: "ready", message: "Checked." },
    },
  };
  const installed: InstalledGameDescriptor = {
    folder: "chamber",
    hash: "shared-vocabulary",
    alias: "chamber",
    title: "Original chamber",
  };
  assert.equal(coalescesInstalled(saved, installed), false);
});

test("a catalog alias alone cannot hide an installed build awaiting its fingerprint", () => {
  const entry = GAME_CATALOG[0]!;
  const installed: InstalledGameDescriptor = {
    folder: "local-alteration",
    hash: "shared-vocabulary",
    alias: entry.id,
    title: "My alteration",
  };
  assert.equal(isInstalledCatalogCopy(installed, entry), false);
});

test("a remix parent names the exact fingerprinted installation with a Unicode folder", () => {
  const revision = testRevision("unicode-installation");
  const installed: InstalledGameDescriptor = {
    folder: "Moon Room Å",
    hash: "shared-vocabulary",
    alias: "moon-room",
    title: "Moon Room",
    revision,
  };
  const target = installedProgressTarget(installed, revision);
  assert.ok(target);
  assert.equal(parentDisplayTitle(target.identity, [], [installed]), "Moon Room");
});

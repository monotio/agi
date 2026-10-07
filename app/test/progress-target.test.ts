import assert from "node:assert/strict";
import { test } from "node:test";
import { projectId } from "../../src/gameIdentity.ts";
import {
  installedProgressLocator,
  installedProgressTarget,
  isProgressNamespace,
  parseProgressLocator,
  projectProgressTarget,
  resolveInstalledFolder,
  type ProgressTarget,
} from "../src/project/progressTarget.ts";
import { testRevision } from "./identity.ts";

// SHA-256 digests of the fixture folders' exact UTF-8 bytes, computed with an
// independent implementation (Node crypto), never with the module under test.
const KQ1_DIGEST = "6136440f3e95935c6e7481b8fe4389cc46d2cdbf864b31e13f9d0f896fb27c60";
const KQ1_UPPER_DIGEST = "5c36d65ee0d419e505b30e7c944fa58159b156b068cb355af155daac5e12428b";
const ORIGINAL_SAGA_DIGEST = "7973d6b725e7aa57bf8fdfd8dcc16cee7246f8b5983d260f8c14517f4e9977a1";
const COLON_FOLDER_DIGEST = "f9426fd11039967f2058fdcce99abb92503e518a0c59aff58b6764f1eb5853a1";
const HASH = "ab".repeat(32);
const REVISION = testRevision("progress-target");
const REVISION_B = testRevision("progress-target-successor");
const EPOCH_A = "3f6b0a1e-9c2d-4e5f-8a7b-0c1d2e3f4a5b";
const EPOCH_B = "11111111-2222-4333-8444-555555555555";

test("an installed locator is installed: + folder SHA-256 + the full revision", () => {
  assert.equal(installedProgressLocator("kq1", REVISION), `installed:${KQ1_DIGEST}:${REVISION}`);
  assert.equal(
    installedProgressLocator("Original Saga", REVISION),
    `installed:${ORIGINAL_SAGA_DIGEST}:${REVISION}`,
  );
  // Case, byte spelling and revision are all part of the address.
  assert.notEqual(
    installedProgressLocator("KQ1", REVISION),
    installedProgressLocator("kq1", REVISION),
  );
  assert.equal(
    installedProgressLocator("KQ1", REVISION),
    `installed:${KQ1_UPPER_DIGEST}:${REVISION}`,
  );
  assert.notEqual(
    installedProgressLocator("kq1", REVISION_B),
    installedProgressLocator("kq1", REVISION),
  );
});

test("an installed locator requires a full resource revision", () => {
  for (const revision of [
    "",
    "abc",
    "0".repeat(63),
    "0".repeat(65),
    "z".repeat(64),
    REVISION.toUpperCase(),
    `${REVISION}:x`,
    ` ${REVISION}`,
  ]) {
    assert.equal(installedProgressLocator("kq1", revision), null, revision);
    assert.equal(installedProgressTarget({ folder: "kq1" }, revision), null, revision);
  }
});

test("folders with no single UTF-8 spelling are refused", () => {
  for (const folder of ["", "\uD800", "room-\uD800", "\uDC00remix", "ok\uD800\uD801x"]) {
    assert.equal(installedProgressLocator(folder, REVISION), null, folder);
    assert.equal(installedProgressTarget({ folder }, REVISION), null, folder);
  }
  // A missing folder is no current instance at all.
  for (const folder of [undefined, null])
    assert.equal(installedProgressTarget({ folder }, REVISION), null);
});

test("an installed target is stable and byte-exact across every spelling", () => {
  const folders = [
    "kq1",
    "Original Saga",
    "ΓΧΠ ΛΕΞΕΙΣ",
    "パイロット",
    "a".repeat(200),
    "installed:trap",
    "project:decoy",
    "🎮 room",
  ];
  const locators = new Set<string>();
  for (const folder of folders) {
    const target = installedProgressTarget({ folder, hash: HASH, alias: "x" }, REVISION);
    assert.ok(target);
    assert.equal(target.kind, "installed");
    assert.equal(target.folder, folder);
    assert.equal(target.locator, installedProgressLocator(folder, REVISION));
    assert.ok(!locators.has(target.locator), folder);
    locators.add(target.locator);
    // Deterministic: the same inputs rebuild an equal record.
    const again = installedProgressTarget({ folder, hash: HASH, alias: "x" }, REVISION);
    assert.deepEqual(again, target);
  }
  assert.equal(locators.size, folders.length);
  // NFC and NFD spellings of the same visual name stay distinct.
  const nfc = installedProgressTarget({ folder: "déjà vu" }, REVISION)!;
  const nfd = installedProgressTarget({ folder: "de\u0301ja\u0300 vu" }, REVISION)!;
  assert.notEqual(nfc.locator, nfd.locator);
});

test("an installed identity keeps a valid folder id and falls back to the folder digest", () => {
  const slug = installedProgressTarget({ folder: "original-saga" }, REVISION)!;
  assert.equal(slug.identity.project, "original-saga");
  assert.equal(slug.identity.revision, REVISION);

  const spaced = installedProgressTarget({ folder: "Original Saga" }, REVISION)!;
  assert.equal(spaced.identity.project, `installed-${ORIGINAL_SAGA_DIGEST}`);
  assert.equal(projectId(spaced.identity.project), spaced.identity.project);
  assert.ok(!spaced.identity.project.includes(":"));

  const colon = installedProgressTarget({ folder: "project:decoy" }, REVISION)!;
  assert.equal(colon.identity.project, `installed-${COLON_FOLDER_DIGEST}`);
  assert.ok(!colon.identity.project.includes(":"));
});

test("installed legacy keys keep the released folder-if-valid then hash then alias order", () => {
  const target = installedProgressTarget(
    { folder: "original-saga", hash: HASH, alias: "saga" },
    REVISION,
  )!;
  assert.deepEqual(target.legacyKeys, ["original-saga", HASH, "saga"]);
  // A folder outside the id alphabet was never a storage key; hash then alias stand.
  const hashed = installedProgressTarget(
    { folder: "Original Saga", hash: HASH, alias: "saga" },
    REVISION,
  )!;
  assert.deepEqual(hashed.legacyKeys, [HASH, "saga"]);
  // Only explicit descriptor evidence becomes a candidate; duplicates collapse.
  assert.deepEqual(installedProgressTarget({ folder: "kq1" }, REVISION)!.legacyKeys, ["kq1"]);
  assert.deepEqual(
    installedProgressTarget({ folder: "kq1", hash: "kq1", alias: "kq1" }, REVISION)!.legacyKeys,
    ["kq1"],
  );
  assert.deepEqual(installedProgressTarget({ folder: "My Game" }, REVISION)!.legacyKeys, []);
});

test("a project target binds the unchanged id and the captured live epoch", () => {
  const target = projectProgressTarget("original-saga", REVISION, EPOCH_A)!;
  assert.ok(target);
  assert.equal(target.kind, "project");
  assert.equal(target.locator, `project:original-saga:${EPOCH_A}`);
  assert.equal(target.project, "original-saga");
  assert.equal(target.bodyEpoch, EPOCH_A);
  assert.equal(target.identity.project, "original-saga");
  assert.equal(target.identity.revision, REVISION);
  assert.deepEqual(target.legacyKeys, ["original-saga"]);
  // A receipt-free pre-receipt body binds the explicit "initial" epoch.
  const initial = projectProgressTarget("original-saga", REVISION, "initial")!;
  assert.equal(initial.locator, "project:original-saga:initial");
  assert.equal(initial.bodyEpoch, "initial");
});

test("the epoch discriminates a delete-and-recreate under one id", () => {
  const removed = projectProgressTarget("original-saga", REVISION, EPOCH_A)!;
  const recreated = projectProgressTarget("original-saga", REVISION, EPOCH_B)!;
  assert.notEqual(removed.locator, recreated.locator);
  assert.equal(removed.project, recreated.project);
  assert.equal(removed.identity.project, recreated.identity.project);
});

test("project targets refuse a missing, deleted or speculative epoch", () => {
  for (const epoch of [null, undefined, "", "INITIAL", "next", "unknown", "0"]) {
    assert.equal(projectProgressTarget("original-saga", REVISION, epoch), null, `${epoch}`);
  }
  // Shape violations: unhyphenated, wrong lengths, bad alphabet, key-breaking marks.
  for (const epoch of [
    "3f6b0a1e9c2d4e5f8a7b0c1d2e3f4a5b",
    EPOCH_A.toUpperCase(),
    `${EPOCH_A}/next`,
    `${EPOCH_A}:tail`,
    "3f6b0a1e-9c2d-4e5f-8a7b-0c1d2e3f4a5",
    "3f6b0a1e-9c2d-4e5f-8a7b-0c1d2e3f4a5b00",
  ]) {
    assert.equal(projectProgressTarget("original-saga", REVISION, epoch), null, epoch);
  }
});

test("both domains name one project string with disjoint addresses", () => {
  const installed = installedProgressTarget({ folder: "custom" }, REVISION)!;
  const saved = projectProgressTarget("custom", REVISION, "initial")!;
  assert.equal(installed.identity.project, saved.identity.project);
  assert.equal(installed.identity.project, "custom");
  assert.notEqual(installed.locator, saved.locator);
  assert.notEqual(installed.kind, saved.kind);
  // Neither physical locator parses as the other domain.
  assert.equal(parseProgressLocator(installed.locator)?.kind, "installed");
  assert.equal(parseProgressLocator(saved.locator)?.kind, "project");
});

test("the locator parser decodes only the two physical forms", () => {
  const installed = parseProgressLocator(`installed:${KQ1_DIGEST}:${REVISION}`)!;
  assert.deepEqual(installed, {
    kind: "installed",
    folderDigest: KQ1_DIGEST,
    revision: REVISION,
  });
  const saved = parseProgressLocator("project:remix-9f8e:initial")!;
  assert.deepEqual(saved, {
    kind: "project",
    project: "remix-9f8e",
    bodyEpoch: "initial",
  });
  assert.deepEqual(parseProgressLocator(`project:custom:${EPOCH_A}`), {
    kind: "project",
    project: "custom",
    bodyEpoch: EPOCH_A,
  });
});

test("the locator parser refuses legacy spellings, malformed parts and unknown prefixes", () => {
  const refused = [
    "",
    "kq1",
    "original-saga",
    KQ1_DIGEST,
    "installed:",
    `installed:${KQ1_DIGEST}`,
    `installed:${KQ1_DIGEST}:`,
    `installed:${KQ1_DIGEST}:not-a-revision`,
    `installed:${KQ1_DIGEST}:${REVISION.toUpperCase()}`,
    `installed:${KQ1_DIGEST}:${"0".repeat(63)}`,
    `installed:${KQ1_DIGEST}:${"z".repeat(64)}`,
    `installed:${KQ1_DIGEST}:${REVISION}:extra`,
    `installed::${REVISION}`,
    `installed:${"0".repeat(63)}`,
    `installed:${"0".repeat(65)}`,
    `installed:${"0".repeat(63)}:${REVISION}`,
    `installed:${KQ1_DIGEST.toUpperCase()}`,
    `installed:${KQ1_DIGEST.toUpperCase()}:${REVISION}`,
    `installed:${"z".repeat(64)}`,
    `installed:${"z".repeat(64)}:${REVISION}`,
    "project:",
    "project:custom",
    "project:custom:",
    "project::initial",
    "project:bad id:initial",
    "project:custom:INITIAL",
    "project:custom:not-an-epoch",
    "project:a:b:c",
    `project:custom:${EPOCH_A}:extra`,
    "history/original-saga",
    "monotio_agi.saves.original-saga",
    "installedx:" + "0".repeat(64),
  ];
  for (const locator of refused) {
    assert.equal(parseProgressLocator(locator), null, locator);
  }
});

test("the namespace predicate recognizes current locators and the exact old form only", () => {
  // Both current writable locator domains plus the complete unreleased
  // folder-only predecessor.
  for (const source of [
    `installed:${KQ1_DIGEST}:${REVISION}`,
    `installed:${KQ1_DIGEST}`,
    "project:remix-9f8e:initial",
    `project:remix-9f8e:${EPOCH_A}`,
  ]) {
    assert.equal(isProgressNamespace(source), true, source);
  }
  // Every near-match stays an ordinary released spelling — wrong digest
  // length or case, a stray segment or edge, a partial locator, a bare
  // storage key — with no case, trim, Unicode or decode normalization.
  for (const source of [
    "",
    "installed:",
    "installed:trap",
    `installed:${"0".repeat(63)}`,
    `installed:${"0".repeat(65)}`,
    `installed:${KQ1_DIGEST.toUpperCase()}`,
    `installed:${"z".repeat(64)}`,
    `installed:${KQ1_DIGEST}:`,
    `installed:${KQ1_DIGEST}:extra`,
    `installed:${KQ1_DIGEST}:${REVISION}:extra`,
    ` installed:${KQ1_DIGEST}`,
    `installed:${KQ1_DIGEST} `,
    `installed%3A${KQ1_DIGEST}`,
    `installedx:${"0".repeat(64)}`,
    `installed::${REVISION}`,
    `installed:${"0".repeat(63)}:${REVISION}`,
    "project:",
    "project:custom",
    "project:custom:",
    "project::initial",
    "project:ordinary-folder",
    "project:custom:INITIAL",
    "project:custom:not-an-epoch",
    "project:a:b:c",
    "original-saga",
    HASH,
    "history/original-saga",
    "monotio_agi.saves.original-saga",
  ]) {
    assert.equal(isProgressNamespace(source), false, source);
  }
  // Classification only: the recognized old spelling still yields no
  // writable target, parsed locator or resolution.
  assert.equal(parseProgressLocator(`installed:${KQ1_DIGEST}`), null);
  assert.deepEqual(resolveInstalledFolder(`installed:${KQ1_DIGEST}`, ["kq1"]), {
    status: "unresolved",
  });
});

test("an installed locator resolves to the exact folder by derived equality", () => {
  const locator = installedProgressLocator("remix-saga", REVISION)!;
  const entries = [
    { folder: "original-saga", hash: HASH, alias: "saga" },
    { folder: "remix-saga", hash: HASH, alias: "remix" },
  ];
  assert.deepEqual(resolveInstalledFolder(locator, entries), {
    status: "resolved",
    folder: "remix-saga",
  });
  // String entries name folders directly; duplicate listings still resolve once.
  assert.deepEqual(resolveInstalledFolder(locator, ["original-saga", "remix-saga"]), {
    status: "resolved",
    folder: "remix-saga",
  });
  assert.deepEqual(resolveInstalledFolder(locator, ["remix-saga", { folder: "remix-saga" }]), {
    status: "resolved",
    folder: "remix-saga",
  });
  // Derived equality is byte-exact: the case sibling does not answer.
  assert.deepEqual(
    resolveInstalledFolder(installedProgressLocator("KQ1", REVISION)!, ["kq1", "original-saga"]),
    { status: "unresolved" },
  );
  // Routing keys on the folder digest alone: the same folder answers a
  // locator minted under either revision. Whether the folder still serves
  // that revision is the caller's separate check.
  assert.deepEqual(
    resolveInstalledFolder(installedProgressLocator("remix-saga", REVISION_B)!, ["remix-saga"]),
    { status: "resolved", folder: "remix-saga" },
  );
});

test("resolution never picks a spelling or picks first", () => {
  // A hash, alias, folder spelling, project locator or folder-only
  // installed row is not a qualified installed address.
  for (const locator of [
    HASH,
    "remix-saga",
    "project:custom:initial",
    "installed:nope",
    `installed:${"0".repeat(64)}`,
  ]) {
    assert.deepEqual(
      resolveInstalledFolder(locator, [{ folder: "remix-saga", hash: HASH, alias: "remix" }]),
      { status: "unresolved" },
      locator,
    );
  }
  // A folder-less descriptor is legacy read context, not a match.
  assert.deepEqual(
    resolveInstalledFolder(installedProgressLocator("remix-saga", REVISION)!, [
      { hash: HASH, alias: "remix-saga" },
    ]),
    { status: "unresolved" },
  );
  assert.deepEqual(resolveInstalledFolder(installedProgressLocator("kq1", REVISION)!, null), {
    status: "unresolved",
  });
  assert.deepEqual(resolveInstalledFolder(installedProgressLocator("kq1", REVISION)!, []), {
    status: "unresolved",
  });
});

test("targets, identities, candidate lists and parsed locators arrive frozen and detached", () => {
  const evidence = { folder: "Original Saga", hash: HASH, alias: "saga" };
  const installed = installedProgressTarget(evidence, REVISION)!;
  const saved = projectProgressTarget("original-saga", REVISION, EPOCH_A)!;
  const targets: ProgressTarget[] = [installed, saved];
  for (const target of targets) {
    assert.ok(Object.isFrozen(target));
    assert.ok(Object.isFrozen(target.identity));
    assert.ok(Object.isFrozen(target.legacyKeys));
    assert.throws(() => {
      (target as { locator: string }).locator = "installed:forged";
    }, TypeError);
    assert.throws(() => {
      (target.legacyKeys as string[]).push("legacy:forged");
    }, TypeError);
  }
  // Mutating the evidence the target was built from cannot reach inside it.
  evidence.alias = "moved";
  assert.deepEqual(installed.legacyKeys, [HASH, "saga"]);
  const parsed = parseProgressLocator(saved.locator)!;
  assert.ok(Object.isFrozen(parsed));
  const resolution = resolveInstalledFolder(installed.locator, [{ folder: "Original Saga" }]);
  assert.ok(Object.isFrozen(resolution));
});

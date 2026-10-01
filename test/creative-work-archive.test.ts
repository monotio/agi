import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/crypto.ts";
import { CREATIVE_SOURCE_FORMAT, type CreativeSource } from "../src/creative/catalog.ts";
import type { CreativeRecoveryBase } from "../src/creative/recovery.ts";
import { resourceRevision } from "../src/gameIdentity.ts";
import {
  CREATIVE_WORK_FORMAT,
  readCreativeWork,
  writeCreativeWork,
} from "../src/creative/workArchive.ts";

function blobBytes(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (seed + i) & 0xff;
  return bytes;
}

function blobRef(bytes: Uint8Array, mime: string) {
  return { hash: sha256Hex(bytes), byteLength: bytes.length, mime };
}

const RASTER = blobBytes(9, 16); // a 2x2 tightly packed RGBA8 raster
const ENCODED = blobBytes(3, 40);
const UNDO_BYTES = blobBytes(50, 24);

function source(id: string, encoded: Uint8Array = ENCODED): CreativeSource {
  return {
    format: CREATIVE_SOURCE_FORMAT,
    version: 1,
    identity: { id, incarnation: "inc", revision: 0 },
    encoded: blobRef(encoded, "image/png"),
    availability: "original",
    normalized: {
      blob: blobRef(RASTER, "application/x-rgba8"),
      format: "rgba8-srgb-unpremultiplied-v1",
      width: 2,
      height: 2,
    },
    origin: { kind: "import", title: `Source ${id}` },
  };
}

const BASIS = {
  revision: resourceRevision(sha256Hex(blobBytes(7, 32)))!,
  authoring: "a".repeat(64),
  profileId: "2.936" as const,
  kept: 1,
};

function base(overrides: Partial<CreativeRecoveryBase> = {}): CreativeRecoveryBase {
  return { ...BASIS, pins: [], ...overrides };
}

function recovery(src: CreativeSource, overrides: Partial<CreativeRecoveryBase> = {}) {
  return {
    base: base(overrides),
    sources: [src],
    derivatives: [],
    board: [],
    recipes: [],
    drafts: [],
  };
}

function workInput(overrides: Record<string, unknown> = {}) {
  const src = source("s1");
  return {
    basis: BASIS,
    drafts: [{ workspace: "ws-b", status: "current" as const, recovery: recovery(src) }],
    undos: [],
    retained: [],
    blobs: {
      [sha256Hex(ENCODED)]: {
        hash: sha256Hex(ENCODED),
        byteLength: ENCODED.length,
        mime: "image/png",
        buckets: ["original" as const],
      },
      [sha256Hex(RASTER)]: {
        hash: sha256Hex(RASTER),
        byteLength: RASTER.length,
        mime: "application/x-rgba8",
        buckets: ["canonical" as const],
      },
    },
    ...overrides,
  };
}

test("an empty work envelope round-trips", () => {
  const record = writeCreativeWork({
    basis: BASIS,
    drafts: [],
    undos: [],
    retained: [],
    blobs: {},
  });
  assert.equal(record["format"], CREATIVE_WORK_FORMAT);
  assert.equal(record["version"], 1);
  const read = readCreativeWork(record);
  assert.deepEqual(read.basis, BASIS);
  assert.deepEqual(read.drafts, []);
  assert.deepEqual(read.undos, []);
  assert.deepEqual(read.retained, []);
  assert.deepEqual(read.blobs, {});
});

test("drafts, undos and retained material round-trip with canonical ordering", () => {
  const record = writeCreativeWork(
    workInput({
      drafts: [
        { workspace: "ws-z", status: "current", recovery: recovery(source("s1")) },
        { workspace: "ws-a", status: "stale", recovery: recovery(source("s2"), { kept: 7 }) },
      ],
      undos: [
        {
          workspace: "ws-b",
          status: "stale",
          recovery: recovery(source("s3"), { revision: resourceRevision("0".repeat(64))! }),
        },
        { workspace: "ws-a", status: "stale", recovery: recovery(source("s4"), { kept: 3 }) },
      ],
      retained: [[sha256Hex(UNDO_BYTES)]],
      blobs: {
        [sha256Hex(ENCODED)]: {
          hash: sha256Hex(ENCODED),
          byteLength: ENCODED.length,
          mime: "image/png",
          buckets: ["original" as const],
        },
        [sha256Hex(RASTER)]: {
          hash: sha256Hex(RASTER),
          byteLength: RASTER.length,
          mime: "application/x-rgba8",
          buckets: ["canonical" as const],
        },
        [sha256Hex(UNDO_BYTES)]: {
          hash: sha256Hex(UNDO_BYTES),
          byteLength: UNDO_BYTES.length,
          mime: "application/octet-stream",
          buckets: ["original" as const],
        },
      },
    }),
  );
  const read = readCreativeWork(record);
  assert.deepEqual(
    read.drafts.map((entry) => entry.workspace),
    ["ws-a", "ws-z"],
  );
  assert.deepEqual(
    read.drafts.map((entry) => entry.status),
    ["stale", "current"],
  );
  assert.deepEqual(
    read.undos.map((entry) => entry.workspace),
    ["ws-a", "ws-b"],
  );
  assert.deepEqual(read.retained, [[sha256Hex(UNDO_BYTES)]]);
  assert.equal(Object.keys(read.blobs).length, 3);
});

test("a 'current' claim whose base disagrees with the basis refuses", () => {
  assert.throws(
    () =>
      writeCreativeWork(
        workInput({
          drafts: [
            {
              workspace: "ws-a",
              status: "current",
              recovery: recovery(source("s1"), { kept: 99 }),
            },
          ],
        }),
      ),
    /current.*basis/i,
  );
});

test("a stale entry keeps a foreign base verbatim", () => {
  const foreignBase = base({ kept: 12, revision: resourceRevision("f".repeat(64))! });
  const read = readCreativeWork(
    writeCreativeWork(
      workInput({
        drafts: [
          {
            workspace: "ws-a",
            status: "stale",
            recovery: recovery(source("s1"), foreignBase),
          },
        ],
      }),
    ),
  );
  assert.deepEqual(read.drafts[0]!.recovery.base, foreignBase);
});

test("unknown format, version and extra fields refuse before content", () => {
  const record = writeCreativeWork(workInput());
  assert.throws(() => readCreativeWork({ ...record, format: "other" }), /Unsupported.*format/);
  assert.throws(() => readCreativeWork({ ...record, version: 2 }), /Unsupported.*version/);
  assert.throws(
    () => readCreativeWork({ ...record, projectId: "abc" }),
    /unknown field 'projectId'/,
  );
  assert.throws(() => readCreativeWork({ ...record, leases: [] }), /unknown field 'leases'/);
  const missing = { ...record };
  delete missing["drafts"];
  assert.throws(() => readCreativeWork(missing), /missing 'drafts'/);
});

test("duplicate or unsorted draft workspaces refuse", () => {
  // Two entries naming the same workspace are refused, however offered.
  assert.throws(
    () =>
      writeCreativeWork(
        workInput({
          drafts: [
            { workspace: "ws-a", status: "current", recovery: recovery(source("s1")) },
            { workspace: "ws-a", status: "current", recovery: recovery(source("s2")) },
          ],
        }),
      ),
    /order|once/i,
  );
  // A stored envelope that skips the writer's sort is refused on read.
  const record = writeCreativeWork(
    workInput({
      drafts: [
        { workspace: "ws-a", status: "current", recovery: recovery(source("s1")) },
        { workspace: "ws-b", status: "current", recovery: recovery(source("s2")) },
      ],
    }),
  );
  const drafts = record["drafts"] as unknown[];
  const swapped = { ...record, drafts: [drafts[1], drafts[0]] };
  assert.throws(() => readCreativeWork(swapped), /order|once/i);
});

test("undo entries must keep workspace groups contiguous", () => {
  const undos = [
    { workspace: "ws-b", status: "stale", recovery: recovery(source("s1"), { kept: 0 }) },
    { workspace: "ws-a", status: "stale", recovery: recovery(source("s2"), { kept: 0 }) },
    { workspace: "ws-b", status: "stale", recovery: recovery(source("s3"), { kept: 0 }) },
  ];
  // The writer sorts by workspace; construct a non-contiguous stored order.
  const record = writeCreativeWork(workInput({ undos }));
  const stored = (record["undos"] as { workspace: string }[]).map((entry) => entry.workspace);
  assert.deepEqual(stored, ["ws-a", "ws-b", "ws-b"]);
  const entries = record["undos"] as unknown[];
  const reordered = { ...record, undos: [entries[1], entries[0], entries[2]] };
  assert.throws(() => readCreativeWork(reordered), /contiguous|order/i);
});

test("the registry must cover exactly the referenced hashes", () => {
  // A retained hash without a registry entry refuses.
  assert.throws(
    () => writeCreativeWork(workInput({ retained: [[sha256Hex(UNDO_BYTES)]] })),
    /lacks/i,
  );
  // A registry entry nothing references refuses.
  assert.throws(
    () =>
      writeCreativeWork(
        workInput({
          blobs: {
            ...(workInput().blobs as Record<string, unknown>),
            [sha256Hex(UNDO_BYTES)]: {
              hash: sha256Hex(UNDO_BYTES),
              byteLength: UNDO_BYTES.length,
              mime: "application/octet-stream",
              buckets: ["original" as const],
            },
          },
        }),
      ),
    /not referenced/i,
  );
});

test("a registry descriptor disagreeing with a recovery's claim refuses", () => {
  const wrong = {
    hash: sha256Hex(ENCODED),
    byteLength: ENCODED.length + 1,
    mime: "image/png",
    buckets: ["original" as const],
  };
  assert.throws(
    () =>
      writeCreativeWork(
        workInput({
          blobs: {
            [sha256Hex(ENCODED)]: wrong,
            [sha256Hex(RASTER)]: (workInput().blobs as Record<string, unknown>)[sha256Hex(RASTER)],
          },
        }),
      ),
    /disagrees/i,
  );
});

test("retained inventories canonicalize and deduplicate", () => {
  const a = sha256Hex(blobBytes(1, 8));
  const b = sha256Hex(blobBytes(2, 8));
  const descriptor = (hash: string) => ({
    hash,
    byteLength: 8,
    mime: "application/octet-stream",
    buckets: ["original" as const],
  });
  const record = writeCreativeWork(
    workInput({
      drafts: [],
      retained: [[b, a], [a]],
      blobs: { [a]: descriptor(a), [b]: descriptor(b) },
    }),
  );
  const read = readCreativeWork(record);
  // Inventories canonicalize element-wise: [b, a] (b < a) sorts before [a].
  assert.deepEqual(read.retained, [[b, a], [a]]);
  const unsorted = { ...record, retained: [[a, b]] };
  assert.throws(() => readCreativeWork(unsorted), /canonical order/i);
});

test("a malformed workspace id refuses", () => {
  assert.throws(
    () =>
      writeCreativeWork(
        workInput({
          drafts: [
            { workspace: "bad workspace!", status: "current", recovery: recovery(source("s1")) },
          ],
        }),
      ),
    /workspace/i,
  );
});

test("the reader never trusts embedded storage authority", () => {
  const record = writeCreativeWork(workInput());
  const withAuthority = {
    ...record,
    drafts: [
      {
        ...(record["drafts"] as Record<string, unknown>[])[0],
        holdId: "recovery-x",
      },
    ],
  };
  assert.throws(() => readCreativeWork(withAuthority), /unknown field 'holdId'/);
});

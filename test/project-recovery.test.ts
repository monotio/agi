import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ProjectDraft, type DraftRecovery } from "../src/authoring/projectDraft.ts";
import {
  PROJECT_RECOVERY_FORMAT,
  PROJECT_RECOVERY_LIMITS,
  readProjectRecovery,
  restoreProjectRecovery,
  writeProjectRecovery,
  type PortableProjectRecovery,
  type RecoveryBase,
  type RecoveryDocumentContent,
} from "../src/authoring/projectRecovery.ts";
import { requireResourceRevision } from "../src/gameIdentity.ts";

const kept = {
  "logic:0": "return;",
  "logic:1": "return;",
  "view:1": Uint8Array.of(1),
  words: "[]",
};

const base = (): RecoveryBase => ({
  revision: requireResourceRevision("0123456789abcdef".repeat(4)),
  authoring: "fedcba9876543210".repeat(4),
  profileId: "2.936",
});

const envelope = () => ({
  format: "monotio.agi.recovery-draft",
  version: 1,
  base: {
    revision: "0123456789abcdef".repeat(4),
    authoring: "fedcba9876543210".repeat(4),
    profileId: "2.936",
  },
  documents: [
    { key: "logic:0", version: 3, content: { type: "text", text: 'print("unfinished' } },
    { key: "view:1", version: 1, content: { type: "deleted" } },
    { key: "words", version: 2, content: { type: "bytes", bytes: [0, 1, 255] } },
  ],
  operations: [{ keys: ["logic:0", "words"] }],
});

const recovery = (): DraftRecovery => ({
  changes: [
    { key: "logic:0", version: 3, content: 'print("unfinished' },
    { key: "view:1", version: 1, content: null },
    { key: "words", version: 2, content: Uint8Array.of(0, 1, 255) },
  ],
  groups: [["logic:0", "words"]],
});

test("writeProjectRecovery emits the exact canonical envelope without mutating its input", () => {
  const bytes = Uint8Array.of(0, 1, 255);
  const changes = [
    { key: "words", version: 2, content: bytes as string | Uint8Array | null },
    { key: "logic:0", version: 3, content: 'print("unfinished' as string | Uint8Array | null },
    { key: "view:1", version: 1, content: null as string | Uint8Array | null },
  ];
  const groups = [
    ["picture:2", "sound:1"],
    ["words", "logic:0"],
  ];
  const written: PortableProjectRecovery = writeProjectRecovery(base(), { changes, groups });
  assert.equal(written.format, PROJECT_RECOVERY_FORMAT);
  assert.deepEqual(written, {
    format: "monotio.agi.recovery-draft",
    version: 1,
    base: {
      revision: "0123456789abcdef".repeat(4),
      authoring: "fedcba9876543210".repeat(4),
      profileId: "2.936",
    },
    documents: [
      { key: "logic:0", version: 3, content: { type: "text", text: 'print("unfinished' } },
      { key: "view:1", version: 1, content: { type: "deleted" } },
      { key: "words", version: 2, content: { type: "bytes", bytes: [0, 1, 255] } },
    ],
    operations: [{ keys: ["logic:0", "words"] }, { keys: ["picture:2", "sound:1"] }],
  });
  assert.equal(Object.isFrozen(written), true);
  assert.equal(Object.isFrozen(written.documents), true);
  assert.deepEqual(
    changes.map((change) => change.key),
    ["words", "logic:0", "view:1"],
  );
  assert.deepEqual(groups, [
    ["picture:2", "sound:1"],
    ["words", "logic:0"],
  ]);
  bytes[0] = 9;
  const content: RecoveryDocumentContent = written.documents[2]!.content;
  assert.deepEqual(content, { type: "bytes", bytes: [0, 1, 255] });
});

test("readProjectRecovery decodes the envelope into detached draft state", () => {
  const stored = envelope();
  const parsed = readProjectRecovery(stored);
  assert.deepEqual(parsed.base, base());
  assert.deepEqual(parsed.recovery, {
    changes: [
      { key: "logic:0", version: 3, content: 'print("unfinished' },
      { key: "view:1", version: 1, content: null },
      { key: "words", version: 2, content: Uint8Array.of(0, 1, 255) },
    ],
    groups: [["logic:0", "words"]],
  });
  const decoded = parsed.recovery.changes[2]!.content;
  assert.equal(decoded instanceof Uint8Array, true);
  (stored.documents[2]!.content as { bytes: number[] }).bytes[0] = 99;
  assert.deepEqual(decoded, Uint8Array.of(0, 1, 255));
});

test("JSON round trip keeps unfinished text, unpaired surrogates, deletion and bytes", () => {
  const draft = new ProjectDraft(kept);
  draft.edit("logic:0", 'print("\ud800', draft.capture().version("logic:0"));
  draft.edit("view:1", null, draft.capture().version("view:1"));
  draft.edit("words", "", draft.capture().version("words"));
  const stored = JSON.parse(JSON.stringify(writeProjectRecovery(base(), draft.captureRecovery())));
  const restored = restoreProjectRecovery({ documents: kept, base: base(), recovery: stored });
  assert.equal(restored.capture().read("logic:0")?.content, 'print("\ud800');
  assert.equal(restored.capture().read("view:1"), undefined);
  assert.equal(restored.capture().read("words")?.content, "");
});

test("the stored v1 fixture decodes and the writer reproduces it exactly", () => {
  const path = fileURLToPath(new URL("./formats/recovery-draft-v1.json", import.meta.url));
  const text = readFileSync(path, "utf8");
  const parsed = readProjectRecovery(JSON.parse(text));
  assert.deepEqual(parsed.base, base());
  assert.deepEqual(parsed.recovery, recovery());
  const rewritten = writeProjectRecovery(base(), parsed.recovery);
  assert.equal(JSON.stringify(rewritten), JSON.stringify(JSON.parse(text)));
});

test("restoreProjectRecovery refuses a saved base that differs from the current project", () => {
  const stored = JSON.parse(JSON.stringify(writeProjectRecovery(base(), recovery())));
  const stale: RecoveryBase[] = [
    { ...base(), revision: requireResourceRevision("ff".repeat(32)) },
    { ...base(), authoring: "0".repeat(64) },
    { ...base(), profileId: "3.002.149" },
  ];
  for (const candidate of stale) {
    assert.throws(
      () => restoreProjectRecovery({ documents: kept, base: candidate, recovery: stored }),
      /Stale project recovery/,
    );
  }
});

test("a matching base restores edits and groups without importing old authority", () => {
  const draft = new ProjectDraft(kept);
  const transaction = draft.apply(
    draft.propose(draft.capture(), "Pair", [
      { key: "logic:0", content: "changed" },
      { key: "words", content: "new" },
    ]),
  );
  draft.edit("view:1", null, draft.capture().version("view:1"));
  const proposal = draft.propose(draft.capture(), "Later", [{ key: "logic:1", content: "later" }]);
  const selection = draft.select(["view:1"]);
  const stored = JSON.parse(JSON.stringify(writeProjectRecovery(base(), draft.captureRecovery())));
  const restored = restoreProjectRecovery({ documents: kept, base: base(), recovery: stored });
  assert.deepEqual(restored.dirtyKeys(), ["logic:0", "view:1", "words"]);
  assert.equal(restored.capture().read("logic:0")?.content, "changed");
  assert.deepEqual(restored.select(["logic:0"]).keys, ["logic:0", "words"]);
  assert.deepEqual(restored.select(["view:1"]).keys, ["view:1"]);
  assert.equal(restored.select(["view:1"]).documents()["logic:0"], "return;");
  assert.throws(() => restored.apply(proposal), /workspace/);
  assert.throws(() => restored.acknowledgeKept(selection), /workspace/);
  assert.throws(() => restored.undo(transaction.id), /transaction|undo/i);
});

test("operation groups may keep members that are unchanged or absent documents", () => {
  const stored = {
    ...envelope(),
    documents: [{ key: "logic:0", version: 3, content: { type: "text", text: "changed" } }],
    operations: [{ keys: ["logic:0", "sound:9"] }],
  };
  const restored = restoreProjectRecovery({ documents: kept, base: base(), recovery: stored });
  assert.deepEqual(restored.dirtyKeys(), ["logic:0"]);
  assert.deepEqual(restored.select(["logic:0"]).keys, ["logic:0", "sound:9"]);
});

test("an empty recovery round trips into a clean workspace", () => {
  const written = writeProjectRecovery(base(), { changes: [], groups: [] });
  assert.deepEqual(written.documents, []);
  assert.deepEqual(written.operations, []);
  const restored = restoreProjectRecovery({ documents: kept, base: base(), recovery: written });
  assert.deepEqual(restored.dirtyKeys(), []);
});

test("format and version are validated before any content traversal", () => {
  assert.throws(() => readProjectRecovery({ ...envelope(), format: "other" }), /format/);
  assert.throws(
    () => readProjectRecovery({ ...envelope(), version: 2, base: 0, documents: "junk" }),
    /version/,
  );
  for (const value of [null, 7, "draft", []])
    assert.throws(() => readProjectRecovery(value), /object/);
});

test("unknown fields at every schema level are rejected", () => {
  const stored = envelope();
  const attempts = [
    { ...stored, note: "extra" },
    { ...stored, base: { ...stored.base, note: 1 } },
    {
      ...stored,
      documents: [{ key: "logic:0", version: 1, content: { type: "deleted" }, note: 1 }],
    },
    {
      ...stored,
      documents: [{ key: "logic:0", version: 1, content: { type: "text", text: "x", note: 1 } }],
    },
    { ...stored, operations: [{ keys: ["logic:0", "words"], note: 1 }] },
    { format: "monotio.agi.recovery-draft", version: 1, base: stored.base, documents: [] },
    {
      ...stored,
      documents: [{ key: "logic:0", version: 1, content: { type: "text" } }],
    },
    {
      ...stored,
      documents: [{ key: "logic:0", version: 1, content: { type: "blob", blob: [] } }],
    },
  ];
  for (const attempt of attempts) {
    assert.throws(() => readProjectRecovery(attempt), /Invalid|Unsupported|fields/);
  }
});

test("document keys, versions and duplicate keys are validated", () => {
  const document = (entry: object) => ({ ...envelope(), documents: [entry] });
  assert.throws(
    () => readProjectRecovery(document({ key: "../x", version: 1, content: { type: "deleted" } })),
    /document/,
  );
  assert.throws(
    () => readProjectRecovery(document({ key: 5, version: 1, content: { type: "deleted" } })),
    /document|key/,
  );
  for (const version of [0, -1, 1.5, Number.NaN, "2", 2 ** 53]) {
    assert.throws(
      () =>
        readProjectRecovery(document({ key: "logic:0", version, content: { type: "deleted" } })),
      /version/,
    );
  }
  const duplicate = envelope();
  duplicate.documents = [
    { key: "logic:0", version: 1, content: { type: "deleted" } },
    { key: "logic:0", version: 2, content: { type: "deleted" } },
  ];
  assert.throws(() => readProjectRecovery(duplicate), /[Dd]uplicate/);
});

test("byte payloads reject holes, floats and out-of-range values", () => {
  const bytesDocument = (bytes: unknown) => ({
    ...envelope(),
    documents: [{ key: "words", version: 1, content: { type: "bytes", bytes } }],
  });
  for (const bytes of [new Array(3), [0, 1.5], [-1], [256], ["1"], [null], { 0: 1 }]) {
    assert.throws(() => readProjectRecovery(bytesDocument(bytes)), /byte|bytes/);
  }
});

test("operations require two distinct keys that no other operation repeats", () => {
  const withOperations = (operations: unknown) => ({ ...envelope(), operations });
  assert.throws(() => readProjectRecovery(withOperations("x")), /operation/);
  assert.throws(() => readProjectRecovery(withOperations([{ keys: ["logic:0"] }])), /operation/);
  assert.throws(
    () => readProjectRecovery(withOperations([{ keys: ["logic:0", "logic:0"] }])),
    /operation|distinct|repeated/,
  );
  assert.throws(
    () =>
      readProjectRecovery(
        withOperations([{ keys: ["logic:0", "words"] }, { keys: ["words", "tests"] }]),
      ),
    /more than one operation|repeated/,
  );
  assert.throws(
    () => readProjectRecovery(withOperations([{ keys: ["logic:0", "../x"] }])),
    /document/,
  );
});

test("cardinality and payload limits bound the envelope before allocation", () => {
  const documents = Array.from({ length: PROJECT_RECOVERY_LIMITS.maxDocuments + 1 }, () => ({
    key: "logic:0",
    version: 1,
    content: { type: "deleted" },
  }));
  assert.throws(() => readProjectRecovery({ ...envelope(), documents }), /documents/);
  const operations = Array.from({ length: PROJECT_RECOVERY_LIMITS.maxOperations + 1 }, () => ({
    keys: ["logic:0", "words"],
  }));
  assert.throws(() => readProjectRecovery({ ...envelope(), operations }), /operations/);
  assert.throws(
    () =>
      readProjectRecovery({
        ...envelope(),
        operations: [
          { keys: Array(PROJECT_RECOVERY_LIMITS.maxOperationMembers + 1).fill("logic:0") },
        ],
      }),
    /member|operation/,
  );
  const oversizedText = {
    key: "logic:0",
    version: 1,
    content: { type: "text", text: "x".repeat(PROJECT_RECOVERY_LIMITS.maxDocumentBytes / 2 + 1) },
  };
  assert.throws(
    () => readProjectRecovery({ ...envelope(), documents: [oversizedText] }),
    /payload|limit/,
  );
  const oversizedBytes = {
    key: "words",
    version: 1,
    content: { type: "bytes", bytes: new Array(PROJECT_RECOVERY_LIMITS.maxDocumentBytes + 1) },
  };
  assert.throws(
    () => readProjectRecovery({ ...envelope(), documents: [oversizedBytes] }),
    /payload|limit/,
  );
  const each = { type: "bytes", bytes: new Array(PROJECT_RECOVERY_LIMITS.maxDocumentBytes) };
  const total = Array.from({ length: 9 }, (_, index) => ({
    key: `logic:${index}`,
    version: 1,
    content: each,
  }));
  assert.throws(() => readProjectRecovery({ ...envelope(), documents: total }), /total|payload/);
});

test("writeProjectRecovery rejects invalid or oversized draft state", () => {
  assert.throws(
    () =>
      writeProjectRecovery(base(), {
        changes: [{ key: "logic:0", version: 0, content: "x" }],
        groups: [],
      }),
    /version/,
  );
  assert.throws(
    () =>
      writeProjectRecovery(base(), {
        changes: [{ key: "../x", version: 1, content: "x" }],
        groups: [],
      }),
    /document/,
  );
  assert.throws(
    () =>
      writeProjectRecovery(base(), {
        changes: [{ key: "logic:0", version: 1, content: 5 as never }],
        groups: [],
      }),
    /content/,
  );
  assert.throws(
    () =>
      writeProjectRecovery(base(), {
        changes: [
          { key: "logic:0", version: 1, content: null },
          { key: "logic:0", version: 1, content: null },
        ],
        groups: [],
      }),
    /[Dd]uplicate/,
  );
  assert.throws(
    () => writeProjectRecovery(base(), { changes: [], groups: [["logic:0", "logic:0"]] }),
    /operation|distinct|repeated/,
  );
  assert.throws(
    () =>
      writeProjectRecovery(base(), {
        changes: [],
        groups: [
          ["logic:0", "words"],
          ["words", "tests"],
        ],
      }),
    /more than one operation|repeated/,
  );
  assert.throws(
    () =>
      writeProjectRecovery(base(), {
        changes: [
          {
            key: "logic:0",
            version: 1,
            content: "x".repeat(PROJECT_RECOVERY_LIMITS.maxDocumentBytes / 2 + 1),
          },
        ],
        groups: [],
      }),
    /payload|limit/,
  );
});

test("writers refuse unexpected draft fields instead of dropping future content", () => {
  const draft = { ...recovery(), futureOperation: { keys: ["logic:0"] } };
  assert.throws(() => writeProjectRecovery(base(), draft), /fields/);
});

test("restore refuses unknown request fields before constructing a workspace", () => {
  const request = { documents: kept, base: base(), recovery: envelope(), futureOperation: true };
  assert.throws(() => restoreProjectRecovery(request), /fields/);
});

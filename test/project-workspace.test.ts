import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PROJECT_WORKSPACE_FORMAT,
  PROJECT_WORKSPACE_LIMITS,
  readProjectWorkspace,
  writeProjectWorkspace,
  type PortableProjectWorkspace,
} from "../src/authoring/projectWorkspace.ts";

const documents = () => ({
  "logic:0": 'print("unfinished',
  "sound:2": Uint8Array.of(0, 1, 255),
  words: Uint8Array.of(60, 0),
  world: '{"rooms":{}}',
});

const envelope = () => ({
  format: "monotio.agi.project-workspace",
  version: 1,
  documents: [
    { key: "logic:0", content: { type: "text", text: 'print("unfinished' } },
    { key: "sound:2", content: { type: "bytes", bytes: [0, 1, 255] } },
    { key: "words", content: { type: "bytes", bytes: [60, 0] } },
    { key: "world", content: { type: "text", text: '{"rooms":{}}' } },
  ],
});

test("writeProjectWorkspace emits the exact canonical envelope without mutating its input", () => {
  const bytes = Uint8Array.of(0, 1, 255);
  const input: Record<string, string | Uint8Array> = {
    world: '{"rooms":{}}',
    "sound:2": bytes,
    "logic:0": 'print("unfinished',
    words: Uint8Array.of(60, 0),
  };
  const written: PortableProjectWorkspace = writeProjectWorkspace(input);
  assert.equal(written.format, PROJECT_WORKSPACE_FORMAT);
  assert.deepEqual(written, envelope());
  assert.equal(Object.isFrozen(written), true);
  assert.equal(Object.isFrozen(written.documents), true);
  assert.equal(Object.isFrozen(written.documents[0]), true);
  assert.equal(Object.isFrozen(written.documents[0]!.content), true);
  const byteContent = written.documents[1]!.content as { bytes: readonly number[] };
  assert.equal(Object.isFrozen(byteContent.bytes), true);
  bytes[0] = 9;
  assert.deepEqual(written.documents[1]!.content, { type: "bytes", bytes: [0, 1, 255] });
  assert.deepEqual(Object.keys(input), ["world", "sound:2", "logic:0", "words"]);
});

test("readProjectWorkspace decodes the envelope into owned documents in canonical order", () => {
  const stored = envelope();
  stored.documents = [...stored.documents].reverse();
  const parsed = readProjectWorkspace(stored);
  assert.deepEqual(parsed, documents());
  assert.equal(Object.isFrozen(parsed), true);
  assert.deepEqual(Object.keys(parsed), ["logic:0", "sound:2", "words", "world"]);
  const decoded = parsed["sound:2"];
  assert.equal(decoded instanceof Uint8Array, true);
  (stored.documents[2]!.content as { bytes: number[] }).bytes[0] = 99;
  assert.deepEqual(decoded, Uint8Array.of(0, 1, 255));
});

test("JSON round trip keeps malformed source, unpaired surrogates and empty payloads", () => {
  const written = writeProjectWorkspace({
    "logic:0": 'print("\ud800',
    "logic:1": "",
    "view:9": new Uint8Array(0),
  });
  const stored = JSON.parse(JSON.stringify(written));
  const parsed = readProjectWorkspace(stored);
  assert.equal(parsed["logic:0"], 'print("\ud800');
  assert.equal(parsed["logic:1"], "");
  const empty = parsed["view:9"];
  assert.equal(empty instanceof Uint8Array, true);
  assert.equal((empty as Uint8Array).length, 0);
});

test("the stored v1 fixture decodes and the writer reproduces it exactly", () => {
  const path = fileURLToPath(new URL("./formats/project-workspace-v1.json", import.meta.url));
  const text = readFileSync(path, "utf8");
  const parsed = readProjectWorkspace(JSON.parse(text));
  assert.deepEqual(parsed, documents());
  const rewritten = writeProjectWorkspace(parsed);
  assert.equal(JSON.stringify(rewritten), JSON.stringify(JSON.parse(text)));
});

test("a music metadata document round trips through the workspace envelope", () => {
  const written = writeProjectWorkspace({
    "logic:0": "return;",
    music: '{"9":{"revision":"21-abcdef12","tempo":120}}',
  });
  const parsed = readProjectWorkspace(JSON.parse(JSON.stringify(written)));
  assert.equal(parsed["music"], '{"9":{"revision":"21-abcdef12","tempo":120}}');
});

test("an empty document set round trips", () => {
  const written = writeProjectWorkspace({});
  assert.deepEqual(written, {
    format: "monotio.agi.project-workspace",
    version: 1,
    documents: [],
  });
  assert.deepEqual(readProjectWorkspace(written), {});
});

test("format and version are validated before any content traversal", () => {
  assert.throws(() => readProjectWorkspace({ ...envelope(), format: "other" }), /format/);
  assert.throws(
    () => readProjectWorkspace({ ...envelope(), version: 3, documents: "junk" }),
    /version/,
  );
  for (const value of [null, 7, "workspace", []])
    assert.throws(() => readProjectWorkspace(value), /object/);
});

test("unknown fields and content types at every schema level are rejected", () => {
  const stored = envelope();
  const attempts = [
    { ...stored, note: "extra" },
    { format: stored.format, version: 1 },
    {
      ...stored,
      documents: [{ key: "logic:0", content: { type: "text", text: "x" }, note: 1 }],
    },
    { ...stored, documents: [{ key: "logic:0" }] },
    {
      ...stored,
      documents: [{ key: "logic:0", content: { type: "text", text: "x", note: 1 } }],
    },
    { ...stored, documents: [{ key: "logic:0", content: { type: "text" } }] },
    { ...stored, documents: [{ key: "logic:0", content: { type: "deleted" } }] },
    { ...stored, documents: [{ key: "logic:0", content: { type: "blob", blob: [] } }] },
    {
      ...stored,
      documents: [{ key: "logic:0", content: { type: "bytes", bytes: [], note: 1 } }],
    },
  ];
  for (const attempt of attempts) {
    assert.throws(() => readProjectWorkspace(attempt), /Invalid|Unsupported|fields/);
  }
});

test("non-plain objects are rejected at every schema level", () => {
  const stored = envelope();
  assert.throws(() => readProjectWorkspace(new Map()), /object/);
  assert.throws(() => readProjectWorkspace({ ...stored, documents: [new Map()] }), /object/);
  assert.throws(
    () =>
      readProjectWorkspace({
        ...stored,
        documents: [{ key: "logic:0", content: new Map() }],
      }),
    /object/,
  );
  assert.throws(() => writeProjectWorkspace(new Map() as never), /object/);
});

test("document keys and duplicate keys are validated", () => {
  const document = (entry: object) => ({ ...envelope(), documents: [entry] });
  for (const key of ["../x", "LOGIC:0", "logic:256", "logic", "", "logics:1", 5, null]) {
    assert.throws(
      () => readProjectWorkspace(document({ key, content: { type: "text", text: "x" } })),
      /document|key|Invalid/,
    );
  }
  const duplicate = {
    ...envelope(),
    documents: [
      { key: "logic:0", content: { type: "text", text: "a" } },
      { key: "logic:0", content: { type: "text", text: "b" } },
    ],
  };
  assert.throws(() => readProjectWorkspace(duplicate), /[Dd]uplicate/);
});

test("byte payloads reject holes, floats, out-of-range and coerced values", () => {
  const bytesDocument = (bytes: unknown) => ({
    ...envelope(),
    documents: [{ key: "words", content: { type: "bytes", bytes } }],
  });
  const invalidBytes = [
    new Array(3),
    [0, 1.5],
    [-1],
    [256],
    ["1"],
    [null],
    [true],
    [0, 1, Number.NaN],
    { 0: 1 },
    "ab",
    Uint8Array.of(1),
  ];
  for (const bytes of invalidBytes) {
    assert.throws(() => readProjectWorkspace(bytesDocument(bytes)), /byte|bytes/);
  }
});

test("cardinality and payload limits bound the envelope before copying", () => {
  const tooMany = Array.from({ length: PROJECT_WORKSPACE_LIMITS.maxDocuments + 1 }, () => ({
    key: "logic:0",
    content: { type: "text", text: "" },
  }));
  assert.throws(() => readProjectWorkspace({ ...envelope(), documents: tooMany }), /documents/);
  const oversizedText = {
    key: "logic:0",
    content: {
      type: "text",
      text: "x".repeat(PROJECT_WORKSPACE_LIMITS.maxDocumentBytes / 2 + 1),
    },
  };
  assert.throws(
    () => readProjectWorkspace({ ...envelope(), documents: [oversizedText] }),
    /payload|limit/,
  );
  // A hole array over the per-document bound fails on size before element checks.
  const oversizedBytes = {
    key: "words",
    content: { type: "bytes", bytes: new Array(PROJECT_WORKSPACE_LIMITS.maxDocumentBytes + 1) },
  };
  assert.throws(
    () => readProjectWorkspace({ ...envelope(), documents: [oversizedBytes] }),
    /payload|limit/,
  );
  const each = { type: "bytes", bytes: new Array(PROJECT_WORKSPACE_LIMITS.maxDocumentBytes) };
  const total = Array.from({ length: 9 }, (_, index) => ({
    key: `logic:${index}`,
    content: each,
  }));
  assert.throws(() => readProjectWorkspace({ ...envelope(), documents: total }), /total|payload/);
  // Text counts UTF-16 code units: maxDocumentBytes/4 astral characters is exactly the bound.
  const boundary = {
    key: "logic:0",
    content: { type: "text", text: "𐀀".repeat(PROJECT_WORKSPACE_LIMITS.maxDocumentBytes / 4) },
  };
  assert.equal(
    readProjectWorkspace({ ...envelope(), documents: [boundary] })["logic:0"],
    boundary.content.text,
  );
});

test("writeProjectWorkspace rejects invalid keys, content and oversized payloads", () => {
  assert.throws(() => writeProjectWorkspace({ "../x": "text" }), /document|Invalid/);
  assert.throws(() => writeProjectWorkspace({ "logic:256": "text" }), /document|Invalid/);
  const invalidContent = [5, null, undefined, [1, 2], { text: "x" }, new Int8Array(2)];
  for (const content of invalidContent) {
    assert.throws(() => writeProjectWorkspace({ "logic:0": content as never }), /content/);
  }
  assert.throws(() => writeProjectWorkspace(null as never), /object/);
  assert.throws(() => writeProjectWorkspace(["a"] as never), /object/);
  const tooMany = Object.fromEntries(
    Array.from({ length: PROJECT_WORKSPACE_LIMITS.maxDocuments + 1 }, (_, index) => [
      `extra${index}`,
      "",
    ]),
  );
  assert.throws(() => writeProjectWorkspace(tooMany), /documents/);
  assert.throws(
    () =>
      writeProjectWorkspace({
        "logic:0": "x".repeat(PROJECT_WORKSPACE_LIMITS.maxDocumentBytes / 2 + 1),
      }),
    /payload|limit/,
  );
});

test("readProjectWorkspace output feeds back through the writer unchanged", () => {
  const stored = JSON.parse(JSON.stringify(envelope()));
  const parsed = readProjectWorkspace(stored);
  assert.equal(JSON.stringify(writeProjectWorkspace(parsed)), JSON.stringify(stored));
});

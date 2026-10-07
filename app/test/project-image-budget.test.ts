import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../../src/crypto.ts";
import { ProjectHistory } from "../../src/authoring/projectHistory.ts";
import { writeProjectHistory } from "../../src/authoring/projectHistoryCodec.ts";
import { writeProjectWorkspace } from "../../src/authoring/projectWorkspace.ts";
import {
  hydrateImageAttachments,
  externalizeImageAttachments,
} from "../src/archive/projectImageArchive.ts";
import { readProjectContext } from "../src/archive/projectArchive.ts";

const bytes = Uint8Array.of(17, 34, 51);
const hash = sha256Hex(bytes);
const key = `attachment:${hash}`;
function fixture() {
  const documents = { [key]: bytes };
  const history = new ProjectHistory(sha256Hex);
  history.record(documents, { label: "Image", origin: "picture", author: "creator", time: 0 });
  const entries: { name: string; data: Uint8Array }[] = [];
  const envelopes = externalizeImageAttachments(
    writeProjectWorkspace(documents),
    writeProjectHistory(history.capture(), sha256Hex),
    entries,
  );
  return {
    ...envelopes,
    entries: new Map(entries.map((entry) => [entry.name.toUpperCase(), entry.data])),
  };
}
function refuseBeforeExpansion(workspace: unknown, projectHistory: unknown, pattern: RegExp) {
  const { entries } = fixture();
  let expansions = 0;
  const original = Array.from;
  Array.from = ((value: unknown, ...rest: unknown[]) => {
    if (value instanceof Uint8Array && value.length === bytes.length) expansions++;
    return Reflect.apply(original, Array, [value, ...rest]);
  }) as typeof Array.from;
  try {
    assert.throws(
      () =>
        readProjectContext(
          new TextEncoder().encode(
            JSON.stringify({
              format: "monotio.agi.project",
              version: 1,
              workspace,
              projectHistory,
            }),
          ),
          entries,
          "",
        ),
      pattern,
    );
    assert.equal(expansions, 0, "invalid envelopes must fail before expanding any attachment");
  } finally {
    Array.from = original;
  }
}
test("duplicate workspace attachment references refuse before expansion", () => {
  const { workspace } = fixture();
  refuseBeforeExpansion(
    { ...workspace, documents: new Array(16).fill(workspace!.documents[0]) },
    undefined,
    /duplicate document/,
  );
});
test("workspace document count refuses before expansion", () => {
  const { workspace } = fixture();
  refuseBeforeExpansion(
    { ...workspace, documents: new Array(1032).fill(workspace!.documents[0]) },
    undefined,
    /at most 1031/,
  );
});
test("duplicate History commits refuse before expansion", () => {
  const { history } = fixture();
  refuseBeforeExpansion(
    undefined,
    { ...history, commits: [history!.commits[0], history!.commits[0]] },
    /duplicate commit/,
  );
});
test("History commit count refuses before expansion", () => {
  const { history } = fixture();
  refuseBeforeExpansion(
    undefined,
    { ...history, commits: new Array(1025).fill(history!.commits[0]) },
    /commit count/,
  );
});
test("attachment tags are accepted only in attachment document content", () => {
  const { workspace } = fixture();
  refuseBeforeExpansion(
    { ...workspace, documents: [{ key: "view:1", content: workspace!.documents[0]!.content }] },
    undefined,
    /attachment/,
  );
});
test("workspace and History share one expanded attachment", () => {
  const { workspace, history, entries } = fixture();
  // Both envelopes must be checked before either one is hydrated.
  const hydrated = hydrateImageAttachments(workspace, history, entries, "") as {
    workspace: { documents: { content: { bytes: readonly number[] } }[] };
    history: { blobs: Record<string, { bytes: readonly number[] }> };
  };
  assert.equal(
    hydrated.workspace.documents[0]!.content.bytes,
    Object.values(hydrated.history.blobs)[0]!.bytes,
  );
  const opened = readProjectContext(
    new TextEncoder().encode(
      JSON.stringify({
        format: "monotio.agi.project",
        version: 1,
        workspace,
        projectHistory: history,
      }),
    ),
    entries,
    "",
  );
  assert.deepEqual(opened.workspace?.documents[0]?.content, { type: "bytes", bytes: [17, 34, 51] });
  assert.deepEqual(Object.values(opened.projectHistory!.blobs)[0], {
    type: "bytes",
    bytes: [17, 34, 51],
  });
});

for (const field of ["workspace", "projectHistory"] as const) {
  test(`${field} total referenced bytes refuse before attachment expansion`, () => {
    const { workspace, history, entries } = fixture();
    // Three small physical payloads claim 64 MiB each, without allocating large fixtures.
    class DeclaredAttachment extends Uint8Array {
      override get length() {
        return 64 * 1024 * 1024;
      }
    }
    const hashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    for (const imageHash of hashes)
      entries.set(`ATTACHMENTS/${imageHash}.bin`.toUpperCase(), new DeclaredAttachment(1));
    const offered =
      field === "workspace"
        ? {
            ...workspace,
            documents: hashes.map((imageHash) => ({
              key: `attachment:${imageHash}`,
              content: { type: "attachment", hash: imageHash },
            })),
          }
        : {
            ...history,
            blobs: Object.fromEntries(
              hashes.map((imageHash) => [imageHash, { type: "attachment", hash: imageHash }]),
            ),
          };
    assert.throws(
      () =>
        readProjectContext(
          new TextEncoder().encode(
            JSON.stringify({
              format: "monotio.agi.project",
              version: 1,
              [field]: offered,
            }),
          ),
          entries,
          "",
        ),
      /payloads exceed the total/,
    );
  });
}

test("invalid History prevents expansion of an otherwise valid workspace", () => {
  const { workspace, history } = fixture();
  refuseBeforeExpansion(
    workspace,
    { ...history, tags: { bad: "0".repeat(64) } },
    /tag names a missing commit/,
  );
});

test("History attachment blob belongs to its named attachment document", () => {
  const { history } = fixture();
  const commit = history!.commits[0]!;
  const blob = Object.keys(history!.blobs)[0]!;
  refuseBeforeExpansion(
    undefined,
    { ...history, commits: [{ ...commit, documents: { "view:1": blob } }] },
    /image attachment must match/,
  );
});

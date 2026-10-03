import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "../src/crypto.ts";
import { ProjectModel } from "../src/authoring/projectModel.ts";

test("issued application preserves exact documents, deletion versions and before images", () => {
  const bytes = Uint8Array.of(1, 2);
  const model = new ProjectModel({
    documents: { "logic:1": "return;\r\n", "view:2": bytes },
    digest: sha256Hex,
  });
  const base = model.capture();
  bytes.fill(0);
  const proposal = model.propose(base, "Change room", [
    { key: "logic:1", content: "if (unfinished\ud800" },
    { key: "view:2", content: null },
  ]);
  const application = model.issueApplication(proposal);
  model.apply(application);
  assert.equal(base.read("logic:1")?.content, "return;\r\n");
  assert.deepEqual(base.read("view:2")?.content, Uint8Array.of(1, 2));
  assert.equal(model.capture().read("logic:1")?.content, "if (unfinished\ud800");
  assert.equal(model.capture().read("view:2"), undefined);
  assert.equal(model.capture().version("view:2"), base.version("view:2") + 1);
  assert.notEqual(model.capture().documentId, base.documentId);
  assert.throws(() => model.apply(application), /consumed|issued/);
});

test("foreign, forged and stale authority cannot change the model", () => {
  const model = new ProjectModel({ documents: { "logic:1": "return;" }, digest: sha256Hex });
  const other = new ProjectModel({ documents: { "logic:1": "return;" }, digest: sha256Hex });
  assert.throws(() => model.propose(other.capture(), "Foreign", []), /owned|foreign/);
  const base = model.capture();
  const old = model.propose(base, "Old", [{ key: "logic:1", content: "old" }]);
  const fresh = model.propose(base, "Fresh", [{ key: "logic:1", content: "fresh" }]);
  const stale = model.issueApplication(old);
  model.apply(model.issueApplication(fresh));
  assert.throws(() => model.apply(stale), /stale/);
  assert.throws(
    () => model.issueApplication(other.propose(other.capture(), "Foreign", [])),
    /issued|foreign/,
  );
  assert.throws(() => model.apply({ ...stale }), /issued/);
  assert.equal(model.capture().read("logic:1")?.content, "fresh");
});

test("no-op application keeps document identity and versions; buffers stay detached", () => {
  const model = new ProjectModel({ documents: { "view:1": Uint8Array.of(4) }, digest: sha256Hex });
  const base = model.capture();
  const proposal = model.propose(base, "Same", [{ key: "view:1", content: Uint8Array.of(4) }]);
  (proposal.documents()["view:1"] as Uint8Array).fill(9);
  model.apply(model.issueApplication(proposal));
  assert.equal(model.capture().revision, base.revision);
  assert.equal(model.capture().documentId, base.documentId);
  (model.capture().read("view:1")!.content as Uint8Array).fill(8);
  assert.deepEqual(model.capture().read("view:1")?.content, Uint8Array.of(4));
  assert.throws(
    () =>
      model.propose(model.capture(), "Duplicate", [
        { key: "view:1", content: null },
        { key: "view:1", content: "x" },
      ]),
    /duplicate/i,
  );
});

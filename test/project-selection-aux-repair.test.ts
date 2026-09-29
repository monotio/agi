import assert from "node:assert/strict";
import { test } from "node:test";
import { createContainer } from "../src/container/container.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import {
  compileProjectDocuments,
  ProjectDocumentCompileError,
} from "../src/authoring/projectDocuments.ts";
import { compileProjectSelection } from "../src/authoring/projectSelection.ts";
import { parseWordsTok } from "../src/logic/words.ts";

const profileId = "2.936" as const;
const view = JSON.stringify({
  loops: [{ cels: [{ width: 1, height: 1, transparentColor: 0, pixels: [1] }] }],
});

type Documents = Record<string, string | Uint8Array>;

function compileFiles(documents: Documents): Record<string, Uint8Array> {
  return Object.fromEntries(
    compileProjectDocuments({
      files: Object.fromEntries(createContainer().files),
      profileId,
      documents,
    }).files(),
  );
}

/** A WORDS.TOK image whose initial 'a' section offset points past end of file. */
function corruptWords(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  out[0] = 0x7f;
  out[1] = 0xff;
  return out;
}

/**
 * A kept project whose WORDS.TOK is corrupt in both the file image and the
 * kept words document, built from a valid compiled workspace.
 */
function corruptWordsWorkspace() {
  const kept: Documents = {
    "logic:0": "return;",
    "view:1": view,
    words: '[["look",1]]',
    bindings: "{}",
  };
  const files = compileFiles(kept);
  files["WORDS.TOK"] = corruptWords(files["WORDS.TOK"]!);
  const draft = new ProjectDraft({ ...kept, words: files["WORDS.TOK"]! });
  return { files, draft, profileId };
}

function edit(draft: ProjectDraft, key: string, content: string | Uint8Array | null) {
  draft.edit(key, content, draft.capture().version(key));
}

test("a corrupt kept WORDS.TOK pulls the available dirty words repair into an unrelated selection", () => {
  const input = corruptWordsWorkspace();
  edit(input.draft, "words", '[["open",100]]');
  edit(input.draft, "view:1", view.replace("[1]", "[2]"));
  const candidate = compileProjectSelection({ ...input, keys: ["view:1"] });
  assert.deepEqual(candidate.selection.keys, ["view:1", "words"]);
  assert.equal(candidate.compiled.documents()["words"], '[["open",100]]');
  const dictionary = new Map(
    parseWordsTok(candidate.compiled.files().get("WORDS.TOK")!).map(({ word, id }) => [word, id]),
  );
  assert.equal(dictionary.get("open"), 100);
  assert.equal(dictionary.get("look"), undefined);
  assert.deepEqual(candidate.references.diagnostics, []);
});

test("a corrupt kept WORDS.TOK without a draft repair is a typed words refusal", () => {
  const input = corruptWordsWorkspace();
  edit(input.draft, "view:1", view.replace("[1]", "[2]"));
  const expectWordsError = (error: unknown): boolean => {
    assert.ok(error instanceof ProjectDocumentCompileError);
    assert.equal(error.key, "words");
    assert.ok(error.cause instanceof Error);
    assert.match(error.cause.message, /past end of file/);
    return true;
  };
  assert.throws(() => compileProjectSelection({ ...input, keys: ["view:1"] }), expectWordsError);
  assert.throws(
    () =>
      compileProjectDocuments({
        files: input.files,
        profileId,
        documents: input.draft.select([]).documents(),
      }),
    expectWordsError,
  );
});

test("invalid authored words, inventory and bindings documents carry their document keys", () => {
  const documents: Documents = {
    "logic:0": "return;",
    "view:1": view,
    words: '[["look",1]]',
    inventory: "[]",
    bindings: "{}",
  };
  const files = compileFiles(documents);
  const cases: [key: string, content: string | Uint8Array][] = [
    ["words", "not json"],
    ["words", JSON.stringify([["", 1]])],
    ["words", Uint8Array.of(1, 2, 3)],
    ["inventory", "not json"],
    ["inventory", JSON.stringify([{ name: "lamp€", startingRoom: 1 }])],
    ["inventory", Uint8Array.of(1, 2, 3)],
    ["bindings", "{"],
    ["bindings", JSON.stringify({ "bad-name": { kind: "logic", num: 1 } })],
    ["bindings", JSON.stringify({ art: { kind: "logic", num: 300 } })],
    ["bindings", Uint8Array.of(1)],
  ];
  for (const [key, content] of cases) {
    assert.throws(
      () =>
        compileProjectDocuments({
          files,
          profileId,
          documents: { ...documents, [key]: content },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProjectDocumentCompileError, `${key}: ${String(error)}`);
        assert.equal(error.key, key);
        assert.ok(error.cause instanceof Error);
        return true;
      },
      `${key} document case ${String(content).slice(0, 40)}`,
    );
  }
});

test("resource compile failures keep their document identity and original cause", () => {
  const documents: Documents = {
    "logic:0": "return;",
    "view:1": view,
    words: '[["look",1]]',
    bindings: "{}",
  };
  const files = compileFiles(documents);
  const cases: [key: string, content: string | Uint8Array][] = [
    ["logic:0", "if (broken"],
    ["view:1", "{"],
    ["view:1", Uint8Array.of(1, 2, 3)],
  ];
  for (const [key, content] of cases) {
    assert.throws(
      () =>
        compileProjectDocuments({
          files,
          profileId,
          documents: { ...documents, [key]: content },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProjectDocumentCompileError, `${key}: ${String(error)}`);
        assert.equal(error.key, key);
        assert.ok(error.cause instanceof Error);
        assert.match(error.message, new RegExp(`Cannot compile ${key.replace(":", "\\:")}`));
        return true;
      },
      `${key} document case ${String(content).slice(0, 40)}`,
    );
  }
});

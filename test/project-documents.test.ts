import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { containerFromResources, openContainer } from "../src/container/container.ts";
import { ProjectDraft } from "../src/authoring/projectDraft.ts";
import {
  compileProjectDocuments,
  ProjectDocumentCompileError,
  readMusicDocument,
  readProjectDocuments,
} from "../src/authoring/projectDocuments.ts";
import { compileProjectLogic } from "../src/authoring/projectLogic.ts";
import { computeResourceRevision } from "../src/authoring/resourceRevision.ts";
import { createStarterProject, type StarterProject } from "../src/authoring/starterProject.ts";
import { disassembleLogic } from "../src/logic/disassembler.ts";
import { buildLogicResource } from "../src/logic/resource.ts";
import { buildWordsTok, parseWordsTok } from "../src/logic/words.ts";
import { compilePictureSource } from "../src/picture/source.ts";
import { PROFILES } from "../src/runtime/profile.ts";
import type { GameContainer, ResourceKind } from "../src/types.ts";

const PROFILE_ID = "2.936" as const;
const PROFILE = PROFILES[PROFILE_ID]!;

type Documents = Record<string, string | Uint8Array>;

function filesRecord(project: StarterProject): Record<string, Uint8Array> {
  return Object.fromEntries(project.files());
}

/** The authored claims a fresh project can prove against its own bytes. */
function claimedSources(project: StarterProject): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const [num, source] of project.sources.logics) sources[`logic:${num}`] = source;
  for (const [num, source] of project.sources.pictures) sources[`picture:${num}`] = source;
  for (const [num, input] of project.sources.views) sources[`view:${num}`] = JSON.stringify(input);
  for (const [num, tracks] of project.sources.sounds)
    sources[`sound:${num}`] = JSON.stringify(tracks);
  sources["words"] = JSON.stringify([...project.sources.words]);
  sources["inventory"] = JSON.stringify(project.sources.objects);
  return sources;
}

function readAll(project: StarterProject) {
  return readProjectDocuments({
    files: filesRecord(project),
    profileId: project.profileId,
    sources: claimedSources(project),
    bindings: project.bindings,
  });
}

function resourceNumbers(files: ReadonlyMap<string, Uint8Array>, kind: ResourceKind): number[] {
  const container = openContainer(files);
  const out: number[] = [];
  for (let num = 0; num < 256; num++) if (container.getResource(kind, num)) out.push(num);
  return out;
}

function assertFilesEqual(
  actual: ReadonlyMap<string, Uint8Array>,
  expected: ReadonlyMap<string, Uint8Array>,
): void {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [name, bytes] of expected) {
    assert.deepEqual([...actual.get(name)!], [...bytes], `${name} bytes differ`);
  }
}

function snapshot(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

// ---------- read ----------

describe("readProjectDocuments", () => {
  for (const kind of ["starter", "boilerplate", "blank"] as const) {
    test(`${kind}: verified sources hydrate every document; the image recompiles identically`, () => {
      const project = createStarterProject(kind);
      const read = readAll(project);
      assert.deepEqual(read.diagnostics, []);
      for (const [num, source] of project.sources.logics)
        assert.equal(read.documents[`logic:${num}`], source);
      for (const [num, source] of project.sources.pictures)
        assert.equal(read.documents[`picture:${num}`], source);
      for (const [num, input] of project.sources.views)
        assert.equal(read.documents[`view:${num}`], JSON.stringify(input));
      for (const [num, tracks] of project.sources.sounds)
        assert.equal(read.documents[`sound:${num}`], JSON.stringify(tracks));
      assert.equal(read.documents["words"], JSON.stringify([...project.sources.words]));
      assert.equal(read.documents["inventory"], JSON.stringify(project.sources.objects));
      const bindings = JSON.parse(read.documents["bindings"] as string) as Record<
        string,
        { kind: string; num: number }
      >;
      for (const [name, binding] of Object.entries(project.bindings))
        assert.deepEqual(bindings[name], binding);

      const compiled = compileProjectDocuments({
        files: filesRecord(project),
        profileId: project.profileId,
        documents: read.documents,
      });
      assert.equal(compiled.build.identity.revision, project.seed.digest);
      assertFilesEqual(compiled.files(), project.files());
    });
  }

  test("every indexed resource and auxiliary file is populated as detached bytes", () => {
    const project = createStarterProject("boilerplate");
    const read = readProjectDocuments({
      files: filesRecord(project),
      profileId: project.profileId,
      bindings: project.bindings,
    });
    assert.deepEqual(Object.keys(read.documents).sort(), [
      "bindings",
      "inventory",
      "logic:0",
      "logic:1",
      "logic:255",
      "picture:1",
      "sound:255",
      "words",
    ]);
    const container = openContainer(project.files());
    for (const key of [
      "logic:0",
      "logic:1",
      "logic:255",
      "picture:1",
      "sound:255",
      "words",
      "inventory",
    ]) {
      const doc = read.documents[key]!;
      assert.ok(doc instanceof Uint8Array, `${key} should be native bytes`);
      const [kind, num] = key.split(":") as [ResourceKind | string, string?];
      const stored =
        key === "words"
          ? container.files.get("WORDS.TOK")!
          : key === "inventory"
            ? container.files.get("OBJECT")!
            : container.getResource(kind as ResourceKind, Number(num))!;
      assert.deepEqual([...doc], [...stored]);
      doc[0] = (doc[0]! + 1) & 0xff;
      assert.notDeepEqual([...doc], [...stored], `${key} bytes are detached`);
    }
    const bindings = JSON.parse(read.documents["bindings"] as string);
    for (const [name, binding] of Object.entries(project.bindings))
      assert.deepEqual(bindings[name], binding);
    assert.equal(
      readProjectDocuments({
        files: filesRecord(project),
        profileId: project.profileId,
      }).documents["bindings"],
      "{}",
    );
  });

  test("claimed sources that do not compile or do not reproduce stay byte-only", () => {
    const project = createStarterProject("boilerplate");
    const read = readProjectDocuments({
      files: filesRecord(project),
      profileId: project.profileId,
      sources: {
        "logic:1": "if (unterminated",
        "picture:1": "vis 14\nfill 10,10\nend\n",
        "view:4": '{"loops":[]}',
      },
      bindings: project.bindings,
    });
    assert.ok(read.documents["logic:1"] instanceof Uint8Array);
    assert.ok(read.documents["picture:1"] instanceof Uint8Array);
    assert.deepEqual(read.diagnostics.map(({ key }) => key).sort(), [
      "logic:1",
      "picture:1",
      "view:4",
    ]);
  });

  test("a claimed source for an absent resource is an orphan, never recreated", () => {
    const project = createStarterProject("blank");
    const read = readProjectDocuments({
      files: filesRecord(project),
      profileId: project.profileId,
      sources: { "logic:9": "return;" },
      bindings: project.bindings,
    });
    assert.equal(read.documents["logic:9"], undefined);
    assert.deepEqual(
      read.diagnostics.map(({ key }) => key),
      ["logic:9"],
    );
  });

  test("conflicting file-name aliases are rejected", () => {
    assert.throws(
      () =>
        readProjectDocuments({
          files: { "vol.0": new Uint8Array(), "VOL.0": new Uint8Array() },
          profileId: PROFILE_ID,
        }),
      /duplicate/i,
    );
  });
});

// ---------- compile ----------

describe("compileProjectDocuments", () => {
  test("a selected picture edit builds while an unrelated broken logic draft stays out", () => {
    const project = createStarterProject("boilerplate");
    const files = filesRecord(project);
    const read = readAll(project);
    const draft = new ProjectDraft(read.documents);
    const painted = "vis 14\nfill 10,10\nend\n";
    draft.apply(
      draft.propose(draft.capture(), "Paint the clearing", [
        { key: "picture:1", content: painted },
      ]),
    );
    draft.edit("logic:1", "if (broken", draft.capture().version("logic:1"));
    const documents = draft.select(["picture:1"]).documents();
    const result = compileProjectDocuments({ files, profileId: PROFILE_ID, documents });
    const container = openContainer(result.files());
    assert.deepEqual(
      [...container.getResource("picture", 1)!],
      [...compilePictureSource(painted, { profile: PROFILE }).bytes],
    );
    assert.notEqual(result.build.identity.revision, project.seed.digest);
    const disassembled = disassembleLogic(container.getResource("logic", 1)!, {
      profile: PROFILE,
    });
    assert.match(disassembled, /load\.pic\(v50\)/, "the kept room logic still compiles");
  });

  test("coordinated vocabulary and logic documents recompile said() ids", () => {
    const project = createStarterProject("starter");
    const files = filesRecord(project);
    const read = readAll(project);
    const documents: Documents = { ...read.documents };
    const words = JSON.parse(documents["words"] as string) as [string, number][];
    words.push(["shout", 200]);
    documents["words"] = JSON.stringify(words);
    documents["logic:1"] = `${documents["logic:1"] as string}\nif (said("shout")) { print(m2); }\n`;
    const result = compileProjectDocuments({ files, profileId: PROFILE_ID, documents });
    const out = result.files();
    const dictionary = new Map(
      parseWordsTok(out.get("WORDS.TOK")!).map(({ word, id }) => [word, id]),
    );
    assert.equal(dictionary.get("shout"), 200);
    const text = disassembleLogic(openContainer(out).getResource("logic", 1)!, {
      profile: PROFILE,
      dictionary,
    });
    assert.match(text, /said\("shout"\)/);
    assert.notEqual(result.build.identity.revision, project.seed.digest);
  });

  test("a comment-only source change moves the build identity, not the resource revision", () => {
    const project = createStarterProject("boilerplate");
    const files = filesRecord(project);
    const read = readAll(project);
    const base = compileProjectDocuments({
      files,
      profileId: PROFILE_ID,
      documents: read.documents,
    });
    const commented: Documents = {
      ...read.documents,
      "logic:1": `// a remark with no bytes\n${read.documents["logic:1"] as string}`,
    };
    const moved = compileProjectDocuments({
      files,
      profileId: PROFILE_ID,
      documents: commented,
    });
    assert.notEqual(moved.build.identity.buildId, base.build.identity.buildId);
    assert.equal(moved.build.identity.revision, base.build.identity.revision);
    assertFilesEqual(moved.files(), base.files());
  });

  test("absence of an indexed document deletes the directory entry", () => {
    const project = createStarterProject("boilerplate");
    const read = readAll(project);
    const documents: Documents = { ...read.documents };
    delete documents["logic:1"];
    const result = compileProjectDocuments({
      files: filesRecord(project),
      profileId: PROFILE_ID,
      documents,
    });
    const container = openContainer(result.files());
    assert.equal(container.getResource("logic", 1), null);
    assert.deepEqual(resourceNumbers(result.files(), "logic"), [0, 255]);
    assert.deepEqual([...result.files().get("LOGDIR")!.subarray(3, 6)], [0xff, 0xff, 0xff]);
  });

  test("a failed compile leaves input files and documents untouched", () => {
    const project = createStarterProject("blank");
    const files = filesRecord(project);
    const documents: Documents = { ...readAll(project).documents, "logic:0": "if (nope" };
    const beforeFiles = snapshot(files);
    const beforeDocuments = snapshot(documents);
    assert.throws(() => compileProjectDocuments({ files, profileId: PROFILE_ID, documents }));
    assert.deepEqual(files, beforeFiles);
    assert.deepEqual(documents, beforeDocuments);
  });

  test("returned files and documents are detached from the caller's buffers", () => {
    const project = createStarterProject("starter");
    const documents: Documents = { ...readAll(project).documents };
    // Swap the authored view text for the caller's own byte buffer.
    const viewBytes = openContainer(project.files()).getResource("view", 0)!;
    const callerOwned = new Uint8Array(viewBytes);
    documents["view:0"] = callerOwned;
    const result = compileProjectDocuments({
      files: filesRecord(project),
      profileId: PROFILE_ID,
      documents,
    });
    const exposed = result.files();
    exposed.get("VOL.0")!.fill(0xaa);
    exposed.get("LOGDIR")!.fill(0);
    assertFilesEqual(result.files(), project.files());
    // Mutating the caller's document bytes after the call changes nothing stored.
    callerOwned.fill(0);
    const docs = result.documents();
    assert.equal(docs["logic:1"], project.sources.logics.get(1));
    assert.deepEqual([...(docs["view:0"] as Uint8Array)], [...viewBytes]);
  });

  test("an imported byte-only logic round-trips; changed opaque bytes must decode cleanly", () => {
    const payload = compileProjectLogic("return;", {
      profile: PROFILE,
      dictionary: new Map(),
      bindings: {},
    }).assembly.payload;
    const container: GameContainer = containerFromResources({
      logic: new Map([[5, payload]]),
    });
    container.putFile("WORDS.TOK", buildWordsTok([]));
    const files = Object.fromEntries(container.files);
    const read = readProjectDocuments({ files, profileId: PROFILE_ID, bindings: {} });
    const logic = read.documents["logic:5"];
    assert.ok(logic instanceof Uint8Array);
    assert.deepEqual([...logic], [...payload]);

    const result = compileProjectDocuments({
      files,
      profileId: PROFILE_ID,
      documents: read.documents,
    });
    assert.equal(result.build.identity.revision, computeResourceRevision(files));
    assert.deepEqual([...openContainer(result.files()).getResource("logic", 5)!], [...payload]);

    // An indexed payload that cannot decode is preserved only while untouched.
    const opaque = buildLogicResource(Uint8Array.of(0xc8, 0x00), []);
    const imported = containerFromResources({ logic: new Map([[7, opaque]]) });
    imported.putFile("WORDS.TOK", buildWordsTok([]));
    const importedFiles = Object.fromEntries(imported.files);
    const importedRead = readProjectDocuments({
      files: importedFiles,
      profileId: PROFILE_ID,
      bindings: {},
    });
    assert.ok(importedRead.documents["logic:7"] instanceof Uint8Array);
    compileProjectDocuments({
      files: importedFiles,
      profileId: PROFILE_ID,
      documents: importedRead.documents,
    });
    const stillBad = buildLogicResource(Uint8Array.of(0x00, 0xc8), []);
    assert.throws(
      () =>
        compileProjectDocuments({
          files: importedFiles,
          profileId: PROFILE_ID,
          documents: { ...importedRead.documents, "logic:7": stillBad },
        }),
      /logic:7/i,
    );
  });

  test("non-resource playable files ride through untouched", () => {
    const project = createStarterProject("blank");
    const files = filesRecord(project);
    files["AGIDATA.OVL"] = new Uint8Array([1, 2, 3]);
    files["KQ2.COM"] = new Uint8Array([4, 5]);
    const result = compileProjectDocuments({
      files,
      profileId: PROFILE_ID,
      documents: readAll(project).documents,
    });
    const out = result.files();
    assert.deepEqual([...out.get("AGIDATA.OVL")!], [1, 2, 3]);
    assert.deepEqual([...out.get("KQ2.COM")!], [4, 5]);
    assert.equal(result.build.identity.profileId, PROFILE_ID);
  });

  test("metadata documents are carried detached and never become files", () => {
    const project = createStarterProject("blank");
    const documents: Documents = {
      ...readAll(project).documents,
      world: JSON.stringify({ rooms: { "1": { title: "Start" } } }),
      tests: "[]",
      references: new Uint8Array([9, 9]),
    };
    const result = compileProjectDocuments({
      files: filesRecord(project),
      profileId: PROFILE_ID,
      documents,
    });
    assert.equal(result.documents()["world"], documents["world"]);
    assert.deepEqual([...(result.documents()["references"] as Uint8Array)], [9, 9]);
    assert.equal(result.files().has("TESTS.JSON"), false);
    assertFilesEqual(result.files(), project.files());
  });

  test("unknown document keys and malformed document bodies are rejected", () => {
    const project = createStarterProject("boilerplate");
    const files = filesRecord(project);
    const documents = readAll(project).documents;
    for (const bad of [
      { "logic:300": "return;" },
      { "PIC:1": "end" },
      { misc: "x" },
      { words: "not json" },
      { inventory: JSON.stringify([{ name: "lamp", startingRoom: 300 }]) },
      { inventory: JSON.stringify([{ name: "lamp€", startingRoom: 1 }]) },
      { bindings: JSON.stringify({ bad_name: { kind: "logic", num: 1 } }) },
    ]) {
      assert.throws(
        () =>
          compileProjectDocuments({
            files,
            profileId: PROFILE_ID,
            documents: { ...documents, ...bad },
          }),
        Error,
        JSON.stringify(Object.keys(bad)),
      );
    }
  });

  test("the music document compiles through the authoring schema and preserves exact text", () => {
    const project = createStarterProject("blank");
    const files = filesRecord(project);
    const documents = { ...readAll(project).documents };
    const music = '{"9":{"revision":"21-abcdef12","tempo":120}}';
    const result = compileProjectDocuments({
      files,
      profileId: PROFILE_ID,
      documents: { ...documents, music },
    });
    assert.equal(result.documents()["music"], music);
    assertFilesEqual(result.files(), project.files());
  });

  test("malformed music documents refuse with a scoped diagnostic and leave input untouched", () => {
    const project = createStarterProject("blank");
    const files = filesRecord(project);
    const documents = { ...readAll(project).documents };
    for (const music of [
      Uint8Array.of(1),
      "not json",
      '{"9":{"revision":"bogus","tempo":120}}',
      '{"9":{"revision":"21-abcdef12","tempo":5}}',
      '{"9":{"revision":"21-abcdef12","tempo":120,"extra":true}}',
      '{"x":{"revision":"21-abcdef12","tempo":120}}',
    ]) {
      const before = { ...documents, music: music as string };
      assert.throws(
        () =>
          compileProjectDocuments({
            files,
            profileId: PROFILE_ID,
            documents: before,
          }),
        (error: unknown) => {
          assert.ok(error instanceof ProjectDocumentCompileError);
          assert.equal(error.key, "music");
          return true;
        },
        JSON.stringify(music),
      );
    }
    assert.deepEqual(documents["music"], undefined);
    assert.deepEqual(readMusicDocument("{}"), {});
    const parsed = readMusicDocument('{"9":{"revision":"21-abcdef12","tempo":120}}');
    assert.deepEqual(parsed, { "9": { revision: "21-abcdef12", tempo: 120 } });
  });
});

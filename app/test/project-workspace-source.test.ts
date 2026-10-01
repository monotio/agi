import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createAuthoringState } from "../../src/authoring/authoringState.ts";
import { buildObjectFile } from "../../src/authoring/inventory.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { compileProjectLogic } from "../../src/authoring/projectLogic.ts";
import { createStarterProject, type StarterKind } from "../../src/authoring/starterProject.ts";
import {
  writeProjectWorkspace,
  type PortableProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import { containerFromResources, openContainer } from "../../src/container/container.ts";
import { requireResourceRevision } from "../../src/gameIdentity.ts";
import { buildWordsTok } from "../../src/logic/words.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import type { ResourceKind } from "../../src/types.ts";
import type { CachedGameData } from "../src/project/gameTypes.ts";
import { prepareLocalProject } from "../src/project/localProject.ts";
import { inspectEditableProject } from "../src/project/projectWorkspaceSource.ts";
import { testProjectId, testRevision } from "./identity.ts";

const AUTHORED_AT = "2026-09-29T00:00:00.000Z";
const PROFILE = PROFILES["2.936"]!;

/** A new manual project's stored body: workspace claims plus legacy sources. */
function manualProject(kind: StarterKind): CachedGameData {
  const candidate = prepareLocalProject({ title: `Manual ${kind}`, kind });
  return { projectId: candidate.projectId, authoredAt: AUTHORED_AT, ...candidate.data() };
}

/** A v1 source-bearing body: legacy authoring state, no workspace envelope. */
function legacyProject(kind: StarterKind): CachedGameData {
  const seed = createStarterProject(kind);
  const authoring = createAuthoringState();
  authoring.bindings = { ...seed.bindings };
  return {
    projectId: testProjectId(`legacy-${kind}`),
    title: `Legacy ${kind}`,
    authoredAt: AUTHORED_AT,
    files: Object.fromEntries(seed.files()),
    words: [...seed.sources.words],
    authoringState: {
      authoring,
      sources: {
        logics: [...seed.sources.logics],
        pictures: [...seed.sources.pictures],
        views: [...seed.sources.views],
        sounds: [...seed.sources.sounds],
      },
    },
    library: {
      version: 1,
      revision: requireResourceRevision(seed.seed.digest),
      source: "authored",
      profile: seed.profileId,
      validation: { status: "unverified", message: "Opening not checked yet." },
    },
  };
}

/** An ordinary imported game: native files only, no authoring records. */
function importedGame(): CachedGameData {
  const payload = compileProjectLogic("return;", {
    profile: PROFILE,
    dictionary: new Map(),
    bindings: {},
  }).assembly.payload;
  const container = containerFromResources({ logic: new Map([[0, payload]]) });
  container.putFile("WORDS.TOK", buildWordsTok([]));
  container.putFile("OBJECT", buildObjectFile([], PROFILE));
  return {
    projectId: testProjectId("imported-native"),
    title: "Imported game",
    authoredAt: AUTHORED_AT,
    files: Object.fromEntries(container.files),
    words: [],
    imported: true,
  };
}

function nativePayload(data: CachedGameData, kind: ResourceKind, num: number): Uint8Array {
  return openContainer(new Map(Object.entries(data.files))).getResource(kind, num)!;
}

function workspaceWith(
  data: CachedGameData,
  documents: Record<string, string | Uint8Array>,
): CachedGameData {
  return { ...data, workspace: writeProjectWorkspace(documents) };
}

describe("inspectEditableProject", () => {
  for (const kind of ["boilerplate", "starter"] as const) {
    test(`manual ${kind} workspace source survives an exact inspection`, () => {
      const data = manualProject(kind);
      const inspection = inspectEditableProject(data);
      assert.equal(inspection.profileId, "2.936");
      assert.equal(inspection.requiresSourceReview, false);
      assert.deepEqual(inspection.diagnostics, []);
      assert.deepEqual(inspection.rejectedSources, {});
      const documents = compileProjectDocuments({
        files: data.files,
        profileId: inspection.profileId,
        documents: inspection.documents,
      });
      for (const entry of data.workspace!.documents) {
        const held = inspection.documents[entry.key];
        if (entry.content.type === "text") assert.equal(held, entry.content.text, entry.key);
        else assert.deepEqual([...(held as Uint8Array)], [...entry.content.bytes], entry.key);
      }
      const seed = createStarterProject(kind);
      for (const [num, source] of seed.sources.logics)
        assert.equal(inspection.documents[`logic:${num}`], source);
      for (const [num, source] of seed.sources.pictures)
        assert.equal(inspection.documents[`picture:${num}`], source);
      assert.equal(documents.build.identity.revision, seed.seed.digest);
    });
  }

  test("legacy comments and binding names survive a matching-byte v1 inspection", () => {
    const data = legacyProject("starter");
    const sources = data.authoringState!["sources"] as Record<string, unknown>;
    // A leading comment changes no compiled bytes: the claim is still provable.
    const seed = createStarterProject("starter");
    const original = seed.sources.logics.get(1)!;
    const withComment = `// Kept authoring remark.\n${original}`;
    sources["logics"] = [...(sources["logics"] as [number, string][])].map((entry) =>
      entry[0] === 1 ? [entry[0], withComment] : entry,
    );
    const inspection = inspectEditableProject(data);
    assert.equal(inspection.documents["logic:1"], withComment);
    assert.equal(inspection.requiresSourceReview, false);
    const bindings = JSON.parse(inspection.documents["bindings"] as string);
    assert.deepEqual(bindings["death_logic"], { kind: "logic", num: 255 });
    assert.deepEqual(bindings["ego_view"], { kind: "view", num: 0 });
  });

  test("an imported native game reads as a byte-only inventory", () => {
    const data = importedGame();
    const inspection = inspectEditableProject(data);
    assert.equal(inspection.profileId, "2.936");
    assert.ok(inspection.documents["logic:0"] instanceof Uint8Array);
    assert.ok(inspection.documents["words"] instanceof Uint8Array);
    assert.ok(inspection.documents["inventory"] instanceof Uint8Array);
    assert.equal(inspection.documents["bindings"], "{}");
    assert.equal(inspection.requiresSourceReview, false);
    assert.deepEqual(inspection.rejectedSources, {});
    assert.deepEqual(inspection.diagnostics, []);
  });

  test("a stale or malformed legacy claim is set aside with the byte inventory and input intact", () => {
    const data = legacyProject("boilerplate");
    const sources = data.authoringState!["sources"] as Record<string, unknown>;
    sources["logics"] = [
      [0, "if (unterminated"],
      [9, "return;"],
      ["room", "return;"],
    ];
    const before = structuredClone(data);
    const inspection = inspectEditableProject(data);
    assert.equal(inspection.requiresSourceReview, true);
    // The playable bytes stay authoritative; refused claims are preserved verbatim.
    assert.deepEqual(
      [...(inspection.documents["logic:0"] as Uint8Array)],
      [...nativePayload(data, "logic", 0)],
    );
    assert.equal(inspection.rejectedSources["logic:0"], "if (unterminated");
    assert.equal(inspection.rejectedSources["logic:9"], "return;");
    assert.notEqual(inspection.rejectedSources["sources.logics[2]"], undefined);
    assert.deepEqual(inspection.diagnostics.map(({ key }) => key).sort(), [
      "logic:0",
      "logic:9",
      "sources.logics[2]",
    ]);
    // Inspection changed nothing: the raw input stays the preservation authority.
    assert.deepEqual(data, before);
  });

  test("malformed legacy structures are set aside visibly, not repaired", () => {
    const data = legacyProject("boilerplate");
    const sources = data.authoringState!["sources"] as Record<string, unknown>;
    sources["pictures"] = "not an array";
    sources["views"] = [[7, { loops: [] }]];
    const inspection = inspectEditableProject(data);
    assert.equal(inspection.requiresSourceReview, true);
    assert.equal(inspection.rejectedSources["sources.pictures"], "not an array");
    assert.equal(inspection.documents["view:7"], undefined);
    // A well-formed builder claim for an absent VIEW is still an orphan claim.
    assert.equal(inspection.rejectedSources["view:7"], JSON.stringify({ loops: [] }));
    assert.deepEqual(
      inspection.diagnostics.map(({ key }) => key),
      ["sources.pictures", "view:7"],
    );
  });

  test("an unknown workspace version refuses rather than downgrades", () => {
    const data = {
      ...manualProject("boilerplate"),
      workspace: {
        format: "monotio.agi.project-workspace",
        version: 999,
        documents: [],
      } as unknown as PortableProjectWorkspace,
    };
    assert.throws(() => inspectEditableProject(data), /workspace version/i);
  });

  test("malformed binding contexts refuse instead of fabricating an empty context", () => {
    const data = manualProject("boilerplate");
    const badJson = workspaceWith(data, { bindings: "{not json" });
    assert.throws(() => inspectEditableProject(badJson), /bindings/i);
    const badSchema = workspaceWith(data, {
      bindings: JSON.stringify({ Bad_Name: { kind: "logic", num: 0 } }),
    });
    assert.throws(() => inspectEditableProject(badSchema), /bindings/i);
    const byteContext = workspaceWith(data, { bindings: new Uint8Array([123, 125]) });
    assert.throws(() => inspectEditableProject(byteContext), /bindings/i);

    const legacy = legacyProject("boilerplate");
    legacy.authoringState!["authoring"] = { version: 1, bindings: "garbage" };
    assert.throws(() => inspectEditableProject(legacy), /bindings|authoring/i);
  });

  test("a source claim for a missing resource is preserved, never invented", () => {
    const data = workspaceWith(manualProject("boilerplate"), { "logic:9": "return;" });
    const inspection = inspectEditableProject(data);
    assert.equal(inspection.documents["logic:9"], undefined);
    assert.equal(inspection.rejectedSources["logic:9"], "return;");
    assert.equal(inspection.requiresSourceReview, true);
    assert.ok(inspection.diagnostics.some(({ key }) => key === "logic:9"));
  });

  test("a mismatching byte claim cannot replace the native payload", () => {
    const data = manualProject("boilerplate");
    const claimed = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const tampered = workspaceWith(data, {
      "logic:1": claimed,
      "logic:0": nativePayload(data, "logic", 0),
    });
    const before = structuredClone(tampered);
    const inspection = inspectEditableProject(tampered);
    assert.deepEqual(
      [...(inspection.documents["logic:1"] as Uint8Array)],
      [...nativePayload(tampered, "logic", 1)],
    );
    assert.deepEqual([...(inspection.rejectedSources["logic:1"] as Uint8Array)], [...claimed]);
    assert.ok(inspection.diagnostics.some(({ key }) => key === "logic:1"));
    assert.equal(inspection.requiresSourceReview, true);
    // A byte claim equal to the native payload stays an ordinary byte document.
    assert.deepEqual(
      [...(inspection.documents["logic:0"] as Uint8Array)],
      [...nativePayload(tampered, "logic", 0)],
    );
    assert.equal(inspection.rejectedSources["logic:0"], undefined);
    assert.deepEqual(tampered, before);
  });

  test("workspace entries absent from the envelope do not delete resources", () => {
    const data = workspaceWith(manualProject("boilerplate"), { "logic:0": "return;" });
    const inspection = inspectEditableProject(data);
    // logic:0's claim is stale (the claimed text does not rebuild the bytes)…
    assert.equal(inspection.rejectedSources["logic:0"], "return;");
    // …and logic:1 was never claimed at all, yet its bytes are still listed.
    assert.deepEqual(
      [...(inspection.documents["logic:1"] as Uint8Array)],
      [...nativePayload(data, "logic", 1)],
    );
    assert.deepEqual(
      [...(inspection.documents["picture:1"] as Uint8Array)],
      [...nativePayload(data, "picture", 1)],
    );
  });

  test("a refused workspace claim is never replaced by duplicate legacy text", () => {
    const base = manualProject("boilerplate");
    const legacySources = base.authoringState!["sources"] as Record<string, unknown>;
    // The stored legacy text still compiles to the bytes…
    const good = (legacySources["logics"] as [number, string][]).find(
      (entry) => entry[0] === 1,
    )![1];
    const data = workspaceWith(base, { "logic:1": "// newer but refused claim\nif (" });
    const inspection = inspectEditableProject(data);
    assert.equal(inspection.rejectedSources["logic:1"], "// newer but refused claim\nif (");
    assert.notEqual(inspection.documents["logic:1"], good);
    assert.ok(inspection.documents["logic:1"] instanceof Uint8Array);
    assert.equal(inspection.requiresSourceReview, true);
  });

  test("the selected interpreter profile override is respected", () => {
    const data = importedGame();
    data.library = {
      version: 1,
      revision: testRevision("override"),
      source: "zip",
      profile: "2.089",
      validation: { status: "unverified", message: "Opening not checked yet." },
    };
    assert.equal(inspectEditableProject(data).profileId, "2.089");
    assert.equal(inspectEditableProject({ ...data, library: undefined }).profileId, "2.936");
  });

  test("valid workspace binding text is preserved exactly, metadata detached", () => {
    const data = manualProject("boilerplate");
    const bindingText =
      '{ "zzz_flag": { "kind": "flag", "num": 1 }, "boot_logic": { "kind": "logic", "num": 0 } }';
    const worldText = '{ "rooms": { "1": { "title": "Start" } }, "facts": {}, "quests": {} }';
    const referenceBytes = new Uint8Array([9, 8, 7]);
    const wsData = workspaceWith(data, {
      bindings: bindingText,
      world: worldText,
      tests: "[]",
      references: referenceBytes,
    });
    const inspection = inspectEditableProject(wsData);
    assert.equal(inspection.documents["bindings"], bindingText);
    assert.equal(inspection.documents["world"], worldText);
    assert.equal(inspection.documents["tests"], "[]");
    const held = inspection.documents["references"] as Uint8Array;
    assert.deepEqual([...held], [9, 8, 7]);
    assert.notEqual(held.buffer, referenceBytes.buffer);
    held.fill(0);
    assert.deepEqual([...referenceBytes], [9, 8, 7]);
    assert.equal(inspection.requiresSourceReview, false);
  });

  test("legacy world intent is preserved when no workspace carries it", () => {
    const data = legacyProject("boilerplate");
    const authoring = data.authoringState!["authoring"] as {
      world: { rooms: Record<string, unknown> };
    };
    authoring.world.rooms["1"] = {
      title: "Empty room",
      description: "A placeholder.",
      exits: { north: 2 },
    };
    const inspection = inspectEditableProject(data);
    const world = JSON.parse(inspection.documents["world"] as string) as {
      rooms: Record<string, { title: string }>;
    };
    assert.equal(world.rooms["1"]!.title, "Empty room");
  });

  test("a workspace music document is carried strictly and legacy music hydrates when absent", () => {
    const tempo = '{"9":{"revision":"21-abcdef12","tempo":120}}';
    const inspection = inspectEditableProject(
      workspaceWith(manualProject("boilerplate"), { music: tempo }),
    );
    assert.equal(inspection.documents["music"], tempo, "exact workspace text preserved");
    assert.equal(inspection.rejectedSources["music"], undefined);

    const malformed = inspectEditableProject(
      workspaceWith(manualProject("boilerplate"), { music: "{not json" }),
    );
    assert.equal(malformed.documents["music"], undefined);
    assert.equal(malformed.rejectedSources["music"], "{not json");
    assert.equal(malformed.requiresSourceReview, true);
    assert.ok(malformed.diagnostics.some(({ key }) => key === "music"));

    const legacy = legacyProject("boilerplate");
    (legacy.authoringState!["authoring"] as { music?: Record<string, unknown> }).music = {
      "9": { revision: "21-abcdef12", tempo: 90 },
    };
    const hydrated = inspectEditableProject(legacy);
    assert.equal(
      hydrated.documents["music"],
      JSON.stringify({ "9": { revision: "21-abcdef12", tempo: 90 } }),
    );
    assert.equal(hydrated.requiresSourceReview, false);
  });

  test("inspection outputs are detached from the stored body", () => {
    const data = importedGame();
    const before = structuredClone(data);
    const native = [...nativePayload(data, "logic", 0)];
    const inspection = inspectEditableProject(data);
    // The read left the stored body untouched.
    assert.deepEqual(data, before);
    const bytes = inspection.documents["logic:0"] as Uint8Array;
    assert.deepEqual([...bytes], native);
    // Mutating a returned document never reaches back into storage.
    bytes.fill(0xaa);
    const again = inspectEditableProject(data);
    assert.deepEqual([...(again.documents["logic:0"] as Uint8Array)], native);
    assert.equal(
      (inspection.documents["logic:0"] as Uint8Array).buffer ===
        (again.documents["logic:0"] as Uint8Array).buffer,
      false,
    );
    assert.equal(inspection.documents === again.documents, false);
    assert.throws(() => {
      (inspection as { documents: Record<string, unknown> }).documents["logic:0"] = "x";
    });
  });
});

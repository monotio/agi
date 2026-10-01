import { test } from "node:test";
import assert from "node:assert/strict";
import { openProjectSession } from "../src/project/projectSession.ts";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import {
  writeProjectWorkspace,
  readProjectWorkspace,
} from "../../src/authoring/projectWorkspace.ts";
import { readProjectHistory } from "../../src/authoring/projectHistoryCodec.ts";
import {
  traceImageChanges,
  makeCelsChanges,
  suggestImageFrames,
} from "../../src/creative/imageOperations.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { PROFILES } from "../../src/runtime/profile.ts";
import { buildView, parseView } from "../../src/view/view.ts";
import { encodePngRgba } from "../../src/creative/composite.ts";
import {
  buildProjectZip,
  buildPublicGameZip,
  collectProjectArchiveEntries,
} from "../src/archive/projectArchive.ts";
import { buildZip } from "../src/archive/zip.ts";
import { readGameZip } from "../src/archive/gameZip.ts";
import { commitProject, loadAuthoredGame } from "../src/project/gameStorage.ts";
import { installIndexedDbFixture } from "./indexedDbFixture.ts";
import { testProjectId } from "./identity.ts";
const rows = installIndexedDbFixture();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
const rgba = new Uint8Array(8 * 2 * 4).fill(255);
const image = {
  title: "Walk",
  mime: "image/png",
  encoded: encodePngRgba(8, 2, rgba),
  width: 8,
  height: 2,
  rgba,
};
test("attachments autosave in History, undo/redo and private archives; public exports contain native art", async () => {
  const projectId = testProjectId("image-history");
  const documents = {
    "logic:0": "return;",
    words: "[]",
    "picture:1": Uint8Array.of(255),
    "view:0": buildView({ loops: [{ cels: [{ width: 1, height: 1, pixels: [2] }] }] }),
  };
  const compiled = compileProjectDocuments({
    documents,
    files: Object.fromEntries(createContainer().files),
    profileId: "2.936",
  });
  const initial = await commitProject({
    projectId,
    workspaceId: "start",
    commitId: "start",
    expected: null,
    buildId: compiled.build.identity.buildId,
    documents: [],
    data: {
      title: "Images",
      files: Object.fromEntries(compiled.files()),
      words: [],
      workspace: writeProjectWorkspace(documents),
    },
  });
  const data = (await loadAuthoredGame(projectId))!;
  const session = openProjectSession({
    data,
    lifetime: initial.receipt.saved.lifetime,
    admission: {
      runToken: "images",
      admit: async () => ({
        status: "committed",
        expected: null,
        current: null,
        patchGeneration: 1,
      }),
    },
  });
  const submit = (
    changes: Parameters<typeof session.model.propose>[2],
    label: string,
    origin: "picture" | "view",
  ) =>
    session.submit({
      proposal: session.model.propose(session.model.capture(), label, changes),
      label,
      origin,
      author: "creator",
    });
  await submit(
    traceImageChanges(session.model.capture().documents(), "picture:1", image),
    "Trace an image",
    "picture",
  );
  assert.equal(session.history.capture().commits.length, 2);
  await session.flush();
  const encoded = sha256Hex(image.encoded);
  const matching = [...rows.values()].filter((value) => {
    const row = value as { format?: string; content?: unknown };
    return (
      row.format === "monotio.agi.project-history-blob" &&
      row.content instanceof Uint8Array &&
      sha256Hex(row.content) === encoded
    );
  });
  assert.equal(matching.length, 1);
  await session.undo();
  assert.equal(session.model.capture().read("images"), undefined);
  await session.redo();
  assert.ok(session.model.capture().read(`attachment:${encoded}`));
  await submit(
    makeCelsChanges(
      session.model.capture().documents(),
      "view:0",
      image,
      suggestImageFrames(image, 4),
      PROFILES["2.936"],
    ),
    "Make cels from an image",
    "view",
  );
  assert.equal(session.history.capture().commits.length, 3);
  assert.equal(
    parseView(session.model.capture().read("view:0")!.content as Uint8Array).loops[0]!.cels.length,
    5,
  );
  await session.flush();
  const saved = (await loadAuthoredGame(projectId))!;
  const entries = await collectProjectArchiveEntries(saved);
  assert.equal(entries.filter((entry) => entry.name === `ATTACHMENTS/${encoded}.bin`).length, 1);
  const projectEntry = JSON.parse(
    entries.find((entry) => entry.name === "PROJECT.JSON")!.data as string,
  );
  assert.equal(projectEntry.version, 1);
  await assert.rejects(
    readGameZip(buildZip(entries.filter((entry) => entry.name !== `ATTACHMENTS/${encoded}.bin`))),
    /attachment/,
  );
  const corrupt = entries.map((entry) =>
    entry.name === `ATTACHMENTS/${encoded}.bin` ? { ...entry, data: Uint8Array.of(0) } : entry,
  );
  await assert.rejects(readGameZip(buildZip(corrupt)), /attachment/);
  const opened = await readGameZip(await buildProjectZip(saved));
  assert.deepEqual(
    readProjectWorkspace(opened.project!.workspace!)[`attachment:${encoded}`],
    image.encoded,
  );
  assert.equal(readProjectHistory(opened.project!.projectHistory!, sha256Hex).commits.length, 3);
  const publicZip = buildPublicGameZip(saved);
  const publicGame = await readGameZip(publicZip);
  assert.equal(publicGame.project, undefined);
  assert.equal(new TextDecoder().decode(publicZip).includes(encoded), false);
  assert.deepEqual(
    openContainer(new Map(Object.entries(publicGame.files))).getResource("view", 0),
    session.model.capture().read("view:0")!.content,
  );
  session.dispose();
});

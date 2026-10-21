import assert from "node:assert/strict";
import { test } from "node:test";
import { compileProjectDocuments } from "../../src/authoring/projectDocuments.ts";
import { effectiveProjectCompatibility } from "../../src/authoring/projectConventions.ts";
import { createContainer, openContainer } from "../../src/container/container.ts";
import { Engine } from "../../src/runtime/engine.ts";
import { decodeSave } from "../../src/runtime/persistence.ts";
import { readGameFiles } from "../src/archive/gameZip.ts";
import { previewGame } from "../src/library/gamePreview.ts";
import { installPreviewWorkerFixture } from "./previewWorkerFixture.ts";

for (const kind of ["raw", "recognized", "catalog"] as const)
  test(`${kind} opening keeps native 50-pair room memory`, async (t) => {
    installPreviewWorkerFixture(t);
    const compiled = compileProjectDocuments({
      files: Object.fromEntries(createContainer().files),
      documents: {
        "logic:0": `if (!isset(f198)) { set(f198); load.pic(v0); draw.pic(v0); load.view(1); ${"add.to.pic(1,0,0,0,0,9,0);".repeat(12)} show.pic(); } return;`,
        "picture:0": "vis 2\nfill 0,0\nend",
        "view:1": JSON.stringify({ loops: [{ cels: [{ width: 1, height: 1, pixels: [2] }] }] }),
        words: "[]",
        inventory: "[]",
      },
      profileId: "2.936",
    });
    const files = Object.fromEntries(compiled.files());
    if (kind === "recognized") files["AGI"] = new TextEncoder().encode("Version 2.936\0");
    const game = {
      ...readGameFiles(new Map(Object.entries(files))),
      ...(kind === "raw"
        ? {}
        : { authoringConventions: { version: 0, legacyRoomMemory: true as const } }),
    };
    const source = kind === "catalog" ? "catalog" : "zip";
    const compatibility = effectiveProjectCompatibility(game, source);
    assert.equal(compatibility.legacyRoomMemory, false);
    const engine = new Engine(
      openContainer(new Map(Object.entries(files))),
      {
        print() {},
        displayAt() {},
        statusLine() {},
        takeInputLine: () => null,
        takeKeys: () => [],
      },
      new Map(),
      { legacyRoomMemory: compatibility.legacyRoomMemory },
    );
    assert.equal(decodeSave(engine.serialize(), engine.profile).replayCapacity, 50);
    await assert.rejects(previewGame(game, undefined, source), /50-pair capacity/);
  });

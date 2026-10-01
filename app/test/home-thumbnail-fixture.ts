import assert from "node:assert/strict";
import { createStarterProject } from "../../src/authoring/starterProject.ts";
import { openContainer } from "../../src/container/container.ts";
import { renderPicture } from "../../src/picture/renderer.ts";
import { Engine, HostWait } from "../../src/runtime/engine.ts";
import { DEFAULT_V2_PROFILE } from "../../src/runtime/profile.ts";
import { createPictureSurface } from "../../src/types.ts";
import { encodePngRgb, surfaceToPng } from "../../scripts/png.ts";
import { compositeFrame } from "../src/render/composite.ts";

/** Offline cache input: real Starter art and Boilerplate's first parked welcome screen. */
export function templateThumbnailPng(kind: "starter" | "boilerplate"): Uint8Array {
  const project = createStarterProject(kind);
  const container = openContainer(project.files());
  if (kind === "starter") {
    const surface = createPictureSurface();
    renderPicture(container.getResource("picture", 1)!, surface, { profile: DEFAULT_V2_PROFILE });
    return surfaceToPng(surface.visual, 160, 168, { scaleX: 2, scaleY: 1 });
  }
  const engine = new Engine(
    container,
    {
      print() {},
      displayAt() {},
      statusLine() {},
      takeInputLine: () => null,
      takeKeys: () => [],
      waitKey() {
        throw new HostWait();
      },
      randomByte: () => 0,
    },
    project.sources.words,
    { profile: project.profileId },
  );
  for (let tick = 0; tick < 20 && engine.modalKind !== "print"; tick++) engine.tick();
  assert.equal(engine.readState().room, 1);
  assert.equal(engine.modalKind, "print");
  assert.ok(engine.getFrame().visual.every((pixel) => pixel === 0));
  assert.match(
    Array.from({ length: 25 }, (_, row) => engine.textRow(row)).join("\n"),
    /Your game starts here\./,
  );
  assert.match(engine.textRow(0), /Score/);
  const rgba = new Uint8Array(320 * 200 * 4);
  compositeFrame({ ...engine.getPresentation(), picRow: engine.displayBase }, rgba);
  engine.tick();
  const parked = new Uint8Array(rgba.length);
  compositeFrame({ ...engine.getPresentation(), picRow: engine.displayBase }, parked);
  assert.deepEqual(parked, rgba, "welcome stays stable while awaiting a key");
  const rgb = new Uint8Array(320 * 200 * 3);
  for (let pixel = 0; pixel < 320 * 200; pixel++) {
    rgb.set(rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
  }
  return encodePngRgb(320, 200, rgb);
}

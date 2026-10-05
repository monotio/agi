import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { AgiStage } from "../src/three/AgiStage.ts";

/**
 * The exploded view's mask channels have a clear-on-absence contract: when a
 * frame arrives without an armed channel, the presentation layer passes null
 * and the stage must zero the texture rather than keep the previous frame's
 * mask describing current pixels. The GPU stage cannot be constructed under
 * Node, so these tests drive the real methods on a stub `this` carrying an
 * injected DataTexture — the same object the constructor allocates.
 */
interface StageStub {
  disposed: boolean;
  ownerTexture: THREE.DataTexture | null;
  previewTexture: THREE.DataTexture | null;
}

function texData(tex: THREE.DataTexture): Uint8Array {
  return tex.image.data as Uint8Array;
}

function stageWith(texName: "ownerTexture" | "previewTexture") {
  const tex = new THREE.DataTexture(new Uint8Array(8), 4, 2);
  texData(tex).fill(9);
  const stage = Object.create(AgiStage.prototype) as AgiStage;
  const stub = stage as unknown as StageStub;
  stub.disposed = false;
  stub[texName] = tex;
  return { stage, tex };
}

test("flat unchanged frames keep the uploaded texture and avoid another GPU draw", () => {
  const rgba = new Uint8Array(8);
  const texture = new THREE.DataTexture(rgba, 2, 1);
  let draws = 0;
  let glows = 0;
  const stage = Object.create(AgiStage.prototype) as AgiStage;
  Object.assign(stage, {
    disposed: false,
    rgba,
    texture,
    amount: { value: 1 },
    exploded: false,
    pendingRaf: null,
    renderPass: () => draws++,
    updateGlow: () => glows++,
  });
  const black = new Uint8Array(8);
  stage.render(black, true);
  assert.equal(draws, 1, "the first frame must draw even when it matches the initial buffer");
  assert.equal(glows, 1);
  const uploaded = texture.version;
  stage.render(black.slice(), true);
  assert.equal(draws, 1, "stationary game cycles keep the already presented frame");
  assert.equal(texture.version, uploaded, "unchanged bytes need no texture upload");
  assert.equal(glows, 1, "unchanged bytes need no CRT glow recomputation");
  const changed = Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]);
  stage.render(changed, true);
  assert.deepEqual(rgba, changed);
  assert.equal(draws, 2, "a changed frame draws immediately");
  assert.ok(texture.version > uploaded);
  assert.equal(glows, 2);

  Object.assign(stage, { exploded: true });
  stage.render(changed, true);
  assert.equal(draws, 3, "exploded layers can change while the composed pixels stay the same");
});

test("an absent ownership channel zeroes the ownership texture", () => {
  const { stage, tex } = stageWith("ownerTexture");
  stage.setOwnershipData(new Uint16Array(8).fill(4));
  assert.ok(
    texData(tex).every((v) => v === 4),
    "armed upload lands",
  );

  const version = tex.version;
  stage.setOwnershipData(null);
  assert.ok(
    texData(tex).every((v) => v === 0),
    "a disarmed channel clears the mask instead of leaving stale owners",
  );
  assert.ok(tex.version > version, "the cleared texture re-uploads");
});

test("an absent preview mask clears the show.obj layer", () => {
  const { stage, tex } = stageWith("previewTexture");
  stage.setPreviewMask(new Uint8Array(8).fill(1));
  assert.ok(texData(tex).some((v) => v === 1));

  stage.setPreviewMask(null);
  assert.ok(
    texData(tex).every((v) => v === 0),
    "a frame without the mask must not keep drawing the last preview",
  );
});

test("a wrong-length ownership buffer is ignored, not truncated into", () => {
  const { stage, tex } = stageWith("ownerTexture");
  stage.setOwnershipData(new Uint16Array(4).fill(7));
  assert.ok(
    texData(tex).every((v) => v === 9),
    "mismatched upload rejected",
  );

  stage.setOwnershipData(new Uint16Array(8).fill(300));
  assert.ok(
    texData(tex).every((v) => v === 255),
    "owner numbers clamp to the 8-bit mask",
  );
});

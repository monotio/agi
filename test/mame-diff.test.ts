import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareFrames, normalizeFrame } from "../scripts/mame-diff-metrics.ts";
import {
  outputInsideRepo,
  requireIgnoredOutput,
  validateScenario,
  type Scenario,
} from "../scripts/mame-diff.ts";

test("frame comparison counts exact RGB changes and bounds them within each screen region", () => {
  const original = new Uint8Array(320 * 200 * 3);
  const ours = original.slice();
  for (const [x, y] of [
    [3, 0],
    [5, 9],
    [7, 175],
    [319, 199],
  ])
    ours[(y! * 320 + x!) * 3] = 170;
  const result = compareFrames(original, ours);
  assert.equal(result.differingPixels, 4);
  assert.deepEqual(result.regions.status.bounds, { x: 3, y: 0, width: 1, height: 1 });
  assert.deepEqual(result.regions.play.bounds, { x: 5, y: 9, width: 3, height: 167 });
  assert.deepEqual(result.regions.input.bounds, { x: 319, y: 199, width: 1, height: 1 });
  assert.equal(result.histograms.original["#000000"], 64000);
  assert.equal(result.histograms.ours["#aa0000"], 4);
  assert.equal(compareFrames(original, original).regions.play.bounds, null);
});

test("normalization crops before nearest-neighbour sampling and never adjusts colours", () => {
  const rgba = new Uint8Array(4 * 3 * 4);
  rgba.set([17, 34, 51, 255], (1 * 4 + 1) * 4);
  rgba.set([68, 85, 102, 255], (1 * 4 + 2) * 4);
  assert.deepEqual(
    normalizeFrame({ width: 4, height: 3, rgba }, { x: 1, y: 1, width: 2, height: 1 }, 2, 1),
    new Uint8Array([17, 34, 51, 68, 85, 102]),
  );
  const scaled = normalizeFrame(
    {
      width: 4,
      height: 1,
      rgba: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
    },
    { x: 0, y: 0, width: 4, height: 1 },
    2,
    1,
  );
  assert.deepEqual(scaled, new Uint8Array([0, 255, 0, 255, 255, 255]));
  assert.throws(
    () => normalizeFrame({ width: 4, height: 3, rgba }, { x: 3, y: 0, width: 2, height: 1 }),
    /crop/i,
  );
});

test("the output guard requires gitignore on every repository child, whatever its name", () => {
  const root = resolve(".");
  // A child named "..something" is inside the repository, not a parent path.
  assert.equal(outputInsideRepo(resolve("..review-captures"), root), true);
  assert.throws(() => requireIgnoredOutput(resolve("..review-captures")), /gitignored/);
  // A true sibling of the repository root is outside and needs no ignore.
  assert.equal(outputInsideRepo(resolve("..", "mame-diff-outside"), root), false);
  assert.doesNotThrow(() => requireIgnoredOutput(resolve("..", "mame-diff-outside")));
  // The default scratch area is an ignored repository child.
  assert.equal(outputInsideRepo(resolve(".local/mame-diff/test-run"), root), true);
  assert.doesNotThrow(() => requireIgnoredOutput(resolve(".local/mame-diff/test-run")));
  // An ordinary unignored child is refused.
  assert.equal(outputInsideRepo(resolve("scripts/mame-diff-out"), root), true);
  assert.throws(() => requireIgnoredOutput(resolve("scripts/mame-diff-out")), /gitignored/);
});

test("the output guard follows the script's repository root, not the current directory", () => {
  // The script may run from anywhere (a capture directory, another checkout):
  // containment and git check-ignore still refer to its own repository.
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "mame-diff-cwd-")));
  try {
    assert.equal(outputInsideRepo(join(root, ".local/mame-diff/test-run")), true);
    assert.doesNotThrow(() => requireIgnoredOutput(join(root, ".local/mame-diff/test-run")));
    assert.throws(() => requireIgnoredOutput(join(root, "scripts/mame-diff-out")), /gitignored/);
    assert.equal(outputInsideRepo(join(root, "..", "mame-diff-outside")), false);
  } finally {
    process.chdir(home);
  }
});

test("scene scripts accept direction keys and a Node RNG seed, and reject malformed ones", () => {
  const scenario: Scenario = {
    fixture: "sq2",
    profile: "2.917",
    machine: "t1000sx",
    media: [],
    crop: { x: 0, y: 0, width: 320, height: 200 },
    seconds: 10,
    steps: [
      { at: 1, key: "Right", fields: ["Cursor Right"] },
      { at: 2, key: "Up" },
      { at: 3, capture: "walk" },
    ],
  };
  assert.doesNotThrow(() => validateScenario(scenario));
  const withSteps = (steps: Scenario["steps"]) => () => validateScenario({ ...scenario, steps });
  assert.throws(
    withSteps([
      { at: 1, key: "Northeast" as "Up" },
      { at: 3, capture: "walk" },
    ]),
    /Unsupported key/,
  );
  assert.throws(withSteps([{ at: 1, fields: ["Cursor Up"], capture: "walk" }]), /fields must list/);
  assert.throws(
    withSteps([
      { at: 1, key: "Left", fields: [] },
      { at: 3, capture: "walk" },
    ]),
    /fields/,
  );
});

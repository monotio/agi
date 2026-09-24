import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { openContainer } from "../src/container/container.ts";
import { createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
import {
  splitToolResult,
  openAiToolContent,
  anthropicToolContent,
  PROVIDER_IMAGE_BYTES,
} from "../src/agent/toolTransport.ts";
import { parseView } from "../src/view/view.ts";
import { assertNoImageData } from "./modelText.ts";

function pixels(png: Uint8Array) {
  const b = Buffer.from(png);
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < b.length;) {
    const size = b.readUInt32BE(offset);
    if (b.toString("ascii", offset + 4, offset + 8) === "IDAT")
      chunks.push(b.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  return {
    width,
    height,
    at(x: number, y: number) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      return [...raw.subarray(offset, offset + 3)];
    },
  };
}

for (const version of ["2.936", "2.230"]) {
  test(`write_view previews compiled colors, transparency and mirroring for ${version}`, () => {
    const session = createAgentSessionState(
      openContainer(new Map([["AGIDATA.OVL", Uint8Array.from(version, (c) => c.charCodeAt(0))]])),
    );
    const result = executeAgentTool(session, "write_view", {
      num: 0,
      source: "view\ncel a 3 2 0\n4.1\n2.3\nendcel\nloop 0 a\nloop 1 mirror 0\nendview",
    });
    assert.equal(result.success, true);
    assert.equal(result.images?.length, 1);
    const image = result.images![0]!;
    const bitmap = pixels(image.png);
    assert.deepEqual([bitmap.width, bitmap.height], [160, 64]);
    // 3x2 AGI pixels become 18x6 raster pixels, centered and baseline-aligned.
    assert.deepEqual(bitmap.at(31, 54), [170, 0, 0]);
    assert.deepEqual(bitmap.at(43, 54), [0, 0, 170]);
    assert.deepEqual(bitmap.at(111, 54), [0, 0, 170]);
    assert.deepEqual(bitmap.at(123, 54), [170, 0, 0]);
    assert.deepEqual(bitmap.at(37, 54), [38, 43, 50]);
    assert.match(image.caption, /L0 C0.*L1 C0/);
    const content = splitToolResult(result);
    assertNoImageData(content.text);
    for (const blocks of [openAiToolContent(content), anthropicToolContent(content)]) {
      assert.equal(blocks.length, 3);
      assert.ok(["image", "input_image"].includes(blocks[2]!.type));
    }
  });
}

test("large views return one bounded, explicitly sampled contact sheet", () => {
  const result = executeAgentTool(createAgentSessionState(), "write_view", {
    num: 1,
    source: [
      "view",
      "cel dot 1 1 0",
      "F",
      "endcel",
      ...Array.from({ length: 10 }, (_, loop) => `loop ${loop} ${"dot ".repeat(10).trim()}`),
      "endview",
    ].join("\n"),
  });
  assert.equal(result.images?.length, 1);
  const image = result.images![0]!;
  const bitmap = pixels(image.png);
  assert.ok(bitmap.width <= 320 && bitmap.height <= 512);
  assert.ok(image.png.length <= PROVIDER_IMAGE_BYTES);
  assert.match(image.caption, /32 of 100/);
  assertNoImageData(splitToolResult(result).text);
});

test("four-direction preview states AGI loop order and preserves authored pixels", () => {
  const session = createAgentSessionState();
  const result = executeAgentTool(session, "write_view", {
    num: 0,
    source: [
      "view",
      ...[1, 2, 3, 4].flatMap((colour) => [`cel c${colour} 2 1 0`, `${colour}.`, "endcel"]),
      ...[1, 2, 3, 4].map((colour, loop) => `loop ${loop} c${colour}`),
      "endview",
    ].join("\n"),
  });
  assert.equal(result.success, true);
  const view = parseView(session.container.getResource("view", 0)!);
  assert.deepEqual(
    view.loops.map((l) => [...l.cels[0]!.pixels]),
    [
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
    ],
  );
  assert.match(result.images![0]!.caption, /L0 = right, L1 = left, L2 = down.*L3 = up/);
});

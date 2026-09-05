import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { openContainer } from "../src/container/container.ts";
import { createAgentSessionState, executeAgentTool } from "../src/agent/tools.ts";
import {
  splitToolResult,
  openAiToolContent,
  anthropicToolContent,
} from "../src/agent/toolTransport.ts";
import { parseView } from "../src/view/view.ts";

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
      spec: {
        loops: [
          { cels: [{ width: 3, height: 2, transparentColor: 0, pixels: [4, 0, 1, 2, 0, 3] }] },
          { mirrorLoop: 0 },
        ],
      },
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
    assert.ok(content.text.length < 1600);
    for (const blocks of [openAiToolContent(content), anthropicToolContent(content)]) {
      assert.equal(blocks.length, 3);
      assert.ok(["image", "input_image"].includes(blocks[2]!.type));
    }
  });
}

test("large views return one bounded, explicitly sampled contact sheet", () => {
  const result = executeAgentTool(createAgentSessionState(), "write_view", {
    num: 1,
    spec: {
      loops: Array.from({ length: 10 }, () => ({
        cels: Array.from({ length: 10 }, () => ({
          width: 1,
          height: 1,
          pixels: [15],
        })),
      })),
    },
  });
  assert.equal(result.images?.length, 1);
  const image = result.images![0]!;
  const bitmap = pixels(image.png);
  assert.ok(bitmap.width <= 320 && bitmap.height <= 512);
  assert.ok(image.png.length < 500_000);
  assert.match(image.caption, /32 of 100/);
  assert.ok(splitToolResult(result).text.length < 2000);
});

test("four-direction preview states AGI loop order and preserves authored pixels", () => {
  const session = createAgentSessionState();
  const result = executeAgentTool(session, "write_view", {
    num: 0,
    spec: {
      loops: [1, 2, 3, 4].map((color) => ({
        cels: [{ width: 2, height: 1, transparentColor: 0, pixels: [color, 0] }],
      })),
    },
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPicture, type PictureOwnerBuffers } from "../src/picture/renderer.ts";
import { createPictureSurface, SCREEN_HEIGHT, SCREEN_WIDTH } from "../src/types.ts";

const CELLS = SCREEN_WIDTH * SCREEN_HEIGHT;

function owners(): PictureOwnerBuffers {
  return { visual: new Int32Array(CELLS), priority: new Int32Array(CELLS) };
}

/** Every cell index with a recorded owner, mapped to that owner. */
function owned(buffer: Int32Array): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < buffer.length; i++) if (buffer[i]! >= 0) out[i] = buffer[i]!;
  return out;
}

const at = (x: number, y: number): number => y * SCREEN_WIDTH + x;

/** Concatenate commands into a terminated stream. */
const stream = (...commands: number[][]): Uint8Array => new Uint8Array([...commands.flat(), 0xff]);

test("a later line owns the pixel it overwrites", () => {
  const owner = owners();
  renderPicture(
    stream(
      [0xf0, 1], //             0: vis 1
      [0xf6, 0, 0, 2, 0], //    2: line 0,0 2,0
      [0xf0, 2], //             7: vis 2
      [0xf6, 1, 0, 1, 1], //    9: line 1,0 1,1
    ),
    createPictureSurface(),
    { owner },
  );
  assert.deepEqual(owned(owner.visual), {
    [at(0, 0)]: 2,
    [at(1, 0)]: 9,
    [at(2, 0)]: 2,
    [at(1, 1)]: 9,
  });
  assert.deepEqual(owned(owner.priority), {});
});

test("a fill owns exactly the enclosed region on each enabled channel", () => {
  const owner = owners();
  renderPicture(
    stream(
      [0xf0, 0], //                               0: vis 0
      [0xf6, 0, 0, 4, 0, 4, 4, 0, 4, 0, 0], //    2: rect 0,0 4,4
      [0xf0, 2], //                              13: vis 2
      [0xf2, 5], //                              15: pri 5
      [0xf8, 2, 2], //                           17: fill 2,2
    ),
    createPictureSurface(),
    { owner },
  );
  const border: Record<string, number> = {};
  const interior: Record<string, number> = {};
  for (let y = 0; y <= 4; y++) {
    for (let x = 0; x <= 4; x++) {
      if (x === 0 || x === 4 || y === 0 || y === 4) border[at(x, y)] = 2;
      else interior[at(x, y)] = 17;
    }
  }
  assert.equal(Object.keys(border).length, 16);
  assert.equal(Object.keys(interior).length, 9);
  assert.deepEqual(owned(owner.visual), { ...border, ...interior });
  assert.deepEqual(owned(owner.priority), interior);
});

test("prepare resets owners to -1; overlay keeps them", () => {
  const owner = owners();
  owner.visual.fill(7);
  owner.priority.fill(7);
  const surface = createPictureSurface();
  const first = new Uint8Array([0xf0, 1, 0xf6, 5, 5, 0xff]);
  const second = new Uint8Array([0xf2, 3, 0xf6, 6, 6, 0xff]);
  renderPicture(first, surface, { owner });
  assert.deepEqual(owned(owner.visual), { [at(5, 5)]: 2 });
  assert.deepEqual(owned(owner.priority), {});
  renderPicture(second, surface, { owner, overlay: true });
  assert.deepEqual(owned(owner.visual), { [at(5, 5)]: 2 });
  assert.deepEqual(owned(owner.priority), { [at(6, 6)]: 2 });
  renderPicture(second, surface, { owner });
  assert.deepEqual(owned(owner.visual), {});
  assert.deepEqual(owned(owner.priority), { [at(6, 6)]: 2 });
});

test("pattern plots own every brush cell; a stipple plot that writes nothing owns none", () => {
  const owner = owners();
  renderPicture(
    stream(
      [0xf0, 4], //       0: vis 4
      [0xf9, 1], //       2: pen 1 (v2 radius 1: 3 rows x 2 columns)
      [0xfa, 10, 20], //  4: plot 10,20 -> x 9..10, y 19..21
      [0xf9, 0x20], //    7: pen 0 stipple
      // 9: seed 4 writes its one cell (state 5 -> 0xba, low bits 10);
      //    seed 0 writes nothing (state 1 -> 0xb8, low bits 00).
      [0xfa, 4, 30, 40, 0, 31, 40],
    ),
    createPictureSurface(),
    { owner },
  );
  assert.deepEqual(owned(owner.visual), {
    [at(9, 19)]: 4,
    [at(10, 19)]: 4,
    [at(9, 20)]: 4,
    [at(10, 20)]: 4,
    [at(9, 21)]: 4,
    [at(10, 21)]: 4,
    [at(30, 40)]: 9,
  });
});

test("recording owners leaves the rendered cells unchanged", () => {
  const bytes = new Uint8Array([
    0xf0, 1, 0xf2, 6, 0xf6, 0, 0, 20, 0, 20, 20, 0, 20, 0, 0, 0xf0, 3, 0xf8, 5, 5, 0xf9, 0x23, 0xfa,
    9, 50, 50, 0xff,
  ]);
  const plain = createPictureSurface();
  const traced = createPictureSurface();
  renderPicture(bytes, plain);
  renderPicture(bytes, traced, { owner: owners() });
  assert.deepEqual(traced.visual, plain.visual);
  assert.deepEqual(traced.priority, plain.priority);
});

test("owner buffers must cover the whole surface", () => {
  assert.throws(
    () =>
      renderPicture(new Uint8Array([0xff]), createPictureSurface(), {
        owner: { visual: new Int32Array(4), priority: new Int32Array(CELLS) },
      }),
    RangeError,
  );
});

test("the write trace reports each cell with its opcode and consumed bytes", () => {
  const calls: number[][] = [];
  renderPicture(
    stream(
      [0xf0, 1], //          0: vis 1
      [0xf6, 5, 5, 6, 5], // 2: line 5,5 6,5 (plots after byte 4, then after byte 6)
      [0xf1], //             7: vis off
      [0xf6, 1, 1], //       8: line 1,1 with no channel enabled writes nothing
    ),
    createPictureSurface(),
    { onCellWrite: (index, opcode, consumed) => calls.push([index, opcode, consumed]) },
  );
  assert.deepEqual(calls, [
    [at(5, 5), 2, 5],
    [at(6, 5), 2, 7],
  ]);
});

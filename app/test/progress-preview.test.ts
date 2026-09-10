import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { autosaveKey, readAutosave, writeAutosave, type AutosaveRecord } from "../src/useEngine.ts";
import {
  createProgressPreview,
  isProgressPreview,
  storeRecordWithPreviewFallback,
} from "../src/progressPreview.ts";

function previewPixels(dataUrl: string): { width: number; height: number; rgb: Uint8Array } {
  const png = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (char) =>
    char.charCodeAt(0),
  );
  const chunks = new Map<string, Uint8Array>();
  let offset = 8;
  while (offset < png.length) {
    const view = new DataView(png.buffer, png.byteOffset + offset);
    const length = view.getUint32(0);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    chunks.set(type, png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const header = chunks.get("IHDR")!;
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = headerView.getUint32(0);
  const height = headerView.getUint32(4);
  assert.equal(header[8], 8);
  assert.equal(header[9], 3);
  const palette = chunks.get("PLTE")!;
  const raw = new Uint8Array(inflateSync(chunks.get("IDAT")!));
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    assert.equal(raw[row], 0);
    for (let x = 0; x < width; x++) {
      const color = raw[row + x + 1]! * 3;
      rgb.set(palette.subarray(color, color + 3), (y * width + x) * 3);
    }
  }
  return { width, height, rgb };
}

test("progress preview composes the picture and engine text from one frame", () => {
  const visual = new Uint8Array(160 * 168).fill(1);
  visual[5] = 2;
  const text = new Uint8Array(40 * 25 * 2);
  text[0] = 32;
  text[1] = 0x4f;
  const preview = createProgressPreview({ visual, text, picRow: 1 });
  assert.equal(isProgressPreview(preview), true);
  const decoded = previewPixels(preview);
  assert.deepEqual([decoded.width, decoded.height], [320, 200]);
  assert.deepEqual([...decoded.rgb.subarray(0, 3)], [170, 0, 0], "text background is composited");
  assert.deepEqual(
    [...decoded.rgb.subarray((8 * 320 + 10) * 3, (8 * 320 + 12) * 3)],
    [0, 170, 0, 0, 170, 0],
    "the same logical scene pixel is doubled horizontally",
  );
  assert.deepEqual([...decoded.rgb.subarray((8 * 320 + 12) * 3, (8 * 320 + 13) * 3)], [0, 0, 170]);
  assert.throws(
    () => createProgressPreview({ visual: new Uint8Array(1), text, picRow: 1 }),
    /expected 26880 visual/i,
  );
  assert.equal(isProgressPreview(preview.slice(0, 66)), false, "a header alone is not an image");
});

test("version-1 autosaves allow optional previews and reject other formats", () => {
  const values = new Map<string, string>();
  const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null },
  });
  try {
    const checkpoint: AutosaveRecord = {
      format: "monotio.agi.autosave",
      version: 1,
      image: "save-image",
      cycle: 12,
      room: 3,
      savedAt: 100,
      game: { alias: "checkpoint", installed: true, revision: "0".repeat(64) },
    };
    values.set(autosaveKey("checkpoint"), JSON.stringify(checkpoint));
    assert.deepEqual(readAutosave("checkpoint"), checkpoint);
    for (const version of [undefined, 2]) {
      values.set(autosaveKey("checkpoint"), JSON.stringify({ ...checkpoint, version }));
      assert.equal(readAutosave("checkpoint"), null);
    }

    values.set(
      autosaveKey("checkpoint"),
      JSON.stringify({ ...checkpoint, preview: "data:text/html,bad" }),
    );
    assert.deepEqual(readAutosave("checkpoint"), checkpoint);
    const preview = createProgressPreview({
      visual: new Uint8Array(160 * 168),
      text: new Uint8Array(40 * 25 * 2),
      picRow: 1,
    });
    values.set(autosaveKey("checkpoint"), JSON.stringify({ ...checkpoint, preview }));
    assert.equal(readAutosave("checkpoint")?.preview, preview);
    values.set(autosaveKey("other"), JSON.stringify(checkpoint));
    assert.equal(readAutosave("other"), null, "a misfiled save cannot represent another game");
    const future = JSON.stringify({ ...checkpoint, version: 2 });
    values.set(autosaveKey("checkpoint"), future);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    assert.equal(writeAutosave(storage, checkpoint), null);
    assert.equal(values.get(autosaveKey("checkpoint")), future);
    values.delete(autosaveKey("checkpoint"));
    assert.deepEqual(writeAutosave(storage, checkpoint), checkpoint);
    assert.deepEqual(readAutosave("checkpoint"), checkpoint);
  } finally {
    if (prior) Object.defineProperty(globalThis, "localStorage", prior);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("format-less and corrupt checkpoints are replaceable; future versions are not", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const checkpoint: AutosaveRecord = {
    format: "monotio.agi.autosave",
    version: 1,
    image: "save-image",
    cycle: 12,
    room: 3,
    savedAt: 100,
    game: { alias: "kq1", installed: true, revision: "0".repeat(64) },
  };
  const key = autosaveKey("kq1");
  values.set(
    key,
    JSON.stringify({
      image: "AAAA",
      cycle: 1,
      room: 1,
      savedAt: 1,
      game: { alias: "kq1", installed: true, revision: "0".repeat(64) },
    }),
  );
  assert.deepEqual(writeAutosave(storage, checkpoint), checkpoint, "pre-release record");
  assert.deepEqual(JSON.parse(values.get(key)!), checkpoint);
  values.set(key, "{not json");
  assert.deepEqual(writeAutosave(storage, checkpoint), checkpoint, "corrupt record");
  assert.deepEqual(JSON.parse(values.get(key)!), checkpoint);
  for (const version of [undefined, null, "2", 2.5, {}, [], -1, 0]) {
    values.set(key, JSON.stringify({ ...checkpoint, version }));
    assert.deepEqual(
      writeAutosave(storage, checkpoint),
      checkpoint,
      `malformed version ${String(version)}`,
    );
    assert.deepEqual(JSON.parse(values.get(key)!), checkpoint);
  }
  const future = JSON.stringify({ ...checkpoint, version: 2 });
  values.set(key, future);
  assert.equal(writeAutosave(storage, checkpoint), null, "future record");
  assert.equal(values.get(key), future);
});

test("storage quota failure retries the viable save record without its preview", () => {
  const visual = new Uint8Array(160 * 168).fill(1);
  const preview = createProgressPreview({
    visual,
    text: new Uint8Array(40 * 25 * 2),
    picRow: 1,
  });
  let stored = "";
  let attempts = 0;
  const record = {
    image: "save-image",
    preview,
    cycle: 42,
  };
  const result = storeRecordWithPreviewFallback(
    {
      setItem(_key, value) {
        attempts++;
        if (value.includes('"preview"')) throw new Error("QuotaExceededError");
        stored = value;
      },
    },
    "autosave",
    record,
  );
  assert.equal(attempts, 2);
  assert.deepEqual(result, { image: "save-image", cycle: 42 });
  assert.deepEqual(JSON.parse(stored), result);
  assert.equal(record.preview, preview, "fallback does not mutate the candidate record");
});

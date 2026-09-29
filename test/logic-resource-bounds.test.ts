import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLogicResource, parseLogicResource } from "../src/logic/resource.ts";

// Payload layout: u16le code_length | code | u8 count | u16le offsets[count+1]
// | text. Three u16le bounds: the code_length field, every offset (entry 0 is
// the region end, relative to the table start) and the record length the
// containers store.

test("accepts a record at the exact u16le payload limit", () => {
  // 2 + 65530 + 1 + 2 = 65535: code_length | code | count | one end entry.
  const code = new Uint8Array(65530);
  for (let i = 0; i < code.length; i++) code[i] = i & 0xff;
  const payload = buildLogicResource(code, []);
  assert.equal(payload.length, 0xffff);
  assert.equal(payload[0], 0xfa); // code_length 65530 = 0xfffa
  assert.equal(payload[1], 0xff);
  assert.equal(payload[65532], 0x00); // message count
  assert.equal(payload[65533], 0x02); // region end = 2-byte table
  assert.equal(payload[65534], 0x00);
  const parsed = parseLogicResource(payload);
  assert.deepEqual(parsed.code, code);
  assert.deepEqual(parsed.messages, []);
});

test("rejects a record one byte over the u16le payload limit", () => {
  assert.throws(
    () => buildLogicResource(new Uint8Array(65531), []),
    /payload of 65536 bytes.*65535/,
  );
});

test("rejects code beyond the u16le code_length field", () => {
  assert.throws(() => buildLogicResource(new Uint8Array(65536), []), /code of 65536 bytes.*65535/);
});

test("code at the u16le maximum still needs room for the frame", () => {
  // 65535 fits code_length but the record would be 2 + 65535 + 1 + 2 = 65540.
  assert.throws(
    () => buildLogicResource(new Uint8Array(65535), []),
    /payload of 65540 bytes.*65535/,
  );
});

test("accepts the largest single message that fits the record", () => {
  // 2 + 0 + 1 + 4 + (65527 + 1) = 65535; region end offset = 4 + 65528 = 65532.
  const message = "x".repeat(65527);
  const payload = buildLogicResource(new Uint8Array(0), [message]);
  assert.equal(payload.length, 0xffff);
  assert.deepEqual(parseLogicResource(payload).messages, [message]);
});

test("rejects a message region end beyond the u16le offset field", () => {
  // Region end = table(4) + text(65531 + 1) = 65536 > 65535; the record total
  // overflows too, but the offset field is the bound that fails first.
  assert.throws(
    () => buildLogicResource(new Uint8Array(0), ["x".repeat(65531)]),
    /region end of 65536.*65535/,
  );
  // Region end 4 + 65531 = 65535 still fits its field; the record bound
  // (0 + 3 + 4 + 65531 = 65538) is the one that rejects it.
  assert.throws(
    () => buildLogicResource(new Uint8Array(0), ["x".repeat(65530)]),
    /payload of 65538 bytes.*65535/,
  );
});

test("rejects the record one byte over via message text", () => {
  // 2 + 0 + 1 + 4 + (65528 + 1) = 65536.
  assert.throws(
    () => buildLogicResource(new Uint8Array(0), ["x".repeat(65528)]),
    /payload of 65536 bytes.*65535/,
  );
});

test("absent, empty and text slots produce hand-computed bytes", () => {
  const payload = buildLogicResource(new Uint8Array([0x00]), [null, "", "Hi"]);
  assert.deepEqual(
    [...payload],
    [
      0x01,
      0x00, // code_length = 1
      0x00, // return
      0x03, // message count
      0x0c,
      0x00, // region end = 8-byte table + 4 text bytes
      0x00,
      0x00, // message 1 absent: zero offset, no text byte
      0x08,
      0x00, // message 2 empty: offset 8 points at its terminator
      0x09,
      0x00, // message 3 at offset 9
      0x41, // "" terminator: 0x00 ^ 'A'
      0x3e,
      0x00, // "Hi" ^ "vi" — an encrypted NUL is data, not a terminator
      0x73, // terminator: 0x00 ^ 's'
    ],
  );
  assert.deepEqual(parseLogicResource(payload).messages, [null, "", "Hi"]);
});

test("255 message slots is the maximum count", () => {
  const messages = new Array<string | null>(255).fill(null);
  const payload = buildLogicResource(new Uint8Array([0x00]), messages);
  // 2 + 1 + 1 + 256 * 2 = 516; every slot absent, so no text bytes.
  assert.equal(payload.length, 516);
  assert.equal(payload[3], 0xff);
  assert.equal(payload[4], 0x00); // region end = 512 = 0x0200
  assert.equal(payload[5], 0x02);
  assert.deepEqual(parseLogicResource(payload).messages, messages);
  assert.throws(
    () => buildLogicResource(new Uint8Array(0), new Array(256).fill(null)),
    /at most 255 messages, got 256/,
  );
});

test("rejects a message character wider than one byte", () => {
  assert.throws(
    () => buildLogicResource(new Uint8Array(0), ["ok€"]),
    /message 1 character 2 is U\+20AC.*not a single byte/,
  );
  assert.throws(
    () => buildLogicResource(new Uint8Array(0), [null, "Ā"]),
    /message 2 character 0 is U\+0100/,
  );
});

test("bounds are rejected before messages are encoded", () => {
  // A wide char in an over-long message reports the framing bound, not the
  // character error: sizes are checked before encodeLatin1 runs.
  assert.throws(
    () => buildLogicResource(new Uint8Array(0), ["Ā".repeat(65532)]),
    /region end of 65537.*65535/,
  );
  assert.throws(
    () => buildLogicResource(new Uint8Array(65536), ["Ā"]),
    /code of 65536 bytes.*65535/,
  );
});

test("minimal resource: empty code, no messages", () => {
  assert.deepEqual([...buildLogicResource(new Uint8Array(0), [])], [0, 0, 0, 2, 0]);
});

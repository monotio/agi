/**
 * AGI logic resource framing (Peter Kelly's agi-re spec, "Logic payload"):
 *
 *   u16le code_length
 *   u8    bytecode[code_length]
 *   u8    message_count
 *   u16le message_offset[message_count + 1]
 *   u8    encrypted_message_text[]
 *
 * Offsets are relative to the first byte of the offset table. Entry 0 is the
 * end of the text region; entries 1..message_count locate messages 1..N. A
 * zero offset means the slot is ABSENT — the original tools left a hole in the
 * table — which is not the same thing as a present but empty message (that one
 * has a real offset pointing straight at its terminator, and so costs a byte).
 * Message text is zero-terminated and XORed with the repeating key
 * "Avis Durgan". The offset table itself is not encrypted.
 *
 * Message text is carried as one JavaScript char per byte (Latin-1), NOT as
 * UTF-8: a logic message is a byte string in an IBM code page, and byte-exact
 * round-tripping matters more than any particular interpretation of bytes
 * above 0x7f. For ASCII — everything the shipped content uses — the two are
 * identical, so callers that just display the text are unaffected.
 */

export const MESSAGE_KEY = "Avis Durgan";

export interface LogicResource {
  readonly code: Uint8Array;
  /** Messages 1..N at indices 0..N-1; `null` is an absent (zero-offset) slot. */
  readonly messages: readonly (string | null)[];
}

/** One byte per char; throws rather than silently mangling a wider char. */
function encodeLatin1(text: string, index: number): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 0xff) {
      throw new Error(
        `message ${index + 1} character ${i} is U+${c.toString(16).toUpperCase().padStart(4, "0")}, which is not a single byte (logic messages are byte strings; use \\xNN)`,
      );
    }
    out[i] = c;
  }
  return out;
}

export function buildLogicResource(
  code: Uint8Array,
  messages: readonly (string | null)[],
): Uint8Array {
  if (messages.length > 255) {
    throw new Error(`logic resource supports at most 255 messages, got ${messages.length}`);
  }
  const encoded = messages.map((m, i) => (m === null ? null : encodeLatin1(m, i)));
  const tableBytes = (messages.length + 1) * 2;
  const textBytes = encoded.reduce((sum, m) => sum + (m === null ? 0 : m.length + 1), 0);

  const out = new Uint8Array(2 + code.length + 1 + tableBytes + textBytes);
  out[0] = code.length & 0xff;
  out[1] = (code.length >> 8) & 0xff;
  out.set(code, 2);
  const tableStart = 2 + code.length + 1;
  out[2 + code.length] = messages.length;

  const view = new DataView(out.buffer);
  const textStart = tableStart + tableBytes;
  let cursor = 0;
  encoded.forEach((msg, i) => {
    if (msg === null) {
      view.setUint16(tableStart + (i + 1) * 2, 0, true);
      return;
    }
    view.setUint16(tableStart + (i + 1) * 2, tableBytes + cursor, true);
    for (let j = 0; j < msg.length; j++) {
      out[textStart + cursor + j] =
        (msg[j] ?? 0) ^ MESSAGE_KEY.charCodeAt((cursor + j) % MESSAGE_KEY.length);
    }
    cursor += msg.length;
    out[textStart + cursor] = 0 ^ MESSAGE_KEY.charCodeAt(cursor % MESSAGE_KEY.length);
    cursor += 1;
  });
  view.setUint16(tableStart, tableBytes + cursor, true);
  return out;
}

/**
 * Return a copy of `payload` with its message-text region XORed with the
 * repeating key. XOR is its own inverse, so the same call both encrypts a
 * plain region into the spec's layout and decrypts an encrypted one. The
 * code, the count and the offset table are copied unchanged. A payload whose
 * framing does not fit is returned as an unmodified copy; the parser reports
 * the framing error.
 *
 * Observed v3 game data (a Sierra 3.002.102 demo installation, where every
 * logic record is dictionary-compressed) stores the message text of
 * dictionary-compressed logic records plain, while directly stored records
 * carry the encrypted text the "Logic payload" section specifies. The v3
 * container uses this to hand every decoder one encoding.
 */
export function toggleMessageEncryption(payload: Uint8Array): Uint8Array {
  const out = payload.slice();
  if (payload.length < 3) return out;
  const codeLength = payload[0]! | (payload[1]! << 8);
  const tableStart = 2 + codeLength + 1;
  if (tableStart > payload.length) return out;
  const messageCount = payload[tableStart - 1]!;
  const textStart = tableStart + (messageCount + 1) * 2;
  if (textStart > payload.length) return out;
  const regionEnd = tableStart + (payload[tableStart]! | (payload[tableStart + 1]! << 8));
  if (regionEnd < textStart || regionEnd > payload.length) return out;
  for (let at = textStart; at < regionEnd; at++) {
    out[at] = payload[at]! ^ MESSAGE_KEY.charCodeAt((at - textStart) % MESSAGE_KEY.length);
  }
  return out;
}

export function parseLogicResource(payload: Uint8Array): LogicResource {
  if (payload.length < 3) throw new Error("logic resource too short");
  const codeLength = payload[0]! | (payload[1]! << 8);
  const code = payload.slice(2, 2 + codeLength);
  const messageCount = payload[2 + codeLength]!;
  const tableStart = 2 + codeLength + 1;
  if (tableStart + (messageCount + 1) * 2 > payload.length) {
    throw new Error("logic message table truncated");
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const endOffset = view.getUint16(tableStart, true);
  const textStart = tableStart + (messageCount + 1) * 2;

  const messages: (string | null)[] = [];
  for (let i = 1; i <= messageCount; i++) {
    const rel = view.getUint16(tableStart + i * 2, true);
    if (rel === 0) {
      messages.push(null);
      continue;
    }
    const start = tableStart + rel;
    let end = start;
    const regionEnd = tableStart + endOffset;
    while (end < regionEnd) {
      const b = payload[end]! ^ MESSAGE_KEY.charCodeAt((end - textStart) % MESSAGE_KEY.length);
      if (b === 0) break;
      end++;
    }
    let text = "";
    for (let j = start; j < end; j++) {
      text += String.fromCharCode(
        payload[j]! ^ MESSAGE_KEY.charCodeAt((j - textStart) % MESSAGE_KEY.length),
      );
    }
    messages.push(text);
  }
  return { code, messages };
}

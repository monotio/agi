import { readProjectContext, type ProjectContext } from "./projectArchive.ts";
import { crc32 } from "./zip.ts";
import { openContainer, DIRECTORY_FILES } from "../../src/container/container.ts";
import { parseWordsTok } from "../../src/logic/words.ts";
import { parseLogicResource } from "../../src/logic/resource.ts";

export const MAX_GAME_ZIP_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/** Read stored/deflated ZIPs into memory; no paths are written to disk. */
export async function readGameZip(bytes: Uint8Array): Promise<{
  files: Record<string, Uint8Array>;
  words: [string, number][];
  title?: string;
  roomGeneration?: boolean;
  project?: ProjectContext;
}> {
  if (bytes.length < 22 || bytes.length > MAX_GAME_ZIP_BYTES)
    throw new Error("Choose a valid game ZIP smaller than 128 MB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const check = (offset: number, length: number, limit = bytes.length): void => {
    if (offset < 0 || length < 0 || offset + length > limit)
      throw new Error("Truncated ZIP archive.");
  };
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (
      view.getUint32(at, true) === 0x06054b50 &&
      at + 22 + view.getUint16(at + 20, true) === bytes.length
    ) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("ZIP directory is missing.");
  const count = view.getUint16(end + 10, true);
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count ||
    count > 1024
  )
    throw new Error("Use a single ZIP with at most 1024 files; ZIP64 is not supported.");
  const directorySize = view.getUint32(end + 12, true);
  const directoryStart = view.getUint32(end + 16, true);
  check(directoryStart, directorySize, end);
  let at = directoryStart;
  let expanded = 0;
  const entries = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let index = 0; index < count; index++) {
    check(at, 46, directoryStart + directorySize);
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("Invalid ZIP directory entry.");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const disk = view.getUint16(at + 34, true);
    check(at + 46, nameLength + extraLength + commentLength, directoryStart + directorySize);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)).replace(/\\/g, "/");
    if (
      !name ||
      name.startsWith("/") ||
      name.includes(":") ||
      name.includes("\0") ||
      name.split("/").some((p) => p === ".." || p === ".")
    )
      throw new Error("Invalid ZIP entry path.");
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x41 || (method !== 0 && method !== 8) || disk)
      throw new Error("Use an unencrypted ZIP with standard compression.");
    expanded += size;
    if (size > MAX_ENTRY_BYTES || expanded > MAX_EXPANDED_BYTES)
      throw new Error("ZIP expands beyond the game import size limit.");
    check(local, 30, directoryStart);
    if (
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 8, true) !== method ||
      view.getUint16(local + 6, true) !== flags
    )
      throw new Error("Invalid ZIP local header.");
    const localNameLength = view.getUint16(local + 26, true);
    const start = local + 30 + localNameLength + view.getUint16(local + 28, true);
    check(local + 30, start - local - 30, directoryStart);
    if (
      decoder
        .decode(bytes.subarray(local + 30, local + 30 + localNameLength))
        .replace(/\\/g, "/") !== name
    )
      throw new Error("ZIP filenames do not match.");
    check(start, packed, directoryStart);
    let data = bytes.slice(start, start + packed);
    if (method === 8) {
      const reader = new Blob([data])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"))
        .getReader();
      const output = new Uint8Array(size);
      let written = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (written + chunk.value.length > size) throw new Error("ZIP expanded size mismatch.");
          output.set(chunk.value, written);
          written += chunk.value.length;
        }
        if (written !== size) throw new Error("ZIP expanded size mismatch.");
      } finally {
        await reader.cancel();
      }
      data = output;
    }
    if (data.length !== size || crc32(data) !== crc)
      throw new Error(`ZIP checksum failed for ${name}.`);
    const key = name.toUpperCase();
    if (entries.has(key)) throw new Error(`Duplicate ZIP filename: ${name}.`);
    entries.set(key, data);
  }
  if (at !== directoryStart + directorySize) throw new Error("Invalid ZIP directory size.");
  const directories = [...entries.keys()].filter((path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return (
      name === "LOGDIR" || (name.endsWith("DIR") && !Object.values(DIRECTORY_FILES).includes(name))
    );
  });
  const roots = [...new Set(directories.map((path) => path.slice(0, path.lastIndexOf("/") + 1)))];
  if (roots.length !== 1)
    throw new Error("The ZIP must contain one AGI game with resource directories.");
  const root = roots[0]!;
  const files: Record<string, Uint8Array> = {};
  for (const [path, data] of entries) {
    if (!path.startsWith(root)) continue;
    const name = path.slice(root.length);
    if (
      /^([A-Z0-9_]*DIR|[A-Z0-9_]*VOL\.(?:[0-9]|1[0-5])|WORDS\.TOK|OBJECT|AGIDATA\.OVL|AGI|[A-Z0-9_-]+\.COM)$/.test(
        name,
      )
    )
      files[name] = data;
  }
  if (!files["WORDS.TOK"]) throw new Error("The game is missing WORDS.TOK.");
  const container = openContainer(new Map(Object.entries(files)));
  // Validate the boot resource now. Some playable local games have dangling
  // references to unused assets; preserve those bytes rather than refusing
  // the whole game. Referenced resources are checked when the engine loads them.
  const boot = container.getResource("logic", 0);
  if (!boot) throw new Error("The game is missing its starting logic (logic 0).");
  parseLogicResource(boot);
  const words: [string, number][] = parseWordsTok(files["WORDS.TOK"]).map(({ word, id }) => [
    word,
    id,
  ]);
  let title: string | undefined;
  let roomGeneration = false;
  const metadata = entries.get(`${root}GAME.JSON`);
  if (metadata && metadata.length < 16384) {
    try {
      const parsed = JSON.parse(decoder.decode(metadata));
      if (parsed.format === "monotio.agi" && typeof parsed.title === "string")
        title = parsed.title.slice(0, 160);
      roomGeneration = parsed.roomGeneration === true;
    } catch {
      /* Optional metadata is not needed to play the game. */
    }
  }
  const projectBytes = entries.get(`${root}PROJECT.JSON`);
  const project = projectBytes ? readProjectContext(projectBytes, entries, root) : undefined;
  return {
    files,
    words,
    roomGeneration,
    ...(project ? { project } : {}),
    ...(title ? { title } : {}),
  };
}

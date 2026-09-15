/**
 * Undo the v2 AGI loader's scrambling so the interpreter disassembles cleanly:
 *
 *   node --experimental-strip-types scripts/descramble-agi.ts games/kq3 /tmp/kq3-agi.bin
 *   ndisasm -b 16 -e 0x200 /tmp/kq3-agi.bin > /tmp/kq3-agi.asm
 *
 * The v2 `AGI` executable is stored XORed per 128-byte block with the
 * 128-byte key at the loader's offset 0x41; between blocks each key byte
 * rotates right, the low bit chaining from byte 0 forward into the next
 * byte's high bit. The final carry is ORed into byte 0 and retained for the
 * next block. The first block starts with carry clear. This is not a simple
 * rotate. See docs/fidelity.md for original-loader execution evidence.
 * Already decoded MZ executables are copied unchanged.
 *
 * The loader is `SIERRA.COM` on most installations; others ship a
 * game-specific `*.COM` (KQ1.COM, …). Pass it as an optional third argument
 * when enumeration is ambiguous. Output goes to a scratch path of your
 * choice; decoded binaries and disassemblies are Sierra data and must never
 * be committed.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Decode the v2 loader's 128-byte evolving XOR key. See docs/fidelity.md. */
export function descrambleAgi(data: Uint8Array, initialKey: Uint8Array): Uint8Array {
  if (initialKey.length !== 128) throw new Error("AGI loader key must be 128 bytes.");
  const key = initialKey.slice();
  const out = new Uint8Array(data.length);
  let carry = 0;
  for (let block = 0; block * 128 < data.length; block++) {
    for (let i = 0; i < 128 && block * 128 + i < data.length; i++)
      out[block * 128 + i] = data[block * 128 + i]! ^ key[i]!;
    for (let i = 0; i < 128; i++) {
      const next = key[i]! & 1;
      key[i] = (key[i]! >> 1) | (carry << 7);
      carry = next;
    }
    // The loader ORs the final carry into key[0], and its saved flags retain
    // that same carry for the first RCR of the following block.
    key[0] = key[0]! | (carry << 7);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [gameDir, outPath, loaderArg] = process.argv.slice(2);
  if (!gameDir || !outPath) {
    process.stderr.write(`usage: descramble-agi.ts <game dir> <output.bin> [loader.COM]\n`);
    process.exit(1);
  }

  const names = readdirSync(gameDir);
  const agiName = names.find((name) => name.toUpperCase() === "AGI");
  if (!agiName) throw new Error(`No AGI interpreter found in ${gameDir}`);
  const data = readFileSync(`${gameDir}/${agiName}`);
  if (data[0] === 0x4d && data[1] === 0x5a) {
    writeFileSync(outPath, data);
    process.stdout.write(`${gameDir}/${agiName} is already MZ -> ${outPath}\n`);
    process.exit(0);
  }

  let loaderName = loaderArg;
  if (!loaderName) {
    const candidates = names.filter((name) => /\.COM$/i.test(name)).sort();
    const sierra = candidates.find((name) => name.toUpperCase() === "SIERRA.COM");
    loaderName = sierra ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!loaderName) {
      process.stderr.write(
        candidates.length === 0
          ? `no loader (*.COM) found in ${gameDir}\n`
          : `several loaders in ${gameDir}: ${candidates.join(", ")} — pass one as the third argument\n`,
      );
      process.exit(1);
    }
  }

  const loader = readFileSync(`${gameDir}/${loaderName}`);
  const out = descrambleAgi(data, loader.subarray(0x41, 0x41 + 128));
  if (out[0] !== 0x4d || out[1] !== 0x5a)
    throw new Error("Decoded interpreter is not MZ; check the loader key source.");
  const headerSize = (out[8]! | (out[9]! << 8)) * 16;
  const banner = new TextDecoder("latin1").decode(out.subarray(headerSize, headerSize + 256));
  if (!banner.startsWith("Adventure Game Interpreter"))
    throw new Error("Decoded interpreter banner is invalid; check the loader key source.");
  writeFileSync(outPath, out);
  process.stdout.write(`${gameDir}/AGI descrambled with ${loaderName} -> ${outPath}\n`);
}

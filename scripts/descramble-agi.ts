/**
 * Undo the v2 AGI loader's scrambling so the interpreter disassembles cleanly:
 *
 *   node --experimental-strip-types scripts/descramble-agi.ts games/kq3 /tmp/kq3-agi.bin
 *   ndisasm -b 16 -e 0x200 /tmp/kq3-agi.bin > /tmp/kq3-agi.asm
 *
 * The v2 `AGI` executable is stored XORed per 128-byte block with the
 * 128-byte key at the loader's (`SIERRA.COM`, or the game's own `*.COM`)
 * offset 0x41; between blocks each key byte rotates right, the low bit
 * chaining from byte 0 forward into the next byte's high bit (byte 0's own
 * low bit folds back into its high bit; byte 127's low bit falls off). v3
 * executables are not scrambled.
 *
 * Output goes to a scratch path of your choice; decoded binaries and
 * disassemblies are Sierra data and must never be committed.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [gameDir, outPath] = process.argv.slice(2);
if (!gameDir || !outPath) {
  process.stderr.write(`usage: descramble-agi.ts <game dir> <output.bin>\n`);
  process.exit(1);
}

const loaderName = ["SIERRA.COM", "KQ1.COM"].find((name) => {
  try {
    readFileSync(`${gameDir}/${name}`);
    return true;
  } catch {
    return false;
  }
});
if (!loaderName) {
  process.stderr.write(`no loader (*.COM) found in ${gameDir}\n`);
  process.exit(1);
}

const loader = readFileSync(`${gameDir}/${loaderName}`);
const key = Array.from(loader.subarray(0x41, 0x41 + 128));
const data = readFileSync(`${gameDir}/AGI`);
const out = Buffer.alloc(data.length);
for (let block = 0; block * 128 < data.length; block++) {
  for (let i = 0; i < 128 && block * 128 + i < data.length; i++)
    out[block * 128 + i] = data[block * 128 + i]! ^ key[i]!;
  let carry = key[0]! & 1;
  for (let i = 0; i < 128; i++) {
    const next = key[i]! & 1;
    key[i] = (key[i]! >> 1) | (carry << 7);
    carry = next;
  }
}

// A correct decode shows the interpreter banner right after the 0x200 header
// (its first byte is scrambled in the shipped files, so match from "Game").
const banner = out.subarray(0x200, 0x400).toString("latin1");
if (!banner.includes("Game Interpreter"))
  process.stderr.write(`warning: no interpreter banner found; check the loader key source\n`);
writeFileSync(outPath, out);
process.stdout.write(`${gameDir}/AGI descrambled with ${loaderName} -> ${outPath}\n`);

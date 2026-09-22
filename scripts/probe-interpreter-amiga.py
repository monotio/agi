#!/usr/bin/env python3
"""Inspect local Amiga AGI interpreters and resource containers.

Amiga executables are Amiga Hunk files (magic 0x000003f3): a header naming
resident libraries, a hunk-size table, then per-hunk CODE/DATA/BSS payloads
followed by relocation and other meta tags. Relocation bodies are
(count, target_hunk, offset...) groups; listed longword slots hold 0 in the
file and are patched at load time, so absolute operands must be resolved
through this table.

Container formats verified against local fixtures: `dirs` is the standard v3
combined directory (u16le[4] section offsets then 3-byte entries); GR/PQ1
vols use 7-byte v3-style record headers with dictionary/picture compression;
KQ2 uses 5-byte v2-style record headers, uncompressed.

Original interpreter/game bytes stay local; the script bundles none.
Subcommands:

  info      hunk table summary
  names     dump the embedded opcode name table (index == opcode)
  dispatch  locate action/condition dispatchers and their tables (capstone)
  census    walk every LOGIC resource, count action opcode usage
  extract   write one decompressed resource to a file

The census walker decodes linearly. A `quit` whose 0xff operand doubles as
the next `if` marker (SQ1 logic 99) desyncs such a walk: counts of late
opcodes stay reliable, stray high-byte tests are artifacts of that quirk.
"""
import argparse
import struct
import sys
from pathlib import Path

HUNK_TAGS = {0x3E7, 0x3E8, 0x3E9, 0x3EA, 0x3EB, 0x3EC, 0x3ED, 0x3EE,
             0x3EF, 0x3F0, 0x3F1, 0x3F2, 0x3F5, 0x3FC}
HUNK_CODE, HUNK_DATA, HUNK_BSS = 0x3E9, 0x3EA, 0x3EB


def u32(b, o):
    return struct.unpack_from(">I", b, o)[0]


def parse_hunks(path):
    """Return (hunks, image_size). hunk = {i, t, size, data, fileoff, base,
    reloc32}; reloc32 maps offset-in-hunk -> target hunk index."""
    d = Path(path).read_bytes()
    if u32(d, 0) != 0x3F3:
        raise SystemExit(f"{path}: not an Amiga Hunk executable")
    off = 4
    while u32(d, off) != 0:
        off += u32(d, off) * 4
    off += 4
    table_size, first, last = u32(d, off), u32(d, off + 4), u32(d, off + 8)
    off += 12
    sizes = [u32(d, off + i * 4) & 0x3FFFFFFF for i in range(table_size)]
    pos = off + table_size * 4
    hunks = []
    for i in range(first, last + 1):
        want = sizes[i] * 4
        while pos + 8 <= len(d):
            t = u32(d, pos) & 0x3FFFFFFF
            sz = u32(d, pos + 4) & 0x3FFFFFFF
            if t in (HUNK_CODE, HUNK_DATA, HUNK_BSS) and sz * 4 == want:
                break
            pos += 4
        data = b"" if t == HUNK_BSS else d[pos + 8:pos + 8 + want]
        h = {"i": i, "t": t, "size": want, "data": data,
             "fileoff": pos + 8, "reloc32": {}}
        hunks.append(h)
        pos = pos + 8 + (0 if t == HUNK_BSS else want)
        # Walk meta tags until the next CODE/DATA/BSS hunk or EOF.
        while pos + 8 <= len(d):
            t = u32(d, pos) & 0x3FFFFFFF
            if t in (HUNK_CODE, HUNK_DATA, HUNK_BSS):
                break
            pos += 4
            if t == 0x3F2:  # HUNK_END
                continue
            if t in (0x3EC, 0x3F0, 0x3F1, 0x3F5):  # reloc32/dreloc/reloc8/ext
                esz = {0x3EC: 4, 0x3F0: 2, 0x3F1: 1, 0x3F5: 2}[t]
                while pos + 4 <= len(d):
                    n = u32(d, pos)
                    if n == 0 or n in HUNK_TAGS:
                        break
                    pos += 4
                    hn = u32(d, pos)
                    pos += 4
                    for k in range(n):
                        o = u32(d, pos + k * 4)
                        if t == 0x3EC:
                            h["reloc32"][o] = hn
                    pos += n * 4
                if pos + 4 <= len(d) and u32(d, pos) == 0:
                    pos += 4
                continue
            if t in (0x3ED, 0x3E8, 0x3E7, 0x3EE):  # reloc16, symbols, name, reloc8?
                pos += 4 + u32(d, pos) * 4
                continue
            break
    base = 0
    for h in hunks:
        h["base"] = base
        base += h["size"]
    return hunks, base


def find_opcode_names(hunks):
    """Return the embedded action-name table (index == opcode) or []."""
    best = []
    for h in hunks:
        d = h["data"]
        idx = d.find(b"increment\x00")
        if idx < 0:
            continue
        s = idx
        while s > 0 and (d[s - 1] == 0 or 32 <= d[s - 1] < 127):
            s -= 1
        pos, out = s, []
        while pos < len(d):
            e = d.find(b"\x00", pos)
            if e < 0:
                break
            w = d[pos:e]
            if not w or not all(32 <= c < 127 for c in w):
                break
            out.append(w.decode())
            pos = e + 1
        if len(out) > len(best):
            best = out
    return best


def expand_dictionary(stored, length):
    """AGI dictionary (LZW, LSB-first) expansion; mirrors container.ts."""
    out = bytearray()
    dic, bit, width, nxt, prev, init = {}, 0, 9, 0x102, None, False
    while True:
        if bit + width > len(stored) * 8:
            raise ValueError("truncated dictionary stream")
        code = 0
        for i in range(width):
            code |= ((stored[bit >> 3] >> (bit & 7)) & 1) << i
            bit += 1
        if not init and code != 0x100:
            raise ValueError("stream must start with reset")
        if code == 0x100:
            init, dic, nxt, width, prev = True, {}, 0x102, 9, None
            continue
        if code == 0x101:
            break
        if code < 0x100:
            cur = bytes([code])
        elif code < nxt:
            cur = dic[code]
        elif code == nxt and prev is not None:
            cur = prev + prev[:1]
        else:
            raise ValueError(f"invalid code {code:#x}")
        if len(out) + len(cur) > length:
            raise ValueError("expansion exceeds declared length")
        out += cur
        if prev is not None:
            dic[nxt] = prev + cur[:1]
            nxt += 1
            if nxt in (0x200, 0x400):
                width += 1
        prev = cur
    if len(out) != length:
        raise ValueError("expanded length mismatch")
    return bytes(out)


def expand_picture(stored, length):
    """AGI v3 picture nibble expansion; mirrors container.ts."""
    out, nib, color = bytearray(), 0, False

    def rd():
        nonlocal nib
        v = (stored[nib >> 1] >> (0 if nib & 1 else 4)) & 15
        nib += 1
        return v

    while True:
        v = rd() if color else (rd() << 4) | rd()
        if len(out) >= length:
            raise ValueError("expansion exceeds declared length")
        out.append(v)
        color = v in (0xF0, 0xF2)
        if v == 0xFF:
            break
    if len(out) != length:
        raise ValueError("expanded length mismatch")
    return bytes(out)


# Action operand counts per opcode — mirrors src/logic/opcodes.ts ACTIONS +
# V3_ACTIONS plus the observed Amiga-only 0xb6 (adj.ego.move.to.x.y, 2 operands).
ACTION_OPS = {
    0x01: 1, 0x02: 1, 0x03: 2, 0x04: 2, 0x05: 2, 0x06: 2, 0x07: 2, 0x08: 2,
    0x09: 2, 0x0A: 2, 0x0B: 2, 0x0C: 1, 0x0D: 1, 0x0E: 1, 0x0F: 1, 0x10: 1,
    0x11: 1, 0x12: 1, 0x13: 1, 0x14: 1, 0x15: 1, 0x16: 1, 0x17: 1, 0x18: 1,
    0x19: 1, 0x1A: 0, 0x1B: 1, 0x1C: 1, 0x1D: 0, 0x1E: 1, 0x1F: 1, 0x20: 1,
    0x21: 1, 0x22: 0, 0x23: 1, 0x24: 1, 0x25: 3, 0x26: 3, 0x27: 3, 0x28: 3,
    0x29: 2, 0x2A: 2, 0x2B: 2, 0x2C: 2, 0x2D: 1, 0x2E: 1, 0x2F: 2, 0x30: 2,
    0x31: 2, 0x32: 2, 0x33: 2, 0x34: 2, 0x35: 2, 0x36: 2, 0x37: 2, 0x38: 1,
    0x39: 2, 0x3A: 1, 0x3B: 1, 0x3C: 1, 0x3D: 1, 0x3E: 1, 0x3F: 1, 0x40: 1,
    0x41: 1, 0x42: 1, 0x43: 1, 0x44: 1, 0x45: 3, 0x46: 1, 0x47: 1, 0x48: 1,
    0x49: 2, 0x4A: 1, 0x4B: 2, 0x4C: 2, 0x4D: 1, 0x4E: 1, 0x4F: 2, 0x50: 2,
    0x51: 5, 0x52: 5, 0x53: 3, 0x54: 1, 0x55: 1, 0x56: 2, 0x57: 2, 0x58: 1,
    0x59: 1, 0x5A: 4, 0x5B: 0, 0x5C: 1, 0x5D: 1, 0x5E: 1, 0x5F: 2, 0x60: 2,
    0x61: 2, 0x62: 1, 0x63: 2, 0x64: 0, 0x65: 1, 0x66: 1, 0x67: 3, 0x68: 3,
    0x69: 3, 0x6A: 0, 0x6B: 0, 0x6C: 1, 0x6D: 2, 0x6E: 1, 0x6F: 3, 0x70: 0,
    0x71: 0, 0x72: 2, 0x73: 5, 0x74: 2, 0x75: 1, 0x76: 2, 0x77: 0, 0x78: 0,
    0x79: 3, 0x7A: 7, 0x7B: 7, 0x7C: 0, 0x7D: 0, 0x7E: 0, 0x7F: 0, 0x80: 0,
    0x81: 1, 0x82: 3, 0x83: 0, 0x84: 0, 0x85: 1, 0x86: 1, 0x87: 0, 0x88: 0,
    0x89: 0, 0x8A: 0, 0x8B: 0, 0x8C: 0, 0x8D: 0, 0x8E: 1, 0x8F: 1, 0x90: 1,
    0x91: 0, 0x92: 0, 0x93: 3, 0x94: 3, 0x95: 0, 0x96: 3, 0x97: 4, 0x98: 4,
    0x99: 1, 0x9A: 5, 0x9B: 2, 0x9C: 1, 0x9D: 2, 0x9E: 0, 0x9F: 1, 0xA0: 1,
    0xA1: 0, 0xA2: 1, 0xA3: 0, 0xA4: 0, 0xA5: 2, 0xA6: 2, 0xA7: 2, 0xA8: 2,
    0xA9: 0, 0xAA: 1, 0xAB: 0, 0xAC: 0, 0xAD: 0, 0xAE: 1, 0xAF: 0, 0xB0: 0,
    0xB1: 1, 0xB2: 0, 0xB3: 4, 0xB4: 2, 0xB5: 0, 0xB6: 2,
}
# Condition operand counts; "said" (0x0e) is variable length, special-cased.
COND_OPS = {
    0x00: 0, 0x01: 2, 0x02: 2, 0x03: 2, 0x04: 2, 0x05: 2, 0x06: 2, 0x07: 1,
    0x08: 1, 0x09: 1, 0x0A: 2, 0x0B: 5, 0x0C: 1, 0x0D: 0, 0x0E: 0, 0x0F: 2,
    0x10: 5, 0x11: 5, 0x12: 5,
}


class Container:
    """Amiga dir+vol container. kind: 0=logic 1=picture 2=view 3=sound."""

    def __init__(self, folder):
        self.base = Path(folder)
        files = {p.name.lower(): p for p in self.base.iterdir()}
        self.vols = {}
        for name, p in files.items():
            for n in range(16):
                if name.endswith(f"vol.{n}") or name == f"vol.{n}":
                    self.vols[n] = p.read_bytes()
        self.sections = []
        if "dirs" in files:
            d = files["dirs"].read_bytes()
            hdr = struct.unpack_from("<4H", d, 0)
            for i in range(4):
                end = hdr[i + 1] if i + 1 < 4 else len(d)
                self.sections.append(d[hdr[i]:end])
        else:
            for nm in ("logdir", "picdir", "viewdir", "snddir"):
                self.sections.append(
                    files[nm].read_bytes() if nm in files else b"")
        self.hdr7 = self._detect_hdr7()

    def _entry(self, kind, num):
        sec = self.sections[kind]
        if num * 3 + 3 > len(sec):
            return None
        e = sec[num * 3:num * 3 + 3]
        if e[0] >> 4 == 15:
            return None
        return e

    def _detect_hdr7(self):
        """Decide 7-byte (v3-style, maybe compressed) vs 5-byte (v2-style,
        stored-size only) record headers by which interpretation yields a
        structurally valid LOGIC resource."""
        for num in range(256):
            e = self._entry(0, num)
            if e is None:
                continue
            v, ofs = e[0] >> 4, ((e[0] & 15) << 16) | (e[1] << 8) | e[2]
            data = self.vols[v]
            if u32(data, ofs) >> 16 != 0x1234:
                continue
            ln, st = struct.unpack_from("<HH", data, ofs + 3)
            try:
                if self._logic_sane(expand_dictionary(
                        data[ofs + 7:ofs + 7 + st], ln)):
                    return True
            except ValueError:
                pass
            if self._logic_sane(data[ofs + 5:ofs + 5 + ln]):
                return False
        return True

    @staticmethod
    def _logic_sane(pay):
        if len(pay) < 4:
            return False
        cl, = struct.unpack_from("<H", pay, 0)
        if cl == 0 or 2 + cl >= len(pay):
            return False
        mc = pay[2 + cl]
        return 2 + cl + 1 + 2 * (mc + 1) <= len(pay)

    def read(self, kind, num):
        e = self._entry(kind, num)
        if e is None:
            return None
        v, ofs = e[0] >> 4, ((e[0] & 15) << 16) | (e[1] << 8) | e[2]
        data = self.vols[v]
        if u32(data, ofs) >> 16 != 0x1234:
            raise ValueError(f"bad record magic for {kind}[{num}]")
        meta = data[ofs + 2]
        ln, = struct.unpack_from("<H", data, ofs + 3)
        if not self.hdr7:
            return data[ofs + 5:ofs + 5 + ln]
        st, = struct.unpack_from("<H", data, ofs + 5)
        stored = data[ofs + 7:ofs + 7 + st]
        if meta & 0x80:
            return expand_picture(stored, ln)
        return expand_dictionary(stored, ln) if st != ln else stored


def walk_code(code):
    """Sequentially decode a LOGIC code section; return opcode histograms."""
    counts, conds, i, n = {}, {}, 0, len(code)
    while i < n:
        op = code[i]
        i += 1
        if op in (0x00, 0xFD, 0xFC):
            counts[op] = counts.get(op, 0) + 1
            continue
        if op == 0xFE:
            i += 2
            continue
        if op == 0xFF:
            while i < n:
                c = code[i]
                i += 1
                if c == 0xFF:
                    break
                if c in (0xFD, 0xFC):
                    continue
                conds[c] = conds.get(c, 0) + 1
                if c == 0x0E:
                    i += 1 + code[i] * 2
                    continue
                i += COND_OPS.get(c, 0)
            i += 2
            continue
        counts[op] = counts.get(op, 0) + 1
        if op not in ACTION_OPS:
            return counts, conds, f"unknown op {op:#x} at {i - 1}"
        i += ACTION_OPS[op]
    return counts, conds, None


def cmd_info(args):
    hunks, total = parse_hunks(args.exe)
    kinds = {HUNK_CODE: "code", HUNK_DATA: "data", HUNK_BSS: "bss"}
    print(f"{args.exe}: {len(hunks)} hunks, image 0x{total:x}")
    for h in hunks:
        print(f"  h{h['i']:<4} {kinds.get(h['t'], h['t']):<4} "
              f"base=0x{h['base']:<6x} size=0x{h['size']:<6x} "
              f"relocs={len(h['reloc32'])}")


def cmd_names(args):
    hunks, _ = parse_hunks(args.exe)
    for i, name in enumerate(find_opcode_names(hunks)):
        print(f"0x{i:02x} {name}")


def cmd_dispatch(args):
    try:
        import capstone
    except ImportError:
        raise SystemExit("dispatch needs capstone (pip install capstone)")
    hunks, _ = parse_hunks(args.exe)
    md = capstone.Cs(capstone.CS_ARCH_M68K, capstone.CS_MODE_M68K_000)
    for h in hunks:
        if h["t"] != HUNK_CODE:
            continue
        insns = list(md.disasm(h["data"], h["base"]))
        for i, ins in enumerate(insns):
            if ins.mnemonic == "jsr" and ins.op_str.strip() == "(a0)":
                ctx = insns[max(0, i - 10):i]
                if any("movea" in c.mnemonic and ",d" in c.op_str.replace(" ", "")
                       for c in ctx):
                    print(f"dispatcher h{h['i']} @0x{ins.address:#x}")
                    for j in ctx:
                        print(f"  {j.address:#x}: {j.mnemonic} {j.op_str}")


def cmd_census(args):
    c = Container(args.folder)
    use, cuse, bad = {}, {}, []
    for num in range(256):
        try:
            pay = c.read(0, num)
        except Exception as ex:
            bad.append((num, str(ex)))
            continue
        if pay is None:
            continue
        cl, = struct.unpack_from("<H", pay, 0)
        code = pay[2:2 + cl]
        cnt, cnd, err = walk_code(code)
        if err:
            bad.append((num, err))
        for k, v in cnt.items():
            use[k] = use.get(k, 0) + v
        for k, v in cnd.items():
            cuse[k] = cuse.get(k, 0) + v
    for op in sorted(use):
        print(f"action 0x{op:02x}: {use[op]}")
    for op in sorted(cuse):
        print(f"test   0x{op:02x}: {cuse[op]}")
    for num, err in bad:
        print(f"logic {num}: {err}", file=sys.stderr)


def cmd_extract(args):
    c = Container(args.folder)
    pay = c.read(args.kind, args.num)
    if pay is None:
        raise SystemExit("resource absent")
    Path(args.out).write_bytes(pay)
    print(f"wrote {len(pay)} bytes to {args.out}")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("info", "names", "dispatch"):
        s = sub.add_parser(name)
        s.add_argument("exe", type=Path)
        s.set_defaults(fn={"info": cmd_info, "names": cmd_names,
                           "dispatch": cmd_dispatch}[name])
    s = sub.add_parser("census")
    s.add_argument("folder", type=Path)
    s.set_defaults(fn=cmd_census)
    s = sub.add_parser("extract")
    s.add_argument("folder", type=Path)
    s.add_argument("kind", type=int, help="0=logic 1=picture 2=view 3=sound")
    s.add_argument("num", type=int)
    s.add_argument("out", type=Path)
    s.set_defaults(fn=cmd_extract)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()

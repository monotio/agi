#!/usr/bin/env python3
"""Inspect the local Apple IIgs AGI interpreter and its resources.

SQ2.SYS16 is a GS/OS load file (ProDOS S16): a sequence of OMF segment
records with the OMF v2 header (version byte 2 at +0x0f):
bytecnt/respc/length longs, lablen/numlen/version bytes, banksize long,
kind word, org/align longs, numsex byte, segnum word at +0x22, entry long,
dispname/dispdata words. The body holds LCONST (0xf2 + u32 count + data),
DS (0xf1 + u32 count, zero fill) and trailing SUPER compressed relocation
records (0xf7 + u32 size + type byte + data) before the END (0x00) record.

Absolute operands in the file are link-time values; the GS/OS loader
patches them from the SUPER records at load, so cross-segment references
disassembled here are indicative, not load addresses.

py65 ships no real 65816 (mpu65org16 is a soft-core 6502 derivative), and
capstone's MOS65XX_65816 modes take a static M/X setting, so mode-dependent
immediate lengths desync at every REP/SEP. This script therefore carries a
small purpose-built decoder that tracks the M/X flags through SEP/REP; it
covers the full 65816 opcode map for linear decoding.

Original interpreter/game bytes stay local; the script bundles none.

Subcommands:

  info      OMF segment table (names, kinds, sizes, entry)
  strings   printable strings with file offsets
  segment   hex+disasm dump of one segment's loaded image
  dispatch  locate jump-table dispatchers (jmp/jsr (abs,X) etc.) and the
            opcode bound compares in the logic interpreter
  snd       dump an IIgs sound resource (delta-time + MIDI-like events)
  census    walk every LOGIC resource, count action opcode usage
"""
import argparse
import struct
import sys
from pathlib import Path

# ---------------------------------------------------------------- OMF ----

BODY_OPS = {0xF1: "DS", 0xF2: "LCONST"}


def parse_omf(path):
    """Return list of segments: {i, segnum, name, kind, length, respc,
    fileoff, ddata, image, lconsts:[(segofs,fileoff,len)]}.
    image is the loaded segment content (LCONST data + DS zeros), keyed by
    segment offset."""
    d = Path(path).read_bytes()
    pos, segs = 0, []
    while pos < len(d):
        bytecnt, respc, length = struct.unpack_from("<III", d, pos)
        if bytecnt == 0 or pos + bytecnt > len(d):
            break
        lablen, numlen, version = d[pos + 0x0D], d[pos + 0x0E], d[pos + 0x0F]
        banksize, kind = struct.unpack_from("<IH", d, pos + 0x10)
        org, align = struct.unpack_from("<II", d, pos + 0x18)
        numsex = d[pos + 0x20]
        segnum = struct.unpack_from("<H", d, pos + 0x22)[0]
        entry, dname, ddata = struct.unpack_from("<IHH", d, pos + 0x24)
        name = d[pos + dname:pos + dname + 10].decode("ascii", "replace").strip()
        image = bytearray(length)
        lconsts = []
        p = pos + ddata
        end = pos + bytecnt
        segofs = 0
        while p < end:
            op = d[p]
            if op == 0x00:
                break
            if op in (0xF1, 0xF2):
                cnt = struct.unpack_from("<I", d, p + 1)[0]
                if op == 0xF2:
                    if segofs + cnt <= length:
                        image[segofs:segofs + cnt] = d[p + 5:p + 5 + cnt]
                    lconsts.append((segofs, p + 5, cnt))
                segofs += cnt
                p += 5 + (cnt if op == 0xF2 else 0)
            elif op == 0xF7:  # SUPER compressed relocation record
                size = struct.unpack_from("<I", d, p + 1)[0]
                p += 5 + size
            else:  # other record (cRELOC f5 etc.): skip conservatively
                if op == 0xF5:
                    size = struct.unpack_from("<H", d, p + 1)[0]
                    p += 3 + size
                else:
                    p += 1
        segs.append({
            "i": len(segs), "segnum": segnum, "name": name, "kind": kind,
            "length": length, "respc": respc, "fileoff": pos,
            "entry": entry, "image": bytes(image), "lconsts": lconsts,
            "banksize": banksize, "align": align, "lablen": lablen,
            "numlen": numlen, "version": version, "numsex": numsex, "ddata": ddata,
        })
        pos += bytecnt
    return segs


# ------------------------------------------------------- 65816 decoder ----
# (mnemonic, addressing mode). Immediate modes ending in M/X scale with the
# processor flags. Built from the WDC 65816 opcode matrix.

IM, ACC, D, DX, DY = "imp", "acc", "dp", "dpx", "dpy"
A, AX, AY, AL, ALX = "abs", "absx", "absy", "absl", "abslx"
DI, DXI, DYI, DL, DLY = "dpi", "dpxi", "dpyi", "dpl", "dply"
SR, SRY = "sr", "sriy"
R8, R16, BM = "rel8", "rel16", "blk"
IMM, IMX, I8 = "immm", "immx", "imm8"
JXI, JI, JIL = "jmpaxi", "jmpi", "jmpil"

OPS = {
    0x00: ("brk", I8), 0x01: ("ora", DXI), 0x02: ("cop", I8), 0x03: ("ora", SR),
    0x04: ("tsb", D), 0x05: ("ora", D), 0x06: ("asl", D), 0x07: ("ora", DL),
    0x08: ("php", IM), 0x09: ("ora", IMM), 0x0A: ("asl", ACC), 0x0B: ("phd", IM),
    0x0C: ("tsb", A), 0x0D: ("ora", A), 0x0E: ("asl", A), 0x0F: ("ora", AL),
    0x10: ("bpl", R8), 0x11: ("ora", DYI), 0x12: ("ora", DI), 0x13: ("ora", SRY),
    0x14: ("trb", D), 0x15: ("ora", DX), 0x16: ("asl", DX), 0x17: ("ora", DLY),
    0x18: ("clc", IM), 0x19: ("ora", AY), 0x1A: ("inc", ACC), 0x1B: ("tcs", IM),
    0x1C: ("trb", A), 0x1D: ("ora", AX), 0x1E: ("asl", AX), 0x1F: ("ora", ALX),
    0x20: ("jsr", A), 0x21: ("and", DXI), 0x22: ("jsl", AL), 0x23: ("and", SR),
    0x24: ("bit", D), 0x25: ("and", D), 0x26: ("rol", D), 0x27: ("and", DL),
    0x28: ("plp", IM), 0x29: ("and", IMM), 0x2A: ("rol", ACC), 0x2B: ("pld", IM),
    0x2C: ("bit", A), 0x2D: ("and", A), 0x2E: ("rol", A), 0x2F: ("and", AL),
    0x30: ("bmi", R8), 0x31: ("and", DYI), 0x32: ("and", DI), 0x33: ("and", SRY),
    0x34: ("bit", DX), 0x35: ("and", DX), 0x36: ("rol", DX), 0x37: ("and", DLY),
    0x38: ("sec", IM), 0x39: ("and", AY), 0x3A: ("dec", ACC), 0x3B: ("tsc", IM),
    0x3C: ("bit", AX), 0x3D: ("and", AX), 0x3E: ("rol", AX), 0x3F: ("and", ALX),
    0x40: ("rti", IM), 0x41: ("eor", DXI), 0x42: ("wdm", I8), 0x43: ("eor", SR),
    0x44: ("mvp", BM), 0x45: ("eor", D), 0x46: ("lsr", D), 0x47: ("eor", DL),
    0x48: ("pha", IM), 0x49: ("eor", IMM), 0x4A: ("lsr", ACC), 0x4B: ("phk", IM),
    0x4C: ("jmp", A), 0x4D: ("eor", A), 0x4E: ("lsr", A), 0x4F: ("eor", AL),
    0x50: ("bvc", R8), 0x51: ("eor", DYI), 0x52: ("eor", DI), 0x53: ("eor", SRY),
    0x54: ("mvn", BM), 0x55: ("eor", DX), 0x56: ("lsr", DX), 0x57: ("eor", DLY),
    0x58: ("cli", IM), 0x59: ("eor", AY), 0x5A: ("phy", IM), 0x5B: ("tcd", IM),
    0x5C: ("jmp", AL), 0x5D: ("eor", AX), 0x5E: ("lsr", AX), 0x5F: ("eor", ALX),
    0x60: ("rts", IM), 0x61: ("adc", DXI), 0x62: ("per", R16), 0x63: ("adc", SR),
    0x64: ("stz", D), 0x65: ("adc", D), 0x66: ("ror", D), 0x67: ("adc", DL),
    0x68: ("pla", IM), 0x69: ("adc", IMM), 0x6A: ("ror", ACC), 0x6B: ("rtl", IM),
    0x6C: ("jmp", JI), 0x6D: ("adc", A), 0x6E: ("ror", A), 0x6F: ("adc", AL),
    0x70: ("bvs", R8), 0x71: ("adc", DYI), 0x72: ("adc", DI), 0x73: ("adc", SRY),
    0x74: ("stz", DX), 0x75: ("adc", DX), 0x76: ("ror", DX), 0x77: ("adc", DLY),
    0x78: ("sei", IM), 0x79: ("adc", AY), 0x7A: ("ply", IM), 0x7B: ("tdc", IM),
    0x7C: ("jmp", JXI), 0x7D: ("adc", AX), 0x7E: ("ror", AX), 0x7F: ("adc", ALX),
    0x80: ("bra", R8), 0x81: ("sta", DXI), 0x82: ("brl", R16), 0x83: ("sta", SR),
    0x84: ("sty", D), 0x85: ("sta", D), 0x86: ("stx", D), 0x87: ("sta", DL),
    0x88: ("dey", IM), 0x89: ("bit", IMM), 0x8A: ("txa", IM), 0x8B: ("phb", IM),
    0x8C: ("sty", A), 0x8D: ("sta", A), 0x8E: ("stx", A), 0x8F: ("sta", AL),
    0x90: ("bcc", R8), 0x91: ("sta", DYI), 0x92: ("sta", DI), 0x93: ("sta", SRY),
    0x94: ("sty", DX), 0x95: ("sta", DX), 0x96: ("stx", DY), 0x97: ("sta", DLY),
    0x98: ("tya", IM), 0x99: ("sta", AY), 0x9A: ("txs", IM), 0x9B: ("txy", IM),
    0x9C: ("stz", A), 0x9D: ("sta", AX), 0x9E: ("stz", AX), 0x9F: ("sta", ALX),
    0xA0: ("ldy", IMX), 0xA1: ("lda", DXI), 0xA2: ("ldx", IMX), 0xA3: ("lda", SR),
    0xA4: ("ldy", D), 0xA5: ("lda", D), 0xA6: ("ldx", D), 0xA7: ("lda", DL),
    0xA8: ("tay", IM), 0xA9: ("lda", IMM), 0xAA: ("tax", IM), 0xAB: ("plb", IM),
    0xAC: ("ldy", A), 0xAD: ("lda", A), 0xAE: ("ldx", A), 0xAF: ("lda", AL),
    0xB0: ("bcs", R8), 0xB1: ("lda", DYI), 0xB2: ("lda", DI), 0xB3: ("lda", SRY),
    0xB4: ("ldy", DX), 0xB5: ("lda", DX), 0xB6: ("ldx", DY), 0xB7: ("lda", DLY),
    0xB8: ("clv", IM), 0xB9: ("lda", AY), 0xBA: ("tsx", IM), 0xBB: ("tyx", IM),
    0xBC: ("ldy", AX), 0xBD: ("lda", AX), 0xBE: ("ldx", AY), 0xBF: ("lda", ALX),
    0xC0: ("cpy", IMX), 0xC1: ("cmp", DXI), 0xC2: ("rep", I8), 0xC3: ("cmp", SR),
    0xC4: ("cpy", D), 0xC5: ("cmp", D), 0xC6: ("dec", D), 0xC7: ("cmp", DL),
    0xC8: ("iny", IM), 0xC9: ("cmp", IMM), 0xCA: ("dex", IM), 0xCB: ("wai", IM),
    0xCC: ("cpy", A), 0xCD: ("cmp", A), 0xCE: ("dec", A), 0xCF: ("cmp", AL),
    0xD0: ("bne", R8), 0xD1: ("cmp", DYI), 0xD2: ("cmp", DI), 0xD3: ("cmp", SRY),
    0xD4: ("pei", D), 0xD5: ("cmp", DX), 0xD6: ("dec", DX), 0xD7: ("cmp", DLY),
    0xD8: ("cld", IM), 0xD9: ("cmp", AY), 0xDA: ("phx", IM), 0xDB: ("stp", IM),
    0xDC: ("jmp", JIL), 0xDD: ("cmp", AX), 0xDE: ("dec", AX), 0xDF: ("cmp", ALX),
    0xE0: ("cpx", IMX), 0xE1: ("sbc", DXI), 0xE2: ("sep", I8), 0xE3: ("sbc", SR),
    0xE4: ("cpx", D), 0xE5: ("sbc", D), 0xE6: ("inc", D), 0xE7: ("sbc", DL),
    0xE8: ("inx", IM), 0xE9: ("sbc", IMM), 0xEA: ("nop", IM), 0xEB: ("xba", IM),
    0xEC: ("cpx", A), 0xED: ("sbc", A), 0xEE: ("inc", A), 0xEF: ("sbc", AL),
    0xF0: ("beq", R8), 0xF1: ("sbc", DYI), 0xF2: ("sbc", DI), 0xF3: ("sbc", SRY),
    0xF4: ("pea", A), 0xF5: ("sbc", DX), 0xF6: ("inc", DX), 0xF7: ("sbc", DLY),
    0xF8: ("sed", IM), 0xF9: ("sbc", AY), 0xFA: ("plx", IM), 0xFB: ("xce", IM),
    0xFC: ("jsr", JXI), 0xFD: ("sbc", AX), 0xFE: ("inc", AX), 0xFF: ("sbc", ALX),
}

MODE_LEN = {IM: 0, ACC: 0, D: 1, DX: 1, DY: 1, A: 2, AX: 2, AY: 2, AL: 3,
            ALX: 3, DI: 1, DXI: 1, DYI: 1, DL: 1, DLY: 1, SR: 1, SRY: 1,
            R8: 1, R16: 2, BM: 2, I8: 1, JI: 2, JXI: 2, JIL: 2}


def insn_len(op, mode, m, x):
    if mode == IMM:
        return 2 + (0 if m else 1)  # m=1 -> 8-bit operand
    if mode == IMX:
        return 2 + (0 if x else 1)
    return 1 + MODE_LEN[mode]


def fmt_operand(mode, data, m, x):
    """Render the operand bytes of an instruction (data = bytes after opcode)."""
    w = lambda b: f"${b:02x}"
    w2 = lambda lo, hi: f"${lo | hi << 8:04x}"
    w3 = lambda b: f"${b[0] | b[1] << 8 | b[2] << 16:06x}"
    if mode == IMM:
        return f"#{w2(data[0], data[1] if not m else 0) if not m else w(data[0])}"
    if mode == IMX:
        return f"#{w2(data[0], data[1] if not x else 0) if not x else w(data[0])}"
    if mode == I8:
        return f"#{w(data[0])}"
    if mode == D:
        return w(data[0])
    if mode == DX:
        return f"{w(data[0])},X"
    if mode == DY:
        return f"{w(data[0])},Y"
    if mode == A:
        return w2(data[0], data[1])
    if mode == AX:
        return f"{w2(data[0], data[1])},X"
    if mode == AY:
        return f"{w2(data[0], data[1])},Y"
    if mode == AL:
        return w3(data)
    if mode == ALX:
        return f"{w3(data)},X"
    if mode == DI:
        return f"({w(data[0])})"
    if mode == DXI:
        return f"({w(data[0])},X)"
    if mode == DYI:
        return f"({w(data[0])}),Y"
    if mode == DL:
        return f"[{w(data[0])}]"
    if mode == DLY:
        return f"[{w(data[0])}],Y"
    if mode == SR:
        return f"{w(data[0])},S"
    if mode == SRY:
        return f"({w(data[0])},S),Y"
    if mode == R8:
        return f"{struct.unpack('b', data[:1])[0]:+d}"
    if mode == R16:
        return f"{struct.unpack('<h', data[:2])[0]:+d}"
    if mode == BM:
        return f"{w(data[0])},{w(data[1])}"
    if mode == JI:
        return f"({w2(data[0], data[1])})"
    if mode == JXI:
        return f"({w2(data[0], data[1])},X)"
    if mode == JIL:
        return f"[{w2(data[0], data[1])}]"
    return ""


def disasm(image, start=0, count=None, m=1, x=1):
    """Linear-sweep decode of image[start:], tracking M/X through REP/SEP.
    Yields (offset, length, mnemonic, operand_text). Data bytes will desync a
    linear sweep; callers pick code regions."""
    pc = start
    n = 0
    while pc < len(image) and (count is None or n < count):
        op = image[pc]
        mn, mode = OPS[op]
        ln = insn_len(op, mode, m, x)
        operand = fmt_operand(mode, image[pc + 1:pc + ln].ljust(ln - 1, b"\x00"), m, x)
        yield pc, ln, mn, operand
        if op == 0xE2 and ln == 2:  # SEP
            fl = image[pc + 1]
            if fl & 0x20:
                m = 1
            if fl & 0x10:
                x = 1
        elif op == 0xC2 and ln == 2:  # REP
            fl = image[pc + 1]
            if fl & 0x20:
                m = 0
            if fl & 0x10:
                x = 0
        pc += ln
        n += 1


def find_segment(segs, ref):
    for s in segs:
        if s["name"].startswith(ref) or str(s["segnum"]) == ref or str(s["i"]) == ref:
            return s
    return None


# ------------------------------------------------------------- commands ----

def cmd_info(args):
    import hashlib
    d = Path(args.exe).read_bytes()
    print(f"{args.exe}: {len(d)} bytes sha256={hashlib.sha256(d).hexdigest()}")
    segs = parse_omf(args.exe)
    print(f"{len(segs)} OMF segment records")
    for s in segs:
        bss = " (bss)" if s["respc"] == s["length"] and s["length"] else ""
        print(f"  seg {s['segnum']:<3} @{s['fileoff']:>#7x} {s['name']:<12}"
              f"len=0x{s['length']:<6x} kind=0x{s['kind']:04x} "
              f"entry=0x{s['entry']:x} lconsts={len(s['lconsts'])}{bss}")
    for needle in (b"Version ", b"Adventure Game Interpreter"):
        at = d.find(needle)
        if at >= 0:
            print(f"  version/id string at file 0x{at:x}: "
                  f"{d[at:at + 48].split(bytes([0]))[0]!r}")


def cmd_strings(args):
    d = Path(args.exe).read_bytes()
    start = None
    for i, b in enumerate(d + b"\x00"):
        if 32 <= b < 127:
            if start is None:
                start = i
        else:
            if start is not None and i - start >= args.min:
                print(f"{start:>6x}: {d[start:i].decode()}")
            start = None


def cmd_segment(args):
    segs = parse_omf(args.exe)
    s = find_segment(segs, args.ref)
    if s is None:
        raise SystemExit(f"no segment matching {args.ref}")
    img = s["image"]
    print(f"segment {s['segnum']} '{s['name']}' len=0x{len(img):x}")
    n = 0
    for off, ln, mn, operand in disasm(img, args.start, args.count,
                                     m=args.m, x=args.x):
        raw = img[off:off + ln].hex()
        print(f"{off:>6x}: {raw:<12} {mn} {operand}")
        n += 1
        if mn in ("rtl", "rts") and not args.past_end:
            pass


def cmd_dispatch(args):
    """Verify the logic-interpreter dispatch bounds and table sites.

    The action dispatcher lives in actionseg: the opcode is read through
    [$fd], masked to a byte, then `sbc #$00fc` and `sbc #$00b1` bound it.
    The condition evaluator lives in main: `cmp #$0013` gates a jsr (abs,X)
    into a 19-entry near table. The table slots are OMF-relocated, so the
    file image holds placeholders, not targets.
    """
    segs = parse_omf(args.exe)
    act = find_segment(segs, "actionseg")
    print("actionseg action dispatcher:")
    for off, ln, mn, operand in disasm(act["image"], m=0, x=0):
        if operand in ("#$00fc", "#$00b1") or mn in ("bvs", "beq", "bpl",
                                                    "brl", "jsl"):
            print(f"  +{off:#05x}: {mn} {operand}")
    print("  -> opcodes 0x01..0xb1 dispatch via 4-byte far-pointer table;")
    print("     0xb2..0xfb call errorseg (seg 9); 0x00 and >=0xfc return.")
    main_seg = segs[0]
    print("main condition evaluator (statement loop ~+0x191e):")
    for off, ln, mn, operand in disasm(main_seg["image"], m=0, x=0):
        if 0x1aaf <= off <= 0x1b10:
            print(f"  +{off:#05x}: {mn} {operand}")
    print("  -> conditions 0x00..0x13 (19 slots + slot 0); >0x13 -> errorseg.")
    print("  -> 0xfc/0xfd/0xfe/0xff are if/or/not/goto control bytes.")
    # toolbox census: ldx #$TTFF ; jsl $e10000/$e100a8
    from collections import Counter
    calls = Counter()
    for s in segs:
        insns = list(disasm(s["image"], m=0, x=0))
        for i, (off, ln, mn, operand) in enumerate(insns):
            if operand in ("$e10000", "$e100a8"):
                xv = None
                for j in range(i - 1, max(-1, i - 4), -1):
                    if insns[j][2] == "ldx" and insns[j][3].startswith("#"):
                        xv = int(insns[j][3][2:], 16)
                        break
                calls[xv] += 1
    print("IIgs toolbox calls (ldx #toolnum<<8|fn; jsl $e10000/$e100a8):")
    for xv in sorted(c for c in calls if c is not None):
        print(f"  toolset 0x{xv >> 8:02x} fn 0x{xv & 0xff:02x}: x{calls[xv]}")
    print(f"  (unresolved tool number: x{calls[None]})")


def op_is_indexed_jump(img, off):
    return img[off] in (0x7C, 0xFC)


def hexdump(data, base=0):
    for i in range(0, len(data), 16):
        row = data[i:i + 16]
        asc = "".join(chr(b) if 32 <= b < 127 else "." for b in row)
        print(f"{base + i:>6x}: {row.hex(' '):<48} {asc}")


class V2Container:
    """Plain v2 split container: 3-byte dir entries, 5-byte record headers."""

    def __init__(self, folder):
        self.base = Path(folder)
        files = {p.name.lower(): p for p in self.base.iterdir()}
        self.vols = {n: files[f"vol.{n}"].read_bytes()
                     for n in range(15) if f"vol.{n}" in files}
        self.dirs = {nm: files[nm].read_bytes()
                     for nm in ("logdir", "picdir", "viewdir", "snddir")
                     if nm in files}

    def read(self, kind, num):
        d = self.dirs[kind]
        e = d[num * 3:num * 3 + 3]
        if len(e) < 3 or e[0] >> 4 == 15:
            return None
        vol, ofs = e[0] >> 4, ((e[0] & 15) << 16) | (e[1] << 8) | e[2]
        data = self.vols[vol]
        if ofs + 5 > len(data):
            return None  # corrupt directory entry
        ln = struct.unpack_from("<H", data, ofs + 3)[0]
        return data[ofs + 5:ofs + 5 + ln]


def cmd_snd(args):
    c = V2Container(args.folder)
    pay = c.read("snddir", args.num)
    if pay is None:
        raise SystemExit("sound absent")
    print(f"sound {args.num}: {len(pay)} bytes, type byte 0x{pay[0]:02x}")
    if pay[0] == 0x01:
        # [01][00][3 x u16le channel-stream offsets][setup block][streams]
        offs = struct.unpack_from("<HHH", pay, 2)
        print(f"  type 1: flag={pay[1]:#04x} stream offsets "
              f"{offs[0]:#x} {offs[1]:#x} {offs[2]:#x}")
        hexdump(pay[:96])
    elif pay[0] == 0x02:
        # [02][u16le][status + data bytes + delta byte] repeating
        print("  type 2: MIDI-like stream (status + data, then delta):")
        i, shown = 3, 0
        while i < len(pay) and shown < args.max_events:
            st = pay[i]
            nbytes = {0x8: 2, 0x9: 2, 0xA: 2, 0xB: 2, 0xC: 1, 0xD: 1,
                      0xE: 2}.get(st >> 4)
            if nbytes is None:
                print(f"    +{i:#x}: non-MIDI byte {st:#04x} "
                      f"(stream desync or terminator)")
                break
            ev = pay[i + 1:i + 1 + nbytes]
            dt = pay[i + 1 + nbytes] if i + 1 + nbytes < len(pay) else -1
            print(f"    +{i:#x}: st={st:#04x} data={ev.hex()} dt={dt}")
            i += 2 + nbytes
            shown += 1
        hexdump(pay[:96])
    else:
        hexdump(pay)


def cmd_census(args):
    c = V2Container(args.folder)
    # reuse operand-count tables from the amiga probe vocabulary
    from collections import Counter
    counts, conds, bad = Counter(), Counter(), []
    for num in range(256):
        pay = c.read("logdir", num)
        if pay is None:
            continue
        cl = struct.unpack_from("<H", pay, 0)[0]
        code = pay[2:2 + cl]
        cnt, cnd, err = walk_code(code)
        counts.update(cnt)
        conds.update(cnd)
        if err:
            bad.append((num, err))
    for op in sorted(counts):
        print(f"action 0x{op:02x}: {counts[op]}")
    for op in sorted(conds):
        print(f"test   0x{op:02x}: {conds[op]}")
    for num, err in bad:
        print(f"logic {num}: {err}", file=sys.stderr)


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
COND_OPS = {
    0x00: 0, 0x01: 2, 0x02: 2, 0x03: 2, 0x04: 2, 0x05: 2, 0x06: 2, 0x07: 1,
    0x08: 1, 0x09: 1, 0x0A: 2, 0x0B: 5, 0x0C: 1, 0x0D: 0, 0x0E: 0, 0x0F: 2,
    0x10: 5, 0x11: 5, 0x12: 5, 0x13: 0,
}


def walk_code(code):
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


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("info")
    s.add_argument("exe", type=Path)
    s.set_defaults(fn=cmd_info)
    s = sub.add_parser("strings")
    s.add_argument("exe", type=Path)
    s.add_argument("--min", type=int, default=4)
    s.set_defaults(fn=cmd_strings)
    s = sub.add_parser("segment")
    s.add_argument("exe", type=Path)
    s.add_argument("ref", help="segment name prefix, segnum or index")
    s.add_argument("--start", type=lambda v: int(v, 0), default=0)
    s.add_argument("--count", type=int, default=None)
    s.add_argument("--m", type=int, default=1)
    s.add_argument("--x", type=int, default=1)
    s.add_argument("--past-end", action="store_true")
    s.set_defaults(fn=cmd_segment)
    s = sub.add_parser("dispatch")
    s.add_argument("exe", type=Path)
    s.set_defaults(fn=cmd_dispatch)
    s = sub.add_parser("snd")
    s.add_argument("folder", type=Path)
    s.add_argument("num", type=int)
    s.add_argument("--max-events", type=int, default=24)
    s.set_defaults(fn=cmd_snd)
    s = sub.add_parser("census")
    s.add_argument("folder", type=Path)
    s.set_defaults(fn=cmd_census)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Execute original GR 3.002.149 parse and said routines on synthetic input.

Requires privately held AGI and AGIDATA.OVL files and optional Unicorn 2.1.4.
No Sierra bytes or disassembly are bundled. Both inputs are SHA-256 pinned;
missing fixtures/dependency explicitly skip. An empty synthetic WORDS.TOK index
makes "xyzzy" unknown. The real parse opcode wrapper and said test run to return,
including their original flag mutations. This is isolated machine-code evidence,
not a complete DOS game, keyboard/menu audit or proof for other AGI builds.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path


EXPECTED_BINARY = "12a52b728b1b1f8d27b21e85cab022a30ef359bca200ba9ed4d6e78a50979f41"
EXPECTED_DATA = "914990f09b49109a34d511011c7764abb5575581fbc190c8cebc930b1027f804"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("binary", type=Path, help="Local games/gr1/AGI")
parser.add_argument("data", type=Path, help="Matching games/gr1/AGIDATA.OVL")
args = parser.parse_args()
for path in [args.binary, args.data]:
    if not path.is_file():
        print(f"SKIP: required original GR 3.002.149 input missing: {path}")
        raise SystemExit(0)
binary, data = args.binary.read_bytes(), args.data.read_bytes()
assert hashlib.sha256(binary).hexdigest() == EXPECTED_BINARY, "Unexpected interpreter"
assert hashlib.sha256(data).hexdigest() == EXPECTED_DATA, "Unexpected AGIDATA.OVL"
assert binary[:2] == b"MZ", "Expected original decoded DOS executable"
try:
    from unicorn import Uc, UC_ARCH_X86, UC_MODE_16
    from unicorn.x86_const import (
        UC_X86_REG_AX, UC_X86_REG_CS, UC_X86_REG_DS, UC_X86_REG_ES,
        UC_X86_REG_SI, UC_X86_REG_SP, UC_X86_REG_SS,
    )
except ImportError:
    print("SKIP: optional Unicorn 2.1.4 is required for original-binary execution")
    raise SystemExit(0)

CODE, DATA, STACK = 0x10000, 0x30000, 0x50000
machine = Uc(UC_ARCH_X86, UC_MODE_16)
machine.mem_map(0, 0x100000)
machine.mem_write(CODE, binary[struct.unpack_from("<H", binary, 8)[0] * 16:])
machine.mem_write(DATA, data)
for register, value in [
    (UC_X86_REG_CS, CODE >> 4), (UC_X86_REG_DS, DATA >> 4),
    (UC_X86_REG_ES, DATA >> 4), (UC_X86_REG_SS, STACK >> 4),
]:
    machine.reg_write(register, value)


def word(offset, value=None):
    if value is not None:
        machine.mem_write(DATA + offset, struct.pack("<H", value))
    return struct.unpack("<H", machine.mem_read(DATA + offset, 2))[0]


def run(entry, argument=0, si=None):
    machine.reg_write(UC_X86_REG_SP, 0xff00)
    machine.mem_write(STACK + 0xff00, struct.pack("<HH", 0xfff0, argument))
    if si is not None:
        machine.reg_write(UC_X86_REG_SI, si)
    machine.emu_start(CODE + entry, CODE + 0xfff0, count=100000)
    assert machine.reg_read(UC_X86_REG_SP) == 0xff02, "Routine did not return"
    return machine.reg_read(UC_X86_REG_AX) & 255


word(0xab2, 0x6000)  # WORDS.TOK pointer; all 26 alphabet offsets absent.
machine.mem_write(DATA + 0x6000, bytes(52))
rows = []
for pattern, expected in [([1], True), ([0], True), ([9999], True),
                          ([100], False), ([1, 1], False)]:
    machine.mem_write(DATA + 0x109, bytes(32))
    machine.mem_write(DATA + 0x20d, b"xyzzy\0")  # String slot 0.
    machine.mem_write(DATA + 0x3000, b"\0")  # parse opcode operand: string 0.
    run(0x1be0, 0x3000)
    assert word(0xab0) == 1, "Unknown input must still count as one parsed word"
    assert word(0xa88) == 0, "Unknown word's group must be zero"
    assert machine.mem_read(DATA + 0x12, 1)[0] == 1, "v9 must identify first unknown word"
    assert machine.mem_read(DATA + 0x109, 1)[0] & 0x20, "parse must set f2"
    assert not machine.mem_read(DATA + 0x109, 1)[0] & 0x08, "parse must clear f4"
    machine.mem_write(DATA + 0x4000, bytes([len(pattern)]) +
                      b"".join(struct.pack("<H", token) for token in pattern))
    result = run(0x0baa, si=0x4000)
    assert bool(result) == expected, (pattern, "said result", result, expected)
    consumed = bool(machine.mem_read(DATA + 0x109, 1)[0] & 0x08)
    assert consumed == expected, (pattern, "f4 consumption")
    repeated = run(0x0baa, si=0x4000)
    assert repeated == 0, (pattern, "second said must not succeed")
    rows.append({"pattern": pattern, "parsed_count": 1, "group": 0, "v9": 1,
                 "matched": bool(result), "f4": consumed, "repeat_matched": False})
print(json.dumps({"build": "3.002.149", "binary_sha256": EXPECTED_BINARY,
                  "data_sha256": EXPECTED_DATA, "parse_entry": "0x1be0",
                  "said_entry": "0x0baa", "input": "xyzzy", "cases": rows}, indent=2))

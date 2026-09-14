#!/usr/bin/env python3
"""Probe local original AGI machine code; requires optional Unicorn 2.1.4.

No Sierra bytes are bundled. Input is a decoded MZ executable. Offsets are
relative to its load module; DS is an isolated scratch data segment. BIOS
INT 1Ah is intercepted with a supplied tick word, never read from the machine.
This executes isolated routines, not a complete DOS machine or game.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path

from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_INTR
from unicorn.x86_const import (
    UC_X86_REG_AX, UC_X86_REG_CS, UC_X86_REG_DS, UC_X86_REG_DX,
    UC_X86_REG_SP, UC_X86_REG_SS,
)


def number(text):
    return int(text, 0)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("binary", type=Path)
parser.add_argument("--entry", type=number, required=True)
parser.add_argument("--state", type=number, required=True)
parser.add_argument("--sha256", required=True, help="Expected decoded executable hash")
parser.add_argument("--range-entry", type=number)
parser.add_argument("--wander-entry", type=number)
parser.add_argument("--ego-pointer", type=number)
parser.add_argument("--exhaustive", action="store_true")
args = parser.parse_args()
binary = args.binary.read_bytes()
assert hashlib.sha256(binary).hexdigest() == args.sha256, "Unexpected binary"
assert binary[:2] == b"MZ", "Descramble v2 first"
header_size = struct.unpack_from("<H", binary, 8)[0] * 16
module = binary[header_size:]
assert 0 <= args.entry < len(module)
u = Uc(UC_ARCH_X86, UC_MODE_16)
u.mem_map(0, 0x100000)
u.mem_write(0x10000, module)
u.reg_write(UC_X86_REG_CS, 0x1000)
u.reg_write(UC_X86_REG_DS, 0x3000)
u.reg_write(UC_X86_REG_SS, 0x5000)
bios_word = 0x1234
bios_calls = []


def interrupt(machine, vector, _):
    assert vector == 0x1a, f"Unexpected interrupt {vector:#x}"
    assert machine.reg_read(UC_X86_REG_AX) >> 8 == 0
    bios_calls.append(bios_word)
    machine.reg_write(UC_X86_REG_DX, bios_word)


u.hook_add(UC_HOOK_INTR, interrupt)


def word(address, value=None):
    if value is not None:
        u.mem_write(0x30000 + address, struct.pack("<H", value))
    return struct.unpack("<H", u.mem_read(0x30000 + address, 2))[0]


def run(entry, argument=0):
    u.reg_write(UC_X86_REG_SP, 0xff00)
    u.mem_write(0x5ff00, struct.pack("<HH", 0xfff0, argument))
    u.emu_start(0x10000 + entry, 0x1fff0, count=10000)
    assert u.reg_read(UC_X86_REG_SP) == 0xff02, "Routine did not return"
    return u.reg_read(UC_X86_REG_AX)


# Compare execution of original instructions with independently stated behavior.
seeds = range(65536) if args.exhaustive else [0, 1, 0x1234, 0x7fff, 0x8000, 0xa59b, 0xffff]
checked = 0
for seed in seeds:
    word(args.state, seed)
    before = len(bios_calls)
    actual = run(args.entry)
    expected_state = ((bios_word if seed == 0 else seed) * 31821 + 1) & 65535
    assert word(args.state) == expected_state, (seed, "state")
    assert actual == ((expected_state >> 8) ^ (expected_state & 255)), (seed, "output")
    assert len(bios_calls) - before == (1 if seed == 0 else 0)
    checked += 1
word(args.state, 1)
sequence = []
for _ in range(10):
    output = run(args.entry)
    sequence.append({"state": word(args.state), "byte": output})
# A naturally reached zero also invokes BIOS on the following call.
prezero = next(seed for seed in range(65536) if (seed * 31821 + 1) & 65535 == 0)
word(args.state, prezero)
assert run(args.entry) == 0 and word(args.state) == 0
before = len(bios_calls)
run(args.entry)
assert len(bios_calls) == before + 1
# Zero BIOS input must be accepted, not coerced to a nonzero seed.
bios_word = 0
word(args.state, 0)
assert run(args.entry) == 1 and word(args.state) == 1
bios_word = 0x1234
results = {"checked_states": checked, "sequence_from_1": sequence, "prezero": prezero}
if args.range_entry is not None:
    rows = []
    for low, high, expected in [(0, 255, 50), (10, 20, 16), (42, 42, 42), (20, 10, 70)]:
        word(args.state, 1)
        u.mem_write(0x33000, bytes([low, high, 60]))
        run(args.range_entry, 0x3000)
        actual = u.mem_read(0x30009 + 60, 1)[0]
        assert actual == expected
        rows.append([low, high, actual])
    results["ranges_from_1"] = rows
if args.wander_entry is not None:
    assert args.ego_pointer is not None
    rows = []
    for count, stationary, direction, after, rng in [
        (0, False, 5, 255, 31822), (1, False, 0, 0, 1),
        (1, True, 5, 41, 11127), (8, True, 5, 7, 31822),
        (255, True, 5, 254, 31822),
    ]:
        word(args.state, 1)
        u.mem_write(0x33000, bytes(43))
        u.mem_write(0x33027, bytes([count]))
        word(0x3025, 0x4000 if stationary else 0)
        word(args.ego_pointer, 0x3000)
        run(args.wander_entry, 0x3000)
        assert u.mem_read(0x33021, 1)[0] == direction
        assert u.mem_read(0x33027, 1)[0] == after
        assert word(args.state) == rng
        rows.append([count, stationary, direction, after, rng])
    results["wander_from_1"] = rows
print(json.dumps(results, indent=2))

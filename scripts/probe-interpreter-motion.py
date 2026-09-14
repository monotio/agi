#!/usr/bin/env python3
"""Execute local Sierra motion/animation handlers using optional Unicorn 2.1.4.

No original bytes are bundled. Addresses are MZ load-module offsets. The final
cel-resource setter is intercepted to observe its requested cel, so these
vectors establish handler/animation state transitions, not graphics fidelity.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path

from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_CODE
from unicorn.x86_const import (
    UC_X86_REG_CS, UC_X86_REG_DS, UC_X86_REG_SS, UC_X86_REG_SP,
    UC_X86_REG_IP,
)

PROFILES = {
    "2.936": dict(
        sha="4b50c681c224326e09933170823b846e7dbe340dafc76f07ee0af990ebb93400",
        ego=0x96b, normal=0x6b82, reverse=0x6beb, end=0x6bae,
        reverse_end=0x6c17, follow=0x6e02, move=0x6ce4,
        cycle=0x48b3, cel_set=0x3ccb, follow_update=0xb36,
        cycle_time=0x6c54,
    ),
    "3.002.149": dict(
        sha="12a52b728b1b1f8d27b21e85cab022a30ef359bca200ba9ed4d6e78a50979f41",
        ego=0x7d0, normal=0x6efa, reverse=0x6f63, end=0x6f26,
        reverse_end=0x6f8f, follow=0x717a, move=0x705c,
        cycle=0x4b0e, cel_set=0x3f2f, follow_update=0xd84,
        cycle_time=0x6fcc,
    ),
    "3.002.107": dict(
        sha="ed8b58d354e10b069a1ce137c61bfa3536b2bb9c69cc7510bc864af29daf161e",
        ego=0x9b0, normal=0x6fd3, reverse=0x703c, end=0x6fff,
        reverse_end=0x7068, follow=0x7253, move=0x7135,
        cycle=0x4cf7, cel_set=0x407e, follow_update=0xd8b,
        cycle_time=0x70a5,
    ),
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("binary", type=Path)
parser.add_argument("--profile", choices=PROFILES, required=True)
args = parser.parse_args()
p = PROFILES[args.profile]
binary = args.binary.read_bytes()
assert hashlib.sha256(binary).hexdigest() == p["sha"], "Unexpected executable"
assert binary[:2] == b"MZ"
module = binary[struct.unpack_from("<H", binary, 8)[0] * 16:]
u = Uc(UC_ARCH_X86, UC_MODE_16)
u.mem_map(0, 0x100000)
u.mem_write(0x10000, module)
u.reg_write(UC_X86_REG_CS, 0x1000)
u.reg_write(UC_X86_REG_DS, 0x3000)
u.reg_write(UC_X86_REG_SS, 0x5000)
OBJ = 0x302b  # Object 1, deliberately not ego.


def byte(offset, value=None):
    if value is not None:
        u.mem_write(0x30000 + offset, bytes([value]))
    return u.mem_read(0x30000 + offset, 1)[0]


def word(offset, value=None):
    if value is not None:
        u.mem_write(0x30000 + offset, struct.pack("<H", value))
    return struct.unpack("<H", u.mem_read(0x30000 + offset, 2))[0]


def set_cel(machine, address, size, _):
    if address != 0x10000 + p["cel_set"]:
        return
    sp = machine.reg_read(UC_X86_REG_SP)
    ret, obj, cel = struct.unpack("<HHH", machine.mem_read(0x50000 + sp, 6))
    byte(obj + 0xe, cel)
    machine.reg_write(UC_X86_REG_SP, sp + 2)
    machine.reg_write(UC_X86_REG_IP, ret)


u.hook_add(UC_HOOK_CODE, set_cel)


def run(name, argument):
    u.reg_write(UC_X86_REG_SP, 0xff00)
    u.mem_write(0x5ff00, struct.pack("<HH", 0xfff0, argument))
    u.emu_start(0x10000 + p[name], 0x1fff0, count=10000)
    assert u.reg_read(UC_X86_REG_SP) == 0xff02, name + " did not return"


def command(name, *operands):
    u.mem_write(0x34000, bytes(operands))
    run(name, 0x4000)


def fresh():
    u.mem_write(0x30000, bytes(0x5000))
    word(p["ego"], 0x3000)
    byte(OBJ + 0x1e, 4)  # step size
    byte(OBJ + 0xf, 3)   # number of cels
    word(OBJ + 3, 10)
    word(OBJ + 5, 80)
    word(0x3003, 13)
    word(0x3005, 80)


def flag(n):
    return bool(byte(0x109 + n // 8) & (0x80 >> (n % 8)))


rows = []
for name, mode in [("normal", 0), ("reverse", 3)]:
    fresh()
    command(name, 1)
    assert word(OBJ + 0x25) == 0x20
    assert byte(OBJ + 0x23) == mode
    rows.append(dict(case=name + " restarts cycling", bits=word(OBJ + 0x25)))

for requested in [0, 1, 4, 5, 255]:
    fresh()
    command("follow", 1, requested, 61)
    assert byte(OBJ + 0x27) == max(4, requested)
    assert word(OBJ + 0x25) == 0x10
    assert byte(OBJ + 0x29) == 255
    assert not flag(61)
    run("follow_update", OBJ)
    assert flag(61)  # ego 3 pixels away, inside the effective threshold
    rows.append(dict(case="follow threshold", requested=requested,
                     effective=byte(OBJ + 0x27), completes=True))

fresh()
byte(9 + 60, 7)
command("cycle_time", 1, 60)
assert (byte(OBJ + 0x1f), byte(OBJ + 0x20)) == (7, 7)
rows.append(dict(case="cycle.time resets both", time=7, counter=7))

for completion in ["end", "reverse_end"]:
    fresh()
    command("move", 1, 90, 80, 2, 62)
    assert list(u.mem_read(0x30000 + OBJ + 0x27, 4)) == [90, 80, 4, 62]
    command(completion, 1, 61)
    assert list(u.mem_read(0x30000 + OBJ + 0x27, 4)) == [61, 80, 4, 62]
    assert word(OBJ + 0x25) == 0x1030
    rows.append(dict(case="move then " + completion, shared=[61, 80, 4, 62]))

    fresh()
    command(completion, 1, 61)
    command("move", 1, 90, 80, 2, 62)
    assert list(u.mem_read(0x30000 + OBJ + 0x27, 4)) == [90, 80, 4, 62]
    byte(OBJ + 0xe, 1)
    run("cycle", OBJ)  # Clears initial animation delay without setting a flag.
    assert not flag(90) and not flag(61)
    run("cycle", OBJ)
    assert flag(90) and not flag(61)  # Completion reads the overwritten p1.
    assert byte(OBJ + 0xe) == (2 if completion == "end" else 0)
    assert not word(OBJ + 0x25) & 0x20
    rows.append(dict(case=completion + " then move then two animation calls",
                     completed_flag=90, original_flag_61=False,
                     cel=byte(OBJ + 0xe)))

print(json.dumps(dict(profile=args.profile, sha256=p["sha"], cases=rows), indent=2))

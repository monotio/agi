#!/usr/bin/env python3
"""Execute isolated original Sierra sound routines; optional Unicorn 2.1.4.

Usage: python scripts/probe-interpreter-sound.py games/mh1/AGI
Supports hash-pinned decoded KQ1 2.917, KQ3 2.936, MH1 3.002.107 and GR1 3.002.149
executables plus AGIDATA.OVL (alongside them, or passed with --data). No original bytes are bundled. Resource lookup
alone is substituted with a synthetic loaded-resource descriptor; opcode,
flag, player, envelope and stop routines execute unchanged. I/O is captured,
not sent to hardware. This does not verify interrupt cadence or PSG silicon.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path

from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_CODE, UC_HOOK_INSN
from unicorn.x86_const import (
    UC_X86_REG_AX, UC_X86_REG_CS, UC_X86_REG_DS, UC_X86_REG_ES,
    UC_X86_REG_IP, UC_X86_REG_SP, UC_X86_REG_SS, UC_X86_INS_IN, UC_X86_INS_OUT,
)

BUILDS = {
    "4b50c681c224326e09933170823b846e7dbe340dafc76f07ee0af990ebb93400": {
        "build": "2.936",
        "data_hash": "b145061a2385d65060d944ad3a2e39a421037d11970f0dcddff4049909c04bf9",
        "start": 0x51d3, "lookup": 0x50d8, "tick": 0x801c, "stop": 0x5234,
        "device": 0x112e, "active": 0x1258, "count": 0x1790,
    },
    "bf53a4f98e32a7feec127b153100b66678c48715fec1ae2e823b947c0b5aef04": {
        "build": "2.917",
        "data_hash": "f7ca256c1c0ab12509d695baabdd44a3c5e72a570b08118d3ead995a47f4c383",
        "start": 0x510b, "lookup": 0x5010, "tick": 0x7f55, "stop": 0x516c,
        "device": 0x1126, "active": 0x124e, "count": 0x1786,
    },
    "ed8b58d354e10b069a1ce137c61bfa3536b2bb9c69cc7510bc864af29daf161e": {
        "build": "3.002.107",
        "data_hash": "bb22a87cd215ed52154d49754493e0eb2f6be5688411d8f3b7ac17c417ddae1f",
        "start": 0x55ef, "lookup": 0x54f4, "tick": 0x8473, "stop": 0x5650,
        "device": 0x1191, "active": 0x12db, "count": 0x1812,
    },
    "12a52b728b1b1f8d27b21e85cab022a30ef359bca200ba9ed4d6e78a50979f41": {
        "build": "3.002.149",
        "data_hash": "914990f09b49109a34d511011c7764abb5575581fbc190c8cebc930b1027f804",
        "start": 0x5406, "lookup": 0x530b, "tick": 0x8330, "stop": 0x5467,
        "device": 0x0f4f, "active": 0x1090, "count": 0x15c7,
    },
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("binary", type=Path)
parser.add_argument("--data", type=Path, help="Matching original AGIDATA.OVL")
args = parser.parse_args()
binary = args.binary.read_bytes()
digest = hashlib.sha256(binary).hexdigest()
assert digest in BUILDS, "Unsupported executable hash"
build = BUILDS[digest]
data = (args.data or args.binary.with_name("AGIDATA.OVL")).read_bytes()
assert hashlib.sha256(data).hexdigest() == build["data_hash"], "Wrong data overlay"
assert binary[:2] == b"MZ"
module = binary[struct.unpack_from("<H", binary, 8)[0] * 16:]
u = Uc(UC_ARCH_X86, UC_MODE_16)
u.mem_map(0, 0x100000)
u.mem_write(0x10000, module)
for register, value in [
    (UC_X86_REG_CS, 0x1000), (UC_X86_REG_DS, 0x3000),
    (UC_X86_REG_ES, 0x3000), (UC_X86_REG_SS, 0x5000),
]:
    u.reg_write(register, value)
ports = []
u.hook_add(UC_HOOK_INSN, lambda m, p, s, v, d: ports.append([p, v]),
           None, 1, 0, UC_X86_INS_OUT)
u.hook_add(UC_HOOK_INSN, lambda m, p, s, d: 0, None, 1, 0, UC_X86_INS_IN)


def resource_lookup(machine, address, size, userdata):
    if address != 0x10000 + build["lookup"]:
        return
    sp = machine.reg_read(UC_X86_REG_SP)
    ret = struct.unpack("<H", machine.mem_read(0x50000 + sp, 2))[0]
    machine.reg_write(UC_X86_REG_AX, 0x3000)
    machine.reg_write(UC_X86_REG_SP, sp + 2)
    machine.reg_write(UC_X86_REG_IP, ret)


u.hook_add(UC_HOOK_CODE, resource_lookup)


def word(address, value=None):
    if value is not None:
        u.mem_write(0x30000 + address, struct.pack("<H", value))
    return struct.unpack("<H", u.mem_read(0x30000 + address, 2))[0]


def flag(number, value=None):
    address = 0x30109 + number // 8
    mask = 0x80 >> (number % 8)
    old = u.mem_read(address, 1)[0]
    if value is not None:
        u.mem_write(address, bytes([(old | mask) if value else (old & ~mask)]))
    return bool(u.mem_read(address, 1)[0] & mask)


def run(entry, argument=0):
    ports.clear()
    u.reg_write(UC_X86_REG_SP, 0xff00)
    u.mem_write(0x5ff00, struct.pack("<HH", 0xfff0, argument))
    u.emu_start(0x10000 + entry, 0x1fff0, count=10000)
    assert u.reg_read(UC_X86_REG_SP) == 0xff02, "Routine did not return"
    return {"active": word(build["active"]), "f40": flag(40), "f41": flag(41),
            "count": word(build["count"]), "ports": ports.copy()}


def setup(duration=2, tone=0x8123, enabled=True):
    u.mem_write(0x30000, bytes(65536))
    u.mem_write(0x30000, data)
    word(build["active"], 0)
    word(build["device"], 1)
    flag(9, enabled)
    flag(40, False)
    flag(41, False)
    # The loaded-resource descriptor has four absolute DS pointers at +6.
    u.mem_write(0x33006, struct.pack("<4H", 0x3100, 0x3107, 0x3107, 0x3107))
    u.mem_write(0x33100, struct.pack("<HHBHH", duration, tone, 0x94, 0xffff, 0xffff))


def begin(done_flag=40):
    u.mem_write(0x33200, bytes([1, done_flag]))
    return run(build["start"], 0x3200)


results = {}
setup()
flag(40, True)
results["start"] = begin()
results["ticks"] = [run(build["tick"]) for _ in range(3)]
assert results["start"]["active"] == 1 and not results["start"]["f40"]
assert [row["f40"] for row in results["ticks"]] == [False, False, True]
setup()
begin()
results["replace_distinct"] = begin(41)
assert flag(40) and not flag(41)
setup()
begin()
results["replace_same"] = begin(40)
assert not flag(40)
setup()
begin()
results["stop"] = run(build["stop"])
assert flag(40) and not word(build["active"])
flag(40, False)
results["stop_idle"] = run(build["stop"])
assert not flag(40) and not ports
setup(enabled=False)
results["disabled_start"] = begin()
assert not flag(40) and word(build["active"])
results["disabled_tick"] = run(build["tick"])
assert flag(40) and not word(build["active"])
setup()
begin()
run(build["tick"])
flag(9, False)
results["mute_running"] = run(build["tick"])
assert flag(40) and not word(build["active"])
setup(duration=0)
begin()
run(build["tick"])
assert word(build["count"]) == 0
run(build["tick"])
assert word(build["count"]) == 65535
results["zero_duration_countdowns"] = [0, 65535]
setup(tone=0)
begin()
results["zero_tone"] = run(build["tick"])
assert ports[:2] == [[192, 0], [192, 0]]
setup(duration=120)
u.mem_write(0x33104, b"\x90")
u.mem_write(0x30020, b"\x03")  # v23 attenuation adjustment
begin()
envelope = []
for tick in range(1, 85):
    run(build["tick"])
    writes = [value for port, value in ports if port == 192 and value & 0xf0 == 0x90]
    envelope.append(writes[-1] & 15)
# Behavior at transition boundaries, independent of this repo's envelope table.
expected = {1: 3, 7: 3, 9: 3, 10: 4, 15: 4, 16: 5, 25: 5, 26: 6,
            33: 6, 34: 7, 38: 7, 39: 8, 70: 14, 71: 15, 77: 15, 78: 13, 84: 13}
if build["build"] in ("2.917", "2.936"):
    expected = {1: 3, 6: 3, 7: 4, 10: 4, 11: 5, 18: 5, 19: 6,
                25: 6, 26: 7, 29: 7, 30: 8, 60: 14, 61: 15, 67: 15, 68: 13, 84: 13}
assert all(envelope[tick - 1] == value for tick, value in expected.items()), envelope
results["envelope_base0_adjust3"] = envelope
setup(duration=2, tone=0xe001)
u.mem_write(0x33006, struct.pack("<4H", 0x3107, 0x3107, 0x3107, 0x3100))
u.mem_write(0x33104, b"\xf0")
u.mem_write(0x30020, b"\x03")
begin()
results["noise_base0_adjust3"] = run(build["tick"])
assert [value for port, value in ports if port == 192 and value & 0xf0 == 0xf0] == [0xf0]
# First-envelope-step arithmetic is independently derived from ADD AL / CMP
# AL,15 / JLE, then device 2's CMP AL,8 / JGE / ADD AL,2. Preserve the entire
# output byte: high adjustments can select a different PSG register.
edge_cases = 0
for device in (1, 2):
    for base in range(16):
        for adjustment in range(256):
            setup(duration=120)
            word(build["device"], device)
            u.mem_write(0x33104, bytes([0x90 | base]))
            u.mem_write(0x30020, bytes([adjustment]))
            begin()
            output = run(build["tick"])["ports"][2]
            value = 15
            if base != 15:
                value = (max(0, base - 2) + adjustment) % 256
                signed = value if value < 128 else value - 256
                if signed > 15:
                    value = 15
                signed = value if value < 128 else value - 256
                if device == 2 and signed < 8:
                    value = (value + 2) % 256
            assert output == [192, value | 0x90], (device, base, adjustment, output)
            edge_cases += 1
results["device_adjustment_cases"] = edge_cases
print(json.dumps({"build": build["build"], "sha256": digest,
                  "data_sha256": build["data_hash"], "results": results}, indent=2))

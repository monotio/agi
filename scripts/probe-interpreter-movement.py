#!/usr/bin/env python3
"""Execute hash-pinned original movement passes with synthetic object/terrain data.

Requires optional Unicorn 2.1.4. No executable bytes or commercial resources are
bundled. Offsets refer to MZ load modules. This is controlled routine execution,
not a full machine: direction/priority tables and cel dimensions are supplied;
original collision, footprint, placement, target and follow instructions run.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path
from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_CODE, UC_HOOK_INTR
from unicorn.x86_const import (
    UC_X86_REG_AX, UC_X86_REG_CS, UC_X86_REG_DS, UC_X86_REG_DX,
    UC_X86_REG_ES, UC_X86_REG_SS, UC_X86_REG_SP, UC_X86_REG_IP,
)

PROFILES = {
    "2.411": dict(sha="d99938d6622ef18556bea76ebe72214b18cecac7305b83885a1157ddcff539bf",
        ego=0x951, move=0x14b9, collision=0x45e3, footprint=0x549f,
        follow=0xb03, target=0x1621, directions=0xa39, priorities=0x121e,
        pixels=0x1313, rng=0x6dfe, state=0x15e0),
    "2.439": dict(sha="e717bfe1059eff8c2d7ace9052e194b50ddec9257421b4e77356e91331142ade",
        ego=0x951, move=0x14c7, collision=0x460d, footprint=0x54c9,
        follow=0xb03, target=0x162f, directions=0xa39, priorities=0x120e,
        pixels=0x1303, rng=0x6f1b, state=0x168d),
    "2.917": dict(sha="bf53a4f98e32a7feec127b153100b66678c48715fec1ae2e823b947c0b5aef04",
        ego=0x963, move=0x150a, collision=0x4719, footprint=0x55f0,
        follow=0xb36, target=0x1672, directions=0xa59, priorities=0x1270,
        pixels=0x1365, rng=0x70f9, state=0x1707),
    "2.936": dict(sha="4b50c681c224326e09933170823b846e7dbe340dafc76f07ee0af990ebb93400",
        ego=0x96b, move=0x150a, collision=0x4719, footprint=0x56b8,
        follow=0xb36, target=0x1672, directions=0xa61, priorities=0x127a,
        pixels=0x136f, rng=0x71c0, state=0x1711),
    "3.002.086": dict(sha="b9b27b403015bb18f6562ba1b8b04c2829e0c3b53c042196bee7924d1df7be65",
        ego=0x99d, move=0x1751, collision=0x4b47, footprint=0x5ad3,
        follow=0xd75, target=0x18b9, directions=0xa93, priorities=0x12ea,
        pixels=0x13df, rng=0x75ff, state=0x1781),
    "3.002.107": dict(sha="ed8b58d354e10b069a1ce137c61bfa3536b2bb9c69cc7510bc864af29daf161e",
        ego=0x9b0, move=0x1767, collision=0x4b5d, footprint=0x5ae2,
        follow=0xd8b, target=0x18cf, directions=0xaa6, priorities=0x12fd,
        pixels=0x13f2, rng=0x7617, state=0x1793),
    "3.002.149": dict(sha="12a52b728b1b1f8d27b21e85cab022a30ef359bca200ba9ed4d6e78a50979f41",
        ego=0x7d0, move=0x1720, collision=0x4974, footprint=0x58e5,
        follow=0xd84, target=0x1888, directions=0x8c6, priorities=0x10b2,
        pixels=0x11a7, rng=0x753e, state=0x1548),
}
for key, pre, post, cel, rendering in [
    ("2.411", 0x611, 0x530, 0x3bc9, [0x2d4, 0x6696, 0x42b, 0x455]),
    ("2.439", 0x611, 0x530, 0x3bf3, [0x2d4, 0x67b3, 0x42b, 0x455]),
    ("2.917", 0x644, 0x563, 0x3ccb, [0x307, 0x695f, 0x45e, 0x488]),
    ("2.936", 0x644, 0x563, 0x3ccb, [0x307, 0x6a26, 0x45e, 0x488]),
    ("3.002.086", 0x644, 0x563, 0x4068, [0x307, 0x6e5f, 0x45e, 0x488]),
    ("3.002.107", 0x65b, 0x563, 0x407e, [0x307, 0x6e77, 0x45e, 0x488]),
    ("3.002.149", 0x654, 0x55c, 0x3f2f, [0x300, 0x6d9e, 0x457, 0x481]),
]:
    PROFILES[key].update(pre=pre, post=post, cel=cel, rendering=rendering)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("binary", type=Path)
parser.add_argument("--profile", choices=PROFILES, required=True)
a = parser.parse_args()
p = PROFILES[a.profile]
b = a.binary.read_bytes()
assert hashlib.sha256(b).hexdigest() == p["sha"], "Unexpected executable"
assert b[:2] == b"MZ"
u = Uc(UC_ARCH_X86, UC_MODE_16)
u.mem_map(0, 0x100000)
u.mem_write(0x10000, b[struct.unpack_from("<H", b, 8)[0] * 16:])
for reg, val in [(UC_X86_REG_CS, 0x1000), (UC_X86_REG_DS, 0x3000),
                 (UC_X86_REG_SS, 0x3000), (UC_X86_REG_ES, 0x3000)]:
    u.reg_write(reg, val)
BASE = 0x3000
calls = []
bios = []
cel_widths = {}
phases = []
execute_cel = False


def code(machine, address, size, _):
    if address == 0x10000 + p["move"]:
        phases.append("movement")
    if address == 0x10000 + p["rng"]:
        calls.append(word(p["state"]))
    entry = address - 0x10000
    if entry in p["rendering"] or (entry == p["cel"] and not execute_cel):
        sp = machine.reg_read(UC_X86_REG_SP)
        ret = word(sp)
        if entry == p["cel"]:
            obj, cel = word(sp + 2), word(sp + 4)
            byte(obj + 0xe, cel)
            phases.append("cel")
            if obj in cel_widths:
                word(obj + 0x1a, cel_widths[obj][cel])
        machine.reg_write(UC_X86_REG_SP, sp + 2)
        machine.reg_write(UC_X86_REG_IP, ret)


def interrupt(machine, vector, _):
    assert vector == 0x1a and machine.reg_read(UC_X86_REG_AX) >> 8 == 0
    bios.append(0x1234)
    machine.reg_write(UC_X86_REG_DX, 0x1234)


u.hook_add(UC_HOOK_CODE, code)
u.hook_add(UC_HOOK_INTR, interrupt)


def byte(offset, value=None):
    if value is not None:
        u.mem_write(0x30000 + offset, bytes([value]))
    return u.mem_read(0x30000 + offset, 1)[0]


def word(offset, value=None):
    if value is not None:
        u.mem_write(0x30000 + offset, struct.pack("<H", value & 65535))
    return struct.unpack("<H", u.mem_read(0x30000 + offset, 2))[0]


def run(name, obj=BASE, argument=0):
    u.reg_write(UC_X86_REG_SP, 0xff00)
    u.mem_write(0x3ff00, struct.pack("<HHH", 0xfff0, obj, argument))
    u.emu_start(0x10000 + p[name], 0x1fff0, count=100000)
    assert u.reg_read(UC_X86_REG_SP) == 0xff02, name + " did not return"
    return u.reg_read(UC_X86_REG_AX)


def fresh(count=1):
    u.mem_write(0x30000, bytes(0x10000))
    u.mem_write(0x60000, bytes([0x40]) * (160 * 168))
    word(p["ego"], BASE)
    word(p["ego"] + 2, BASE + count * 43)
    word(p["pixels"], 0x6000)
    word(p["state"], 1)
    word(0x12d, 36)
    for i, value in enumerate([0, 0, 1, 1, 1, 0, -1, -1, -1,
                                0, -1, -1, 0, 1, 1, 1, 0, -1]):
        word(p["directions"] + 2 * i, value)
    for i, value in enumerate([8, 1, 2, 7, 0, 3, 6, 5, 4]):
        word(p["directions"] + 36 + 2 * i, value)
    for y in range(168):
        byte(p["priorities"] + y, max(4, y // 12 + 1))
    for n in range(count):
        o = BASE + 43 * n
        byte(o, 1)
        byte(o + 1, 1)
        byte(o + 2, n)
        word(o + 3, 20 + 60 * n)
        word(o + 5, 80)
        word(o + 0x18, 80)
        word(o + 0x1a, 2)
        word(o + 0x1c, 1)
        word(o + 0x10, 0x4000 + n * 4)
        byte(0x4000 + n * 4, 2)
        byte(0x4001 + n * 4, 1)
        byte(o + 0x1e, 1)
        byte(o + 0x21, 3)
        word(o + 0x25, 0x51)
    calls.clear()
    bios.clear()
    cel_widths.clear()
    phases.clear()


def terrain(x, y, controls):
    u.mem_write(0x60000 + y * 160 + x, bytes(c << 4 for c in controls))


def state(o=BASE):
    return dict(x=word(o + 3), y=word(o + 5), direction=byte(o + 0x21),
                count=byte(o + 1), mode=byte(o + 0x22), step=byte(o + 0x1e),
                border=byte(11), object=byte(13), objectBorder=byte(14),
                water=bool(byte(0x109) & 0x80), trigger=bool(byte(0x109) & 0x10))


rows = []
for label, x, y, direction, expected in [
    ("clear", 20, 80, 3, (21, 80, 0)),
    ("exact zero left", 1, 80, 7, (0, 80, 4 if a.profile == "3.002.086" else 0)),
    ("upper left corner", 0, 37, 8, (0, 37, 1)),
    ("lower left corner", 0, 167, 6, (0, 167, 3)),
    ("upper right corner", 158, 37, 2, (158, 37, 1)),
    ("lower right corner", 158, 167, 4, (158, 167, 3)),
]:
    fresh()
    word(BASE + 3, x)
    word(BASE + 5, y)
    byte(BASE + 0x21, direction)
    run("move")
    s = state()
    assert (s["x"], s["y"], s["border"]) == expected, (label, s)
    rows.append(dict(case=label, result=s))

for flags, expected in [(0x41, 20), (0x51, 20), (0x40, 21), (0x241, 21)]:
    fresh(2)
    word(BASE + 43 + 3, 23)
    word(BASE + 43 + 0x25, flags)
    run("move")
    assert word(BASE + 3) == expected, ("collision", flags, state())
    rows.append(dict(case="collision candidate flags", flags=flags, x=expected))

for controls, extra, expected in [
    ([4, 4], 0, (21, False, False)), ([0, 4], 0, (19, False, False)),
    ([1, 4], 0, (19, False, False)), ([1, 4], 2, (21, False, False)),
    ([2, 4], 0, (21, False, True)), ([4, 2], 0, (21, False, True)),
    ([3, 3], 0, (21, True, False)), ([3, 4], 0, (21, False, False)),
    ([3, 4], 0x100, (20, True, False)),
    ([3, 3], 0x800, (20, False, False)),
]:
    fresh()
    word(BASE + 0x25, 0x51 | extra)
    # Keep the old footprint valid for gates, so rejection restores it.
    if extra == 0x100:
        terrain(20, 80, [3, 3])
    terrain(21, 80, controls)
    if extra == 0x100:
        # Keep the prior baseline and its left neighbor entirely water.
        terrain(19, 80, [3, 3])
    run("move")
    s = state()
    assert (s["x"], s["water"], s["trigger"]) == expected, (controls, extra, s)
    rows.append(dict(case="control baseline", controls=controls, flags=extra, result=s))

for previous, expected in [(79, 79), (80, 81), (81, 81)]:
    fresh(2)
    word(BASE + 5, 79)
    word(BASE + 0x18, previous)
    word(BASE + 43 + 3, 21)
    byte(BASE + 0x21, 5)
    byte(BASE + 0x1e, 2)
    byte(BASE + 43 + 0x21, 0)
    run("move")
    assert word(BASE + 5) == expected
    rows.append(dict(case="strict baseline crossing", previous=previous, y=expected))

fresh()
word(BASE + 0x25, 0x55)
byte(BASE + 0x24, 15)
byte(0x109, 0x90)
terrain(21, 80, [0, 0])
run("move")
assert (word(BASE + 3), byte(0x109) & 0x90) == (21, 0)
rows.append(dict(case="priority 15 bypass clears ego class flags", result=state()))

for delta, expected_direction, expected_flag in [(3, 0, True), (4, 3, False), (5, 3, False)]:
    fresh(2)
    o = BASE + 43
    byte(o + 0x1e, 4)
    byte(o + 0x22, 3)
    byte(o + 0x27, 80 + delta)
    byte(o + 0x28, 80)
    byte(o + 0x29, 1)
    byte(o + 0x2a, 61)
    run("target", o)
    assert byte(o + 0x21) == expected_direction
    assert bool(byte(0x109 + 61 // 8) & (0x80 >> (61 % 8))) == expected_flag
    rows.append(dict(case="target strict arrival band", delta=delta, direction=expected_direction,
                     completed=expected_flag))

fresh()
byte(BASE, 3)
byte(BASE + 1, 2)
cadence = []
for _ in range(5):
    run("move")
    cadence.append([word(BASE + 3), byte(BASE + 1)])
assert cadence == [[20, 1], [21, 3], [21, 2], [21, 1], [22, 3]]
rows.append(dict(case="step cadence", result=cadence))

fresh(2)
o = BASE + 43
word(o + 3, 158)
byte(o + 0x22, 3)
byte(o + 0x29, 4)
byte(o + 0x2a, 61)
run("move")
s = state(o)
assert (s["x"], s["direction"], s["mode"], s["step"], s["objectBorder"]) == (158, 3, 0, 4, 2)
assert byte(0x109 + 61 // 8) & (0x80 >> (61 % 8))
rows.append(dict(case="target border completion retains actor direction", result=s))

# Retry decrement uses signed byte operands in SUB/JGE, including overflow.
for retry, step, expected in [(5, 4, 1), (3, 4, 0), (128, 1, 0),
                              (127, 255, 128), (1, 128, 129), (254, 255, 0)]:
    fresh(2)
    o = BASE + 43
    byte(o + 0x27, 1)
    byte(o + 0x29, retry)
    byte(o + 0x1e, step)
    run("follow", o)
    assert byte(o + 0x29) == expected, (retry, step, byte(o + 0x29))
    assert not calls
    rows.append(dict(case="follow signed retry subtraction", retry=retry, step=step,
                     result=expected, randomCalls=0))

# Seeded RNG is executed, not replaced; BIOS input is deterministic if needed.
for seed, expected in [(1, (5, 30, 2, 11127)), (0, (3, 18, 2, 62114)),
                       (2, (5, 6, 3, 16929)), (3, (3, 15, 4, 62591))]:
    fresh(2)
    o = BASE + 43
    word(o + 0x25, 0x4051)
    byte(o + 0x27, 1)
    byte(o + 0x29, 0)
    byte(o + 0x1e, 4)
    word(p["state"], seed)
    run("follow", o)
    result = (byte(o + 0x21), byte(o + 0x29), len(calls), word(p["state"]))
    assert result == expected, (seed, result)
    assert bios == ([0x1234] if seed == 0 else [])
    rows.append(dict(case="stationary follow", seed=seed, result=result, bios=bios[:]))

# The prelogic dispatcher gates rectangle enforcement on step countdown 1.
for count, expected in [(0, 3), (1, 0), (2, 3)]:
    fresh()
    byte(BASE + 1, count)
    word(0x13d, 1)
    for offset, value in [(0x131, 20), (0x133, 70), (0x135, 30), (0x137, 90)]:
        word(offset, value)
    run("pre")
    assert byte(BASE + 0x21) == expected, ("rectangle cadence", count)
    assert bool(word(BASE + 0x25) & 0x80) == (count == 1)
    rows.append(dict(case="rectangle cadence", countdown=count, direction=expected,
                     rectangleBlocked=count == 1))

for count in [1, 2]:
    fresh()
    byte(BASE + 1, count)
    word(BASE + 0x25, 0x451)
    run("move")
    assert word(BASE + 3) == 20
    assert bool(word(BASE + 0x25) & 0x400) == (count == 2)
    rows.append(dict(case="reposition suppression survives until due move", countdown=count,
                     x=20, repositioned=count == 2))

fresh()
word(BASE + 0x25, 0xd1)
run("pre")
assert word(BASE + 0x25) & 0x80 == 0
rows.append(dict(case="disabled rectangle clears transition bit", flags=word(BASE + 0x25)))

# Graphics refresh/resource setters are intercepted; cadence and cel mode
# dispatch execute. A zero animation countdown is disabled, unlike movement.
for count, expected_cel, expected_count in [(0, 0, 0), (1, 1, 3), (2, 0, 1)]:
    fresh()
    word(BASE + 0x25, 0x71)
    byte(BASE + 0xf, 3)
    byte(BASE + 0x1f, 3)
    byte(BASE + 0x20, count)
    run("post")
    assert (byte(BASE + 0xe), byte(BASE + 0x20)) == (expected_cel, expected_count)
    rows.append(dict(case="animation cadence", countdown=count, cel=expected_cel, remaining=expected_count))

fresh()
word(BASE + 0x25, 0x41 | 0x100)
byte(11, 4)
byte(13, 7)
byte(14, 3)
run("post")
assert (byte(11), byte(13), byte(14), word(BASE + 0x25) & 0x100) == (4, 7, 3, 0x100)
rows.append(dict(case="no updating objects preserves border bytes and ego restriction", borders=[4, 7, 3]))

fresh()
word(BASE + 0x25, 0x51 | 0x100)
terrain(20, 80, [3, 3, 3])
run("post")
assert word(BASE + 0x25) & 0x900 == 0
rows.append(dict(case="ego water/land restriction clears after postlogic pass", flags=word(BASE + 0x25)))

# Cel-resource lookup remains the declared substitute: supplied dimensions
# change at that boundary. The original dispatcher and collision code establish
# that every actor's animation update precedes the first movement attempt.
for old_width, new_width, expected_x in [(1, 4, 29), (4, 1, 28)]:
    fresh(2)
    word(BASE + 3, 29)
    byte(BASE + 0x21, 7)
    o = BASE + 43
    word(o + 3, 24)
    word(o + 0x1a, old_width)
    byte(o + 0x21, 0)
    word(o + 0x25, 0x71)
    byte(o + 0xf, 2)
    byte(o + 0x1f, 1)
    byte(o + 0x20, 1)
    cel_widths[o] = [old_width, new_width]
    run("post")
    assert phases == ["cel", "movement"], phases
    assert (word(BASE + 3), word(BASE + 5), word(o + 0x1a)) == (expected_x, 80, new_width)
    rows.append(dict(case="all cel updates precede collision movement", oldWidth=old_width,
                     newWidth=new_width, egoX=expected_x, egoY=80, phases=phases[:]))

for control in [3, 4]:
    for priority in [4, 15]:
        fresh()
        word(BASE + 0x25, 0x955)
        byte(BASE + 0x24, priority)
        terrain(20, 80, [control, control])
        accepted = run("footprint")
        assert accepted == (1 if priority == 15 else 0)
        assert word(BASE + 0x25) & 0x900 == 0x900
        rows.append(dict(case="combined water and land restriction", control=control,
                         priority=priority, accepted=bool(accepted)))

# Unlike the dispatcher matrices, these cases execute the complete original
# cel setter and dimension-binding subroutine against synthetic loop/cel data.
execute_cel = True
for label, x, y, width, height, ignore_horizon, expected in [
    ("right overflow", 158, 80, 4, 1, False, (156, 80, True)),
    ("exact right bound", 156, 80, 4, 1, False, (156, 80, False)),
    ("top overflow with horizon", 20, 2, 2, 6, False, (20, 37, True)),
    ("top overflow ignoring horizon", 20, 2, 2, 6, True, (20, 5, True)),
    ("exact top bound below horizon", 20, 5, 2, 6, False, (20, 5, False)),
    ("in-bounds below horizon", 20, 10, 2, 6, False, (20, 10, False)),
    ("left coordinate retained", -1, 80, 2, 1, False, (65535, 80, False)),
    ("bottom coordinate retained", 20, 168, 2, 1, False, (20, 168, False)),
    ("simultaneous right and top", 158, 2, 4, 6, False, (156, 37, True)),
]:
    fresh()
    word(BASE + 3, x)
    word(BASE + 5, y)
    word(BASE + 8, 0x5000)
    word(BASE + 0xc, 0x5000)
    byte(BASE + 0xf, 2)
    word(BASE + 0x25, 0x59 if ignore_horizon else 0x51)
    u.mem_write(0x35000, bytes([2, 5, 0, 8, 0, 2, 1, 0, width, height, 0]))
    run("cel", BASE, 1)
    result = (word(BASE + 3), word(BASE + 5), bool(word(BASE + 0x25) & 0x400))
    assert result == expected, (label, result)
    assert (byte(BASE + 0xe), word(BASE + 0x1a), word(BASE + 0x1c)) == (1, width, height)
    rows.append(dict(case="original cel geometry: " + label, result=result,
                     width=width, height=height, setterExecuted=True))

fresh()
word(BASE + 3, 158)
word(BASE + 8, 0x5000)
word(BASE + 0xc, 0x5000)
byte(BASE + 0xf, 2)
byte(BASE + 0x21, 7)
u.mem_write(0x35000, bytes([2, 5, 0, 8, 0, 2, 1, 0, 4, 1, 0]))
run("cel", BASE, 1)
positions = [word(BASE + 3)]
for _ in range(2):
    run("move")
    positions.append(word(BASE + 3))
assert positions == [156, 156, 155]
assert word(BASE + 0x25) & 0x400 == 0
rows.append(dict(case="cel clipping suppresses exactly the next due movement", positions=positions))

print(json.dumps(dict(profile=a.profile, sha256=p["sha"], evidence="routine execution", cases=rows), indent=2))

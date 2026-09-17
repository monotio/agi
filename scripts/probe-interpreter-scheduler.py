#!/usr/bin/env python3
"""Execute original timing services and print waits with controlled timer input.

Requires hash-pinned decoded AGI and matching AGIDATA.OVL plus optional Unicorn
2.1.4. No original bytes are included. Graphics and keyboard device boundaries
are intercepted; timing, print wait, flag and sound routines execute unchanged.
This is coupled routine execution, not booted DOS or cycle-accurate PC hardware.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path

BUILDS = {
    "4b50c681c224326e09933170823b846e7dbe340dafc76f07ee0af990ebb93400": dict(
        build="2.936", data="b145061a2385d65060d944ad3a2e39a421037d11970f0dcddff4049909c04bf9",
        data_segment=0xa01, irq=0x8521, timer_irq=0x854c, chain=0x182d, divider=0x184f,
        timer=0x7efc, pace=0x7f78, counter=0x1784, fraction=0x1786, paused=0x615,
        keyboard_service=0x449a, print=0x1ce8, draw=0x1d96, close=0x1f2b,
        get_key=0x459e, clear_keys=0x4482, pause=0x257,
        sound_start=0x51d3, sound_lookup=0x50d8, sound_tick=0x801c,
        sound_stop=0x5234, device=0x112e, active=0x1258,
        show_object=0x5edb, show_priority=0x731b, view_lookup=0x3979, view_load=0x39f7,
        view_boundaries=[0x705e, 0x3ae7, 0x14a0, 0x706d, 0x5546],
        inventory=0x3203, inventory_draw=0x3346, inventory_table=0x971,
        restore_dialog=0x2512, save_dialog=0x2753, chooser=0x85e5,
        editor=0xda9, editor_graphics=[0x2390, 0x37f7, 0x382e],
        menu=0x93d1, event=0x4529, menu_state=0x1d2c,
        menu_graphics=[0x2b28, 0x7989, 0x78ad, 0x2ba6, 0x9625,
                       0x9557, 0x95a9, 0x79c3, 0x2b4f, 0x34bd],
    ),
    "ed8b58d354e10b069a1ce137c61bfa3536b2bb9c69cc7510bc864af29daf161e": dict(
        build="3.002.107", data="bb22a87cd215ed52154d49754493e0eb2f6be5688411d8f3b7ac17c417ddae1f",
        data_segment=0xa62, irq=0x8978, timer_irq=0x89a3, chain=0x18b9, divider=0x18db,
        timer=0x8353, pace=0x83cf, counter=0x1806, fraction=0x1808, paused=0x618,
        keyboard_service=0x48ce, print=0x1fb7, draw=0x2065, close=0x21fa,
        get_key=0x49d2, clear_keys=0x48b6, pause=0x257,
        sound_start=0x55ef, sound_lookup=0x54f4, sound_tick=0x8473,
        sound_stop=0x5650, device=0x1191, active=0x12db,
        show_object=0x6323, show_priority=0x7772, view_lookup=0x3d2c, view_load=0x3daa,
        view_boundaries=[0x74b5, 0x3e9a, 0x16fd, 0x74c4, 0x5962],
        inventory=0x35b0, inventory_draw=0x36f9, inventory_table=0x9b6,
        restore_dialog=0x27f3, save_dialog=0x2a46, chooser=0x8a3c,
        editor=0xffe, editor_graphics=[0x265f, 0x3baa, 0x3be1],
        menu=0x988d, event=0x495d, menu_state=0x1dbc,
        menu_graphics=[0x2e2f, 0x7de0, 0x7d04, 0x2e93, 0x9af7,
                       0x9a29, 0x9a7b, 0x7e1a, 0x2e50, 0x3870],
    ),
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("binary", type=Path)
parser.add_argument("data", type=Path)
args = parser.parse_args()
if not args.binary.is_file() or not args.data.is_file():
    print("SKIP: original interpreter and matching data overlay are required")
    raise SystemExit(0)
binary, overlay = args.binary.read_bytes(), args.data.read_bytes()
digest = hashlib.sha256(binary).hexdigest()
assert digest in BUILDS, "Unsupported original executable hash"
p = BUILDS[digest]
assert hashlib.sha256(overlay).hexdigest() == p["data"], "Unexpected data overlay"
try:
    from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_CODE, UC_HOOK_INSN
    from unicorn.x86_const import (
        UC_X86_REG_AX, UC_X86_REG_CS, UC_X86_REG_DS, UC_X86_REG_ES,
        UC_X86_REG_IP, UC_X86_REG_SP, UC_X86_REG_SS, UC_X86_INS_IN, UC_X86_INS_OUT,
    )
except ImportError:
    print("SKIP: optional Unicorn 2.1.4 is required")
    raise SystemExit(0)

CODE = 0x10000
DATA = CODE + p["data_segment"] * 16
STACK = DATA
machine = Uc(UC_ARCH_X86, UC_MODE_16)
machine.mem_map(0, 0x100000)
module = bytearray(binary[struct.unpack_from("<H", binary, 8)[0] * 16:])
relocations, table = struct.unpack_from("<H", binary, 6)[0], struct.unpack_from("<H", binary, 24)[0]
for index in range(relocations):
    offset, segment = struct.unpack_from("<HH", binary, table + index * 4)
    address = segment * 16 + offset
    original = struct.unpack_from("<H", module, address)[0]
    struct.pack_into("<H", module, address, (original + (CODE >> 4)) & 65535)
machine.mem_write(CODE, bytes(module))
for reg, value in [(UC_X86_REG_CS, CODE >> 4), (UC_X86_REG_DS, DATA >> 4),
                   (UC_X86_REG_ES, DATA >> 4), (UC_X86_REG_SS, STACK >> 4)]:
    machine.reg_write(reg, value)
machine.hook_add(UC_HOOK_INSN, lambda *a: 0, None, 1, 0, UC_X86_INS_IN)
machine.hook_add(UC_HOOK_INSN, lambda *a: None, None, 1, 0, UC_X86_INS_OUT)


def byte(address, value=None):
    if value is not None:
        machine.mem_write(DATA + address, bytes([value]))
    return machine.mem_read(DATA + address, 1)[0]


def word(address, value=None):
    if value is not None:
        machine.mem_write(DATA + address, struct.pack("<H", value))
    return struct.unpack("<H", machine.mem_read(DATA + address, 2))[0]


def fresh():
    machine.mem_write(DATA, bytes(65536))
    machine.mem_write(DATA, overlay)
    word(0x129, 0)
    word(0x12b, 0)
    word(p["counter"], 0)
    word(p["fraction"], 0)
    word(p["paused"], 0)
    word(p["active"], 0)
    machine.mem_write(DATA + 0x14, bytes(4))
    machine.mem_write(DATA + 0x109, bytes(32))


def returned(value=0):
    sp = machine.reg_read(UC_X86_REG_SP)
    ret = struct.unpack("<H", machine.mem_read(STACK + sp, 2))[0]
    machine.reg_write(UC_X86_REG_AX, value)
    machine.reg_write(UC_X86_REG_SP, sp + 2)
    machine.reg_write(UC_X86_REG_IP, ret)


waiting = False
intercept_keys = False


def boundary(m, address, size, data):
    global waiting
    at = address - CODE
    if at in [p["keyboard_service"], p["draw"], p["close"], p["clear_keys"], p["inventory_draw"]] + p["editor_graphics"] + p["menu_graphics"] + p["view_boundaries"]:
        returned()
    elif at == p["view_lookup"]:
        returned(0x6100)
    elif at == p["view_load"]:
        returned(1)
    elif at == p["sound_lookup"]:
        returned(0x3000)
    elif at in [p["get_key"], p["event"], p["chooser"]] and intercept_keys:
        waiting = True
        m.emu_stop()


machine.hook_add(UC_HOOK_CODE, boundary)


def run(entry, argument=0, stack=0xff00):
    machine.reg_write(UC_X86_REG_SP, stack)
    machine.mem_write(STACK + stack, struct.pack("<HH", 0xfff0, argument))
    machine.emu_start(CODE + entry, CODE + 0xfff0, count=100000)
    assert machine.reg_read(UC_X86_REG_SP) == stack + 2, "Routine did not return"


def timer(count=1):
    for _ in range(count):
        run(p["timer"], stack=0xdf00)


def state():
    return dict(timer=word(0x129), pacing=word(p["counter"]),
                fraction=word(p["fraction"]), clock=list(machine.mem_read(DATA + 0x14, 4)),
                paused=word(p["paused"]), sound_done=bool(byte(0x10e) & 0x80))


def wait(entry, duration, timed=False):
    """Inject one logical timer service and three sound ticks per key poll."""
    global waiting, intercept_keys
    intercept_keys = True
    waiting = False
    machine.reg_write(UC_X86_REG_SP, 0xff00)
    machine.mem_write(STACK + 0xff00, struct.pack("<HHH", 0xfff0, 0x4000, 8))
    machine.emu_start(CODE + entry, CODE + 0xfff0, count=100000)
    polls = 0
    while waiting:
        waiting = False
        polls += duration if entry in [p["save_dialog"], p["restore_dialog"]] else 1
        assert polls <= duration + 1, "Wait did not terminate"
        registers = machine.context_save()
        timer(duration if entry in [p["save_dialog"], p["restore_dialog"]] else 1)
        for _ in range(3):
            if word(p["active"]):
                run(p["sound_tick"], stack=0xdf00)
        machine.context_restore(registers)
        if entry in [p["save_dialog"], p["restore_dialog"]]:
            returned(0)
        elif entry in [p["menu"], p["inventory"]]:
            word(0x6040, 0 if polls < duration else 1)
            word(0x6042, 27)
            returned(0x6040)
        else:
            returned(0 if timed or polls < duration else 13)
        machine.emu_start(CODE + machine.reg_read(UC_X86_REG_IP), CODE + 0xfff0, count=100000)
    intercept_keys = False
    assert machine.reg_read(UC_X86_REG_SP) == 0xff02, "Wait did not return"
    return dict(polls=polls, **state())


rows = []
fresh()
# A controlled BIOS adapter chains each third hardware IRQ to INT 1Ch. The
# adapter supplies only the documented callback/return boundary, not DOS.
# Both original interrupt handlers and their original timer service execute.
machine.mem_write(CODE + 0xfe00, b"\x9c\x9a" + struct.pack("<HH", p["timer_irq"], CODE >> 4) + b"\xcf")
machine.mem_write(CODE + 0xfe10, b"\xcf")
word(p["chain"], 0xfe00)
word(p["chain"] + 2, CODE >> 4)
word(p["chain"] + 4, 0xfe10)
word(p["chain"] + 6, CODE >> 4)
word(0, 0x7000)
word(0x7000, 0xaaaa)
byte(p["divider"], 3)
byte(0x10a, 0x40)
word(p["device"], 1)
machine.mem_write(DATA + 0x3006, struct.pack("<4H", 0x3100, 0x3107, 0x3107, 0x3107))
machine.mem_write(DATA + 0x3100, struct.pack("<HHBHH", 2, 0x8123, 0x94, 0xffff, 0xffff))
machine.mem_write(DATA + 0x3200, bytes([1, 40]))
run(p["sound_start"], 0x3200)
irq_ticks = []
irq_sound_done = []
for _ in range(60):
    machine.reg_write(UC_X86_REG_SP, 0xff00)
    machine.mem_write(STACK + 0xff00, struct.pack("<HHH", 0xfff0, CODE >> 4, 0x202))
    machine.emu_start(CODE + p["irq"], CODE + 0xfff0, count=100000)
    assert machine.reg_read(UC_X86_REG_SP) == 0xff06, "IRQ did not return"
    irq_ticks.append(word(0x129))
    irq_sound_done.append(state()["sound_done"])
assert irq_ticks == [(index + 1) // 3 for index in range(60)]
assert state()["clock"] == [1, 0, 0, 0]
assert irq_sound_done[:4] == [False, False, True, True]
rows.append(dict(case="sixty hardware-handler invocations with controlled BIOS chaining",
                 timer_trace=irq_ticks, sound_completion_trace=irq_sound_done[:4], **state()))
fresh()
timer(19)
assert state()["clock"] == [0, 0, 0, 0]
timer()
assert state()["clock"] == [1, 0, 0, 0]
rows.append(dict(case="twenty timer services", **state()))
for initial, expected in [([80, 80, 30, 7], [0, 0, 0, 8]),
                          ([255, 90, 30, 255], [0, 0, 0, 0]),
                          ([0, 60, 0, 0], [1, 0, 1, 0])]:
    fresh()
    machine.mem_write(DATA + 0x14, bytes(initial))
    timer(20)
    assert state()["clock"] == expected
    rows.append(dict(case="script-written clock values", initial=initial, **state()))
for delay, ticks in [(0, 0), (1, 1), (4, 4), (255, 255), (2, 1000)]:
    fresh()
    byte(0x13, delay)
    timer(ticks)
    run(p["pace"])
    assert word(p["counter"]) == 0
    rows.append(dict(case="pacing consumes available ticks", delay=delay, supplied=ticks, **state()))
fresh()
byte(0x13, 4)
timer(2)
byte(0x13, 2)
run(p["pace"])
assert word(p["counter"]) == 0
rows.append(dict(case="v10 decrease uses accumulated ticks", **state()))
fresh()
byte(0x1e, 0)
timer(15)
paused = wait(p["pause"], 20)
assert paused["pacing"] == 15 and paused["fraction"] == 15
assert paused["timer"] == 35 and paused["clock"] == [0, 0, 0, 0]
rows.append(dict(case="pause preserves preexisting pacing and clock fraction", **paused))
for entry, label, timed, duration in [(p["print"], "ordinary print", False, 20),
                                    (p["print"], "timed print", True, 10),
                                    (p["pause"], "pause opcode", False, 20),
                                    (p["editor"], "string editor", False, 20),
                                    (p["menu"], "menu interaction", False, 20),
                                    (p["inventory"], "interactive inventory", False, 20),
                                    (p["show_object"], "show object without preview allocation", False, 20),
                                    (p["show_priority"], "show priority", False, 20),
                                    (p["restore_dialog"], "cancel restore selector", False, 20),
                                    (p["save_dialog"], "cancel save selector", False, 20)]:
    fresh()
    byte(0x1e, 1 if timed else 0)
    word(0x5e3, 1)  # v3 menu gate.
    word(0x6000, 0x6000)  # Synthetic circular menu heading.
    word(0x6020, 0x6020)  # Synthetic circular menu item.
    word(p["menu_state"], 0x6000)
    word(p["menu_state"] + 2, 0x6000)
    word(p["menu_state"] + 4, 0x6020)
    byte(0x4000, 0)
    word(0x6103, 0x6200)  # Synthetic loaded view descriptor and description.
    word(0x6203, 5)
    machine.mem_write(DATA + 0x6205, b"Object\0")
    byte(0x10a, 0x44)  # f9 and f13 enabled; f15 clear.
    word(p["inventory_table"], 0)
    word(p["inventory_table"] + 2, 0)
    word(p["device"], 1)
    machine.mem_write(DATA + 0x3006, struct.pack("<4H", 0x3100, 0x3107, 0x3107, 0x3107))
    machine.mem_write(DATA + 0x3100, struct.pack("<HHBHH", 2, 0x8123, 0x94, 0xffff, 0xffff))
    machine.mem_write(DATA + 0x3200, bytes([1, 40]))
    run(p["sound_start"], 0x3200)
    row = wait(entry, duration, timed)
    frozen = entry in [p["pause"], p["save_dialog"], p["restore_dialog"]]
    expected = 0 if frozen else duration // 20
    assert row["clock"] == [expected, 0, 0, 0], (label, row)
    assert row["pacing"] == (0 if frozen else duration)
    assert row["sound_done"]
    assert row["paused"] == 0
    rows.append(dict(case=label, **row))
print(json.dumps(dict(build=p["build"], binary_sha256=digest, data_sha256=p["data"],
                     evidence="coupled routine execution with controlled timer/device inputs",
                     timer_entry=hex(p["timer"]), pacing_entry=hex(p["pace"]),
                     print_entry=hex(p["print"]), cases=rows), indent=2))

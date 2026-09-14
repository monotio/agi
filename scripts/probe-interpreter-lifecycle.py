#!/usr/bin/env python3
"""Execute original Sierra save/restore cores and accepted restart reset.

Optional dependencies: Unicorn 2.1.4 and a privately held original interpreter.
No original interpreter bytes or disassembly are bundled. Unrecognized binaries
are rejected by SHA-256. Missing input produces an explicit skip. Offsets below
are relative to the MZ load module; data addresses are isolated synthetic DS.

This is NOT full DOS emulation: save/restore start after successful file selection
and stop before post-I/O resource reconstruction; INT 21h reads/writes use an
in-memory file. Restart executes its real opcode/reset path but hooks OBJECT
loading and the explicitly listed peripheral call sites. Full startup, hardware timing,
post-restore reconstruction and unlisted profiles remain outside this evidence.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path


PROFILES = {
    "12a52b728b1b1f8d27b21e85cab022a30ef359bca200ba9ed4d6e78a50979f41": {
        "build": "3.002.149", "rng": 0x1548, "main_bytes": 0x404,
        "objects": 0x7d0, "objects_bytes": 0x7d4,
        "inventory": 0x7d6, "inventory_bytes": 0x7da,
        "pairs": 0x153e, "frames": 0x7ea, "description": 0x1aaf,
        "save": (0x2a9f, 0x2b47), "restore": (0x2856, 0x28c7),
        "restart": 0x26e0, "resource_loader": 0x3459, "resource_size": 0xd31,
        "peripheral": [0x5467, 0x3b00, 0x3ad9, 0x3a29, 0x341c, 0x9648],
    },
    "11dce8acb65eda6b4a28e90f8c50019c96c445918d19763d57bd503ede549a79": {
        "build": "2.936 (SQ2, corrected decoded executable)", "rng": 0x1711,
        "main_bytes": 0x5e1, "objects": 0x96b, "objects_bytes": 0x96f,
        "inventory": 0x971, "inventory_bytes": 0x975,
        "pairs": 0x1707, "frames": 0x985, "description": 0x1c6c,
        "save": (0x27fb, 0x28a3), "restore": (0x25d6, 0x2647),
        "restart": 0x2472, "resource_loader": 0x3113, "resource_size": 0xf1a,
        "peripheral": [0x5234, 0x382e, 0x3726, 0x30d6, 0x930e, 0x37f7],
    },
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("binary", type=Path, help="Local games/gr1/AGI or corrected decoded SQ2 2.936 executable")
args = parser.parse_args()
if not args.binary.is_file():
    print(f"SKIP: original interpreter missing: {args.binary}")
    raise SystemExit(0)
binary = args.binary.read_bytes()
binary_hash = hashlib.sha256(binary).hexdigest()
assert binary_hash in PROFILES, "Unexpected interpreter"
profile = PROFILES[binary_hash]
assert binary[:2] == b"MZ", "Expected decoded DOS executable"
try:
    from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_INTR, UC_HOOK_CODE
    from unicorn.x86_const import (
        UC_X86_REG_AX, UC_X86_REG_BP, UC_X86_REG_CS, UC_X86_REG_CX,
        UC_X86_REG_DS, UC_X86_REG_DX, UC_X86_REG_EFLAGS, UC_X86_REG_ES,
        UC_X86_REG_IP, UC_X86_REG_SP, UC_X86_REG_SS,
    )
except ImportError:
    print("SKIP: optional Unicorn 2.1.4 is required for original-binary execution")
    raise SystemExit(0)
module = binary[struct.unpack_from("<H", binary, 8)[0] * 16:]
CODE = 0x10000
DATA = 0x30000
RNG = profile["rng"]


class Probe:
    def __init__(self):
        self.machine = Uc(UC_ARCH_X86, UC_MODE_16)
        self.machine.mem_map(0, 0x100000)
        self.machine.mem_write(CODE, module)
        for register, value in [
            (UC_X86_REG_CS, CODE >> 4), (UC_X86_REG_DS, DATA >> 4),
            (UC_X86_REG_ES, DATA >> 4), (UC_X86_REG_SS, DATA >> 4),
        ]:
            self.machine.reg_write(register, value)
        self.file = bytearray()
        self.file_position = 31
        self.io = []
        self.external_calls = []
        self.machine.hook_add(UC_HOOK_INTR, self.interrupt)

    def word(self, offset, value=None):
        if value is not None:
            self.machine.mem_write(DATA + offset, struct.pack("<H", value))
        return struct.unpack("<H", self.machine.mem_read(DATA + offset, 2))[0]

    def interrupt(self, machine, vector, _):
        assert vector == 0x21, f"Unexpected interrupt {vector:#x}"
        operation = machine.reg_read(UC_X86_REG_AX) >> 8
        count = machine.reg_read(UC_X86_REG_CX)
        address = (machine.reg_read(UC_X86_REG_DS) << 4) + machine.reg_read(UC_X86_REG_DX)
        self.io.append({"operation": operation, "data_offset": address - DATA, "bytes": count})
        if operation == 0x40:
            self.file.extend(machine.mem_read(address, count))
        elif operation == 0x3f:
            payload = self.file[self.file_position:self.file_position + count]
            assert len(payload) == count, "Read beyond synthetic save"
            machine.mem_write(address, bytes(payload))
            self.file_position += count
        else:
            raise AssertionError(f"Unexpected DOS operation {operation:#x}")
        machine.reg_write(UC_X86_REG_AX, count)
        machine.reg_write(UC_X86_REG_EFLAGS, machine.reg_read(UC_X86_REG_EFLAGS) & ~1)

    def core(self, start, stop):
        self.machine.reg_write(UC_X86_REG_BP, 0xf000)
        self.machine.reg_write(UC_X86_REG_SP, 0xef00)
        self.word(0xf000 - 0xcc, 5)  # Selected DOS handle, caller's stack frame.
        self.machine.emu_start(CODE + start, CODE + stop, count=100000)
        assert self.machine.reg_read(UC_X86_REG_IP) == stop, "Core failed to finish"

    def save_restore(self, saved_rng, current_rng):
        self.word(RNG, saved_rng)
        # Synthetic, distinct block payloads. The original writer chooses every
        # block address and size; the probe does not enumerate blocks for it.
        self.machine.mem_write(DATA + 2, bytes(i % 251 for i in range(profile["main_bytes"])))
        for offset, value in [
            (profile["objects"], 0x4000), (profile["objects_bytes"], 43),
            (profile["inventory"], 0x5000), (profile["inventory_bytes"], 30),
            (profile["pairs"], 0x6000), (0x141, 3),
        ]:
            self.word(offset, value)
        for offset, count in [(0x4000, 43), (0x5000, 30), (0x6000, 6)]:
            self.machine.mem_write(DATA + offset, bytes([offset >> 8]) * count)
        self.core(*profile["save"])
        assert self.word(RNG) == saved_rng
        writes = list(self.io)
        payloads = [(row["data_offset"], row["bytes"]) for row in writes if row["bytes"] > 1]
        assert payloads == [(profile["description"], 31), (2, profile["main_bytes"]), (0x4000, 43),
                            (0x5000, 30), (0x6000, 6), (profile["frames"], 8)]
        assert all(not (start <= RNG < start + size) for start, size in payloads)
        self.word(RNG, current_rng)
        self.machine.mem_write(DATA + 2, bytes(profile["main_bytes"]))
        self.io.clear()
        self.core(*profile["restore"])
        assert self.word(RNG) == current_rng, "Restore unexpectedly rewound RNG"
        assert self.file_position == len(self.file)
        assert self.machine.mem_read(DATA + 9, 1)[0] == 7, "Main block not restored"
        return {"saved_rng": saved_rng, "current_rng_after_restore": self.word(RNG),
                "file_bytes": len(self.file), "write_payloads": payloads}

    def return_from_external(self, ax):
        stack = self.machine.reg_read(UC_X86_REG_SP)
        self.machine.reg_write(UC_X86_REG_IP, self.word(stack))
        self.machine.reg_write(UC_X86_REG_SP, stack + 2)
        self.machine.reg_write(UC_X86_REG_AX, ax)

    def external(self, machine, address, size, _):
        offset = address - CODE
        # Resource loading is replaced with one small synthetic OBJECT image.
        # These other dependencies are intentionally not claimed as executed.
        # Exact addresses are listed in PROFILES and emitted in the report.
        # No timing, graphics, sound or resource-I/O fidelity is claimed here.
        if offset == profile["resource_loader"]:
            self.external_calls.append(offset)
            self.return_from_external(0x5000)
        elif offset in profile["peripheral"]:
            self.external_calls.append(offset)
            self.return_from_external(0)

    def restart(self, seed, sound_enabled):
        self.word(RNG, seed)
        self.word(profile["objects"], 0x4000)
        self.word(profile["objects_bytes"], 86)
        self.word(profile["resource_size"], 9)
        self.machine.mem_write(DATA + 0x5000, bytes([6, 0, 1, 0, 0, 0, 0, 0, 0]))
        self.machine.mem_write(DATA + 0x10b, bytes([0x80]))  # f16 skips confirmation.
        self.machine.mem_write(DATA + 0x10a, bytes([0x40 if sound_enabled else 0]))
        self.word(0x129, 123)
        self.word(0x12b, 456)
        self.machine.hook_add(UC_HOOK_CODE, self.external)
        self.machine.reg_write(UC_X86_REG_SP, 0xff00)
        self.word(0xff00, 0xfff0)
        self.word(0xff02, 0x2000)
        self.machine.emu_start(CODE + profile["restart"], CODE + 0xfff0, count=100000)
        assert self.machine.reg_read(UC_X86_REG_SP) == 0xff02, "Restart did not return"
        assert self.word(RNG) == seed
        assert self.word(0x129) == 0 and self.word(0x12b) == 0
        assert self.machine.mem_read(DATA + 0x109, 1)[0] & 2  # f6 set.
        assert bool(self.machine.mem_read(DATA + 0x10a, 1)[0] & 0x40) == sound_enabled
        return {"rng_before_and_after": seed, "sound_enabled_before_and_after": sound_enabled,
                "timing_words_after": [self.word(0x129), self.word(0x12b)],
                "f6": True, "intercepted_calls": [hex(x) for x in self.external_calls]}


saves = [Probe().save_restore(saved, current) for saved, current in
         [(0, 1), (1, 0), (0xbeef, 0x1234), (0xffff, 0xbeef)]]
restarts = [Probe().restart(seed, sound) for seed in [0, 1, 0xbeef, 0xffff]
            for sound in [False, True]]
print(json.dumps({"build": profile["build"], "sha256": binary_hash,
                  "save_restore": saves, "accepted_restart": restarts}, indent=2))

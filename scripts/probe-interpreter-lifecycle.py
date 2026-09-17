#!/usr/bin/env python3
"""Execute original Sierra save/restore cores and accepted restart reset.

Optional dependencies: Unicorn 2.1.4 and a privately held original interpreter.
No original interpreter bytes or disassembly are bundled. Unrecognized binaries
are rejected by SHA-256. Missing input produces an explicit skip. Offsets below
are relative to the MZ load module; data addresses are isolated synthetic DS.

This is NOT full DOS emulation. The I/O cores use an in-memory file. A separate
probe executes reconstruction dispatch, cache reset, resume-offset lookup and
object-record transitions with synthetic resource returns and intercepted
rendering. Restart hooks OBJECT loading and listed peripheral calls. Full
startup, hardware timing, resource bodies and script resumption remain outside
this evidence; reports enumerate the intercepted reconstruction calls.
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
        "reconstruct": 0x6b94, "replay_gate": 0x1544,
        "restore_return": 0x2941,
        "animate": 0x04ee, "draw": 0x0c54, "erase": 0x0cf9, "unanimate": 0x0536,
        "draw_position": 0x5cb3,
        "data_sha256": "914990f09b49109a34d511011c7764abb5575581fbc190c8cebc930b1027f804",
        "startup": 0x115c, "random": 0x753e, "allocate": 0x15ec,
        "dispatch": 0x440, "rebuild_lists": 0x6e06,
        "refresh_objects": 0x0481, "render_object": 0x598f,
        "main": 0x0149, "main_wait": 0x828c, "main_logic": 0x14c3,
        "main_calls": {0x115c: "startup", 0x6574: "input", 0x38ce: "events",
                       0x654: "motion before logic", 0x81f4: "trace",
                       0x380f: "status", 0x55c: "motion after logic"},
        "startup_peripheral": [0x850b, 0x44de, 0x7b09, 0x3b66, 0x46be, 0x13a8],
        "erase_rendering": [0x6db5, 0x6d9e, 0x457, 0x598f],
        "reconstruction_calls": {
            0x5467: "stop sound", 0x12de: "clear resource caches",
            0x169b: "reset allocator", 0x13a8: "load logic",
            0x15ba: "mark logic", 0x3c5b: "load view", 0x4c96: "load picture",
            0x5359: "load sound", 0x4d2a: "draw picture", 0x2fcc: "add to picture",
            0x4e29: "discard picture", 0x4171: "discard view", 0x4d96: "overlay picture",
            0x3bdd: "lookup view", 0x3d4b: "bind view", 0x0c54: "draw object",
            0x6ebc: "stop update", 0x3ad9: "presentation 1", 0x3a29: "presentation 2",
            0x576f: "presentation 3", 0x380f: "status", 0x3b66: "input",
            0x60e0: "close save handle", 0x341c: "close resource handles",
            0x9648: "restore selector presentation",
        },
    },
    "11dce8acb65eda6b4a28e90f8c50019c96c445918d19763d57bd503ede549a79": {
        "build": "2.936 (SQ2, corrected decoded executable)", "rng": 0x1711,
        "main_bytes": 0x5e1, "objects": 0x96b, "objects_bytes": 0x96f,
        "inventory": 0x971, "inventory_bytes": 0x975,
        "pairs": 0x1707, "frames": 0x985, "description": 0x1c6c,
        "save": (0x27fb, 0x28a3), "restore": (0x25d6, 0x2647),
        "restart": 0x2472, "resource_loader": 0x3113, "resource_size": 0xf1a,
        "peripheral": [0x5234, 0x382e, 0x3726, 0x30d6, 0x930e, 0x37f7],
        "reconstruct": 0x681c, "replay_gate": 0x170d,
        "restore_return": 0x26af,
        "animate": 0x04f5, "draw": 0x0a06, "erase": 0x0aab, "unanimate": 0x053d,
        "draw_position": 0x593a,
        "data_sha256": "b145061a2385d65060d944ad3a2e39a421037d11970f0dcddff4049909c04bf9",
        "startup": 0x0f4e, "random": 0x71c0, "allocate": 0x13d6,
        "dispatch": 0x61d, "rebuild_lists": 0x6a8e,
        "refresh_objects": 0x0488, "render_object": 0x5762,
        "main": 0x0150, "main_wait": 0x7f78, "main_logic": 0x12ae,
        "main_calls": {0x0f4e: "startup", 0x61f2: "input", 0x357c: "events",
                       0x644: "motion before logic", 0x7ee0: "trace",
                       0x34bd: "status", 0x563: "motion after logic"},
        "startup_peripheral": [0x81f7, 0x4305, 0x77d5, 0x38d7, 0x4473, 0x119a],
        "erase_rendering": [0x6a3d, 0x6a26, 0x45e, 0x5762],
        "reconstruction_calls": {
            0x5234: "stop sound", 0x10d0: "clear resource caches",
            0x1485: "reset allocator", 0x119a: "load logic",
            0x13a5: "mark logic", 0x39f7: "load view", 0x4a3b: "load picture",
            0x5126: "load sound", 0x4acf: "draw picture", 0x2d52: "add to picture",
            0x4bce: "discard picture", 0x3f0d: "discard view", 0x4b3b: "overlay picture",
            0x3979: "lookup view", 0x3ae7: "bind view", 0x0a06: "draw object",
            0x6b44: "stop update", 0x382e: "presentation 1", 0x3726: "presentation 2",
            0x5546: "presentation 3", 0x34bd: "status", 0x38d7: "input",
            0x5d52: "close save handle", 0x30d6: "close resource handles",
            0x930e: "restore selector presentation",
        },
    },
}
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("binary", type=Path, help="Local games/gr1/AGI or corrected decoded SQ2 2.936 executable")
parser.add_argument("--data", type=Path, help="Matching AGIDATA.OVL for startup initialization probes")
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
    from unicorn import Uc, UC_ARCH_X86, UC_MODE_16, UC_HOOK_INTR, UC_HOOK_CODE, UC_HOOK_MEM_WRITE
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
        self.bios_input = None
        self.bios_reads = 0
        self.machine.hook_add(UC_HOOK_INTR, self.interrupt)

    def word(self, offset, value=None):
        if value is not None:
            self.machine.mem_write(DATA + offset, struct.pack("<H", value))
        return struct.unpack("<H", self.machine.mem_read(DATA + offset, 2))[0]

    def interrupt(self, machine, vector, _):
        if vector == 0x1a and self.bios_input is not None:
            assert machine.reg_read(UC_X86_REG_AX) >> 8 == 0
            self.bios_reads += 1
            machine.reg_write(UC_X86_REG_DX, self.bios_input)
            return
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
        assert self.machine.reg_read(UC_X86_REG_AX) == 0, "Accepted restart must abort bytecode"
        assert self.word(0x129) == 0 and self.word(0x12b) == 0
        assert self.machine.mem_read(DATA + 0x109, 1)[0] & 2  # f6 set.
        assert bool(self.machine.mem_read(DATA + 0x10a, 1)[0] & 0x40) == sound_enabled
        return {"rng_before_and_after": seed, "sound_enabled_before_and_after": sound_enabled,
                "timing_words_after": [self.word(0x129), self.word(0x12b)],
                "f6": True, "intercepted_calls": [hex(x) for x in self.external_calls]}

    def reconstruction(self, flags, motion):
        """Execute replay dispatch and object rebuilding, intercepting I/O/rendering.

        Expected vectors follow the routine's branches independently of the engine.
        Resource bodies, view rebinding, rendering and allocator reset are explicit
        intercepts, not evidence that those subsystems execute correctly.
        """
        obj = 0x4000
        self.word(RNG, 0xbeef)
        self.word(profile["objects"], obj)
        self.word(profile["objects"] + 2, obj + 43)
        self.word(obj + 3, 73)
        self.word(obj + 5, 91)
        self.word(obj + 0x25, flags)
        self.machine.mem_write(DATA + obj + 7, bytes([5]))
        self.machine.mem_write(DATA + obj + 0x22, bytes([motion]))
        self.machine.mem_write(DATA + obj + 0x27, bytes([7, 61, 19, 23]))
        # The cache head is global logic 0; another previously cached node is
        # cut off by the original reset. Saved resume records do not themselves
        # call the loader: only the replayed kind-0 pair requests logic 21.
        cache = profile["frames"] - 14
        self.word(cache, 0x6800)
        self.word(0x6800, 0x6900)
        self.machine.mem_write(DATA + 0x6802, bytes([0]))
        self.machine.mem_write(DATA + 0x6902, bytes([88]))
        self.machine.mem_write(DATA + profile["frames"], struct.pack(
            "<8H", 0, 0, 21, 0x33, 99, 0x44, 0xffff, 0))
        self.machine.mem_write(DATA + 0x7002, bytes([21]))
        self.word(0x7004, 0x7100)
        self.word(0x7006, 0x7100)
        # Each resource kind has a distinct operand; kind 5 consumes three
        # additional pairs instead of dispatching their first bytes as kinds.
        pairs = [(0, 21), (1, 22), (2, 23), (3, 24), (4, 25),
                 (5, 0), (5, 1), (2, 30), (90, 0x41),
                 (6, 26), (7, 27), (8, 28)]
        self.word(profile["pairs"], 0x6000)
        self.word(0x143, len(pairs))
        self.machine.mem_write(DATA + 0x6000, bytes(v for pair in pairs for v in pair))
        calls = []

        def intercept(machine, address, size, _):
            name = profile["reconstruction_calls"].get(address - CODE)
            if name is None:
                return
            if name in ["clear resource caches", "reset allocator", "mark logic"]:
                return  # Execute these original routines, including resume lookup.
            stack = machine.reg_read(UC_X86_REG_SP)
            arguments = [self.word(stack + 2), self.word(stack + 4)]
            calls.append({"call": name, "arguments": arguments,
                          "replay_enabled": self.word(profile["replay_gate"])})
            self.return_from_external(0x7000 if name in ["lookup view", "load logic"] else 0)

        self.machine.hook_add(UC_HOOK_CODE, intercept)
        self.machine.reg_write(UC_X86_REG_SP, 0xff00)
        self.word(0xff00, 0xfff0)
        self.machine.emu_start(CODE + profile["reconstruct"], CODE + 0xfff0, count=100000)
        assert self.machine.reg_read(UC_X86_REG_SP) == 0xff02, "Reconstruction did not return"
        expected_retry = 255 if flags & 0x41 == 0x41 and motion == 2 else 19
        expected_params = [7, 61, expected_retry, 23]
        assert list(self.machine.mem_read(DATA + obj + 0x27, 4)) == expected_params
        assert self.word(obj + 3) == 73 and self.word(obj + 5) == 91
        assert self.word(obj + 0x25) == flags
        assert self.word(RNG) == 0xbeef
        assert self.word(cache) == 0x6800 and self.word(0x6800) == 0
        assert self.word(0x7006) == 0x7133
        resources = [row for row in calls if row["call"] in [
            "load logic", "load view", "load picture", "load sound", "draw picture",
            "add to picture", "discard picture", "discard view", "overlay picture"]]
        assert [row["call"] for row in resources] == [
            "load logic", "load view", "load picture", "load sound", "draw picture",
            "add to picture", "discard picture", "discard view", "overlay picture"]
        assert [row["arguments"][0] for row in resources if row["call"] != "add to picture"] == list(range(21, 29))
        assert all(row["replay_enabled"] == 0 for row in resources)
        assert self.word(profile["replay_gate"]) == 1
        assert sum(row["call"] == "draw object" for row in calls) == (flags & 0x41 == 0x41)
        assert sum(row["call"] == "stop update" for row in calls) == (flags & 0x51 == 0x41)
        # Execute the actual successful restore tail, including another real
        # reconstruction call, f12 setting and its zero continuation result.
        # This reaches the opcode return; it does not execute a later main loop.
        self.core(profile["restore"][1], profile["restore_return"])
        assert self.machine.mem_read(DATA + 0x10a, 1)[0] & 8  # f12
        assert self.machine.reg_read(UC_X86_REG_AX) == 0
        stack = self.machine.reg_read(UC_X86_REG_SP)
        self.word(stack, 0xfff0)
        self.machine.emu_start(CODE + profile["restore_return"], CODE + 0xfff0, count=10)
        assert self.machine.reg_read(UC_X86_REG_SP) == stack + 2
        return {"flags": flags, "motion": motion, "parameters_after": expected_params,
                "position_after": [73, 91], "rng_after": self.word(RNG),
                "retained_cache_head_logic": 0, "replayed_logic_resume": 0x33,
                "unreplayed_resume_record": 99, "restore_f12": True,
                "restore_continuation_result": 0, "calls": calls}

    def object_lifecycle(self, initial_flags):
        obj = 0x4000
        self.word(profile["objects"], obj)
        self.word(profile["objects"] + 2, obj + 43)
        self.word(obj + 0x25, initial_flags)
        self.machine.mem_write(DATA + obj + 0x21, bytes([7, 2, 3]))

        def rendering(machine, address, size, _):
            if address - CODE in profile["erase_rendering"] + [profile["draw_position"]]:
                self.return_from_external(0)

        self.machine.hook_add(UC_HOOK_CODE, rendering)

        def call(name):
            self.machine.reg_write(UC_X86_REG_SP, 0xff00)
            self.word(0xff00, 0xfff0)
            self.word(0xff02, 0)  # Object zero, not a bytecode pointer.
            self.machine.emu_start(CODE + profile[name], CODE + 0xfff0, count=100000)
            assert self.machine.reg_read(UC_X86_REG_SP) == 0xff02

        call("animate")
        animated_flags = initial_flags if initial_flags & 0x40 else 0x70
        assert self.word(obj + 0x25) == animated_flags
        assert list(self.machine.mem_read(DATA + obj + 0x21, 3)) == (
            [7, 2, 3] if initial_flags & 0x40 else [0, 0, 0])
        # The original draw body sets drawn/update and clears its initial
        # cycle-delay bit; positioning and rendering dependencies are explicit
        # intercepts. A nonzero synthetic cel token satisfies the entry check.
        self.word(obj + 0x10, 0x7000)
        self.word(obj + 0x25, animated_flags & ~1)
        call("draw")
        drawn_flags = (animated_flags | 0x11) & ~0x1000
        assert self.word(obj + 0x25) == drawn_flags
        call("erase")
        assert self.word(obj + 0x25) == drawn_flags & ~1
        call("unanimate")
        assert self.word(obj + 0x25) == drawn_flags & ~0x41
        return {"initial_flags": initial_flags, "after_animate": animated_flags,
                "after_draw": drawn_flags, "after_erase": drawn_flags & ~1,
                "after_unanimate": drawn_flags & ~0x41}

    def startup(self, data, bios_input):
        """Execute game-state startup with a real, hash-pinned data overlay.

        DOS executable entry/overlay loading and hardware initialization remain
        outside this boundary. OBJECT bytes are an authored encrypted fixture;
        allocation and initial WORDS/logic loading are explicit synthetic returns.
        """
        self.machine.mem_write(DATA, data)
        assert self.word(RNG) == 0, "Overlay RNG initialization changed"
        self.bios_input = bios_input
        writes = []

        def rng_write(machine, access, address, size, value, _):
            if address <= DATA + RNG < address + size:
                writes.append({"pc": machine.reg_read(UC_X86_REG_IP), "value": value})

        def startup_external(machine, address, size, _):
            offset = address - CODE
            if offset == profile["resource_loader"]:
                self.external_calls.append(offset)
                raw = bytes([6, 0, 1, 0, 0, 0, 0, 0, 0])
                key = b"Avis Durgan"
                self.machine.mem_write(DATA + 0x5000, bytes(v ^ key[i % len(key)] for i, v in enumerate(raw)))
                self.word(profile["resource_size"], len(raw))
                self.return_from_external(0x5000)
            elif offset == profile["allocate"]:
                self.external_calls.append(offset)
                self.return_from_external(0x4000)
            elif offset in profile["startup_peripheral"]:
                self.external_calls.append(offset)
                self.return_from_external(0)

        self.machine.hook_add(UC_HOOK_CODE, startup_external)
        self.machine.hook_add(UC_HOOK_MEM_WRITE, rng_write)

        def call(entry):
            self.machine.reg_write(UC_X86_REG_SP, 0xff00)
            self.word(0xff00, 0xfff0)
            self.machine.emu_start(CODE + entry, CODE + 0xfff0, count=100000)
            assert self.machine.reg_read(UC_X86_REG_SP) == 0xff02

        call(profile["startup"])
        assert self.word(RNG) == 0 and not writes and self.bios_reads == 0
        assert self.word(profile["objects"]) == 0x4000
        assert self.word(profile["objects_bytes"]) == 86
        assert list(self.machine.mem_read(DATA + 0x4000, 43)) == [0] * 43
        assert self.machine.mem_read(DATA + 0x402d, 1)[0] == 1
        assert self.machine.mem_read(DATA + 0x109, 1)[0] & 0x04  # f5
        assert self.machine.mem_read(DATA + 0x10a, 1)[0] & 0x40  # f9
        assert self.machine.mem_read(DATA + 9 + 24, 1)[0] == 41
        call(profile["random"])
        expected = (bios_input * 0x7c4d + 1) & 0xffff
        assert self.word(RNG) == expected and self.bios_reads == 1
        assert self.machine.reg_read(UC_X86_REG_AX) == ((expected >> 8) ^ (expected & 255))
        return {"overlay_initial_rng": 0, "rng_after_game_state_startup": 0,
                "bios_reads_during_startup": 0, "f5": True, "f9": True, "v24": 41,
                "first_draw_bios_input": bios_input,
                "rng_after_first_draw": expected, "rng_writes": writes,
                "intercepted_calls": [hex(x) for x in self.external_calls]}

    def flag_handlers(self, data):
        """Execute opcode entries selected by the hash-pinned dispatch table."""
        obj = 0x4000
        self.word(profile["objects"], obj)
        self.word(profile["objects"] + 2, obj + 43)

        def redraw(machine, address, size, _):
            if address - CODE == profile["rebuild_lists"]:
                self.return_from_external(0)

        self.machine.hook_add(UC_HOOK_CODE, redraw)
        cases = [
            ("fix.loop", 0x2d, 0, 0x2000), ("release.loop", 0x2e, 0x2000, 0),
            ("set.priority", 0x36, 0, 4), ("release.priority", 0x38, 4, 0),
            ("stop.update", 0x3a, 0x10, 0), ("start.update", 0x3b, 0, 0x10),
            ("ignore.horizon", 0x3d, 0, 8), ("observe.horizon", 0x3e, 8, 0),
            ("obj.on.water", 0x40, 0, 0x100), ("obj.on.land", 0x41, 0, 0x800),
            ("obj.on.anything", 0x42, 0x900, 0),
            ("ignore.objs", 0x43, 0, 0x200), ("observe.objs", 0x44, 0x200, 0),
            ("stop.cycling", 0x46, 0x20, 0), ("start.cycling", 0x47, 0, 0x20),
            ("end.of.loop", 0x49, 0, 0x1030), ("reverse.loop", 0x4b, 0, 0x1030),
            ("ignore.blocks", 0x58, 0, 2), ("observe.blocks", 0x59, 2, 0),
        ]
        rows = []
        for name, opcode, clear, set_bits in cases:
            entry = struct.unpack_from("<H", data, profile["dispatch"] + opcode * 4)[0]
            for initial in [0, 0xffff]:
                self.word(obj + 0x25, initial)
                self.machine.mem_write(DATA + 0x6000, bytes([0, 61]))
                self.machine.reg_write(UC_X86_REG_SP, 0xff00)
                self.word(0xff00, 0xfff0)
                self.word(0xff02, 0x6000)
                self.machine.emu_start(CODE + entry, CODE + 0xfff0, count=100000)
                assert self.machine.reg_read(UC_X86_REG_SP) == 0xff02
                expected = (initial & ~clear) | set_bits
                assert self.word(obj + 0x25) == expected, name
                rows.append({"command": name, "entry": hex(entry), "before": initial,
                             "after": expected})
        return rows

    def stationary_flag(self, previous, current, interval, countdown, initial):
        obj = 0x4000
        self.word(0x6000, 0x6800)
        self.word(0x6800, 0)
        self.word(0x6804, obj)
        self.machine.mem_write(DATA + obj, bytes([interval, countdown]))
        self.word(obj + 3, current[0])
        self.word(obj + 5, current[1])
        self.word(obj + 0x16, previous[0])
        self.word(obj + 0x18, previous[1])
        self.word(obj + 0x25, initial)

        def render(machine, address, size, _):
            if address - CODE == profile["render_object"]:
                self.return_from_external(0)

        self.machine.hook_add(UC_HOOK_CODE, render)
        self.machine.reg_write(UC_X86_REG_SP, 0xff00)
        self.word(0xff00, 0xfff0)
        self.word(0xff02, 0x6000)
        self.machine.emu_start(CODE + profile["refresh_objects"], CODE + 0xfff0, count=100000)
        assert self.machine.reg_read(UC_X86_REG_SP) == 0xff02
        changed = current != previous and interval == countdown
        expected = initial if interval != countdown else 0x0171 if changed else 0x4171
        assert self.word(obj + 0x25) == expected
        assert [self.word(obj + 0x16), self.word(obj + 0x18)] == (current if changed else previous)
        return {"previous": previous, "current": current, "interval": interval,
                "countdown": countdown, "flags_before": initial,
                "flags_after": self.word(obj + 0x25)}

    def main_loop_abort(self, flag):
        """Run original main-loop control using the proven zero opcode result.

        Logic bodies and peripherals are supplied boundaries, not game LOGIC
        execution. The original loop itself decides whether to poll/wait/move
        before dispatching logic again after the zero continuation result.
        """
        self.word(profile["objects"], 0x4000)
        self.word(profile["objects"] + 2, 0x402b)
        calls = []
        observations = []
        waits = 0

        def main_call(machine, address, size, _):
            nonlocal waits
            offset = address - CODE
            if offset == profile["main_wait"]:
                waits += 1
                if waits == 2:
                    machine.emu_stop()
                else:
                    calls.append("wait")
                    self.return_from_external(0)
            elif offset == profile["main_logic"]:
                calls.append("logic")
                observations.append(bool(self.machine.mem_read(DATA + 0x109 + flag // 8, 1)[0]
                                         & (0x80 >> (flag % 8))))
                if len(observations) == 1:
                    # The preceding original restore/restart probes establish
                    # these opcode outputs: corresponding flag set and AX=0.
                    address = DATA + 0x109 + flag // 8
                    self.machine.mem_write(address, bytes([0x80 >> (flag % 8)]))
                    self.return_from_external(0)
                else:
                    self.return_from_external(1)
            elif offset in profile["main_calls"]:
                calls.append(profile["main_calls"][offset])
                self.return_from_external(0)

        self.machine.hook_add(UC_HOOK_CODE, main_call)
        self.machine.reg_write(UC_X86_REG_SP, 0xff00)
        self.machine.emu_start(CODE + profile["main"], CODE + 0xfff0, count=100000)
        assert waits == 2
        assert observations == [False, True]
        assert calls == ["startup", "wait", "input", "events", "motion before logic",
                         "trace", "logic", "logic", "motion after logic"]
        assert self.machine.mem_read(DATA + 0x109 + flag // 8, 1)[0] & (0x80 >> (flag % 8)) == 0
        return {"abort_flag": flag, "logic_observations": observations, "calls": calls,
                "flag_after_cycle": False}


saves = [Probe().save_restore(saved, current) for saved, current in
         [(0, 1), (1, 0), (0xbeef, 0x1234), (0xffff, 0xbeef)]]
restarts = [Probe().restart(seed, sound) for seed in [0, 1, 0xbeef, 0xffff]
            for sound in [False, True]]
reconstructions = [Probe().reconstruction(flags, motion)
                   for flags in [0, 1, 0x40, 0x41, 0x51, 0x1041, 0xffff]
                   for motion in [0, 1, 2, 3]]
objects = [Probe().object_lifecycle(flags) for flags in [0, 0x10, 0x41, 0x51, 0x2041, 0xffff]]
stationary = [Probe().stationary_flag([73, 91], position, 3, countdown, initial)
              for position in [[73, 91], [74, 91], [73, 92]] for countdown in [1, 3]
              for initial in [0x0171, 0x4171]]
main_loop = [Probe().main_loop_abort(flag) for flag in [6, 12]]
startup = {"skip": "matching AGIDATA.OVL not supplied"}
if args.data is not None:
    data = args.data.read_bytes()
    assert hashlib.sha256(data).hexdigest() == profile["data_sha256"], "Unexpected data overlay"
    startup = {"data_sha256": profile["data_sha256"],
               "cases": [Probe().startup(data, value) for value in [0, 1, 0x1234, 0xffff]],
               "flag_handlers": Probe().flag_handlers(data)}
print(json.dumps({"build": profile["build"], "sha256": binary_hash,
                  "save_restore": saves, "accepted_restart": restarts,
                  "reconstruction_dispatch": reconstructions,
                  "object_lifecycle": objects, "stationary_flag": stationary,
                  "game_state_startup": startup, "main_loop_abort": main_loop}, indent=2))

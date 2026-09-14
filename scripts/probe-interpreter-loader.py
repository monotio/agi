#!/usr/bin/env python3
"""Compare the TypeScript descrambler with execution of a local original loader.

Requires optional Unicorn 2.1.4. COM entry is its DOS offset (file offset + 0x100).
Original interpreter/loader bytes stay local; the script bundles none.
"""
import argparse
import hashlib
import struct
import subprocess
import tempfile
from pathlib import Path

from unicorn import Uc, UC_ARCH_X86, UC_MODE_16
from unicorn.x86_const import (
    UC_X86_REG_CS, UC_X86_REG_DS, UC_X86_REG_ES, UC_X86_REG_SS,
    UC_X86_REG_SP,
)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("game", type=Path)
parser.add_argument("--loader", required=True)
parser.add_argument("--entry", type=lambda text: int(text, 0), required=True)
args = parser.parse_args()
loader = (args.game / args.loader).read_bytes()
agi_path = next(path for path in args.game.iterdir() if path.name.upper() == "AGI")
raw = agi_path.read_bytes()
assert len(raw) % 128 == 0, "This probe expects the original loader's full blocks"
assert len(raw) < 65536 and len(loader) + 256 < 65536
u = Uc(UC_ARCH_X86, UC_MODE_16)
u.mem_map(0, 0x100000)
u.mem_write(0x10100, loader)
u.mem_write(0x30000, raw)
for register, value in [
    (UC_X86_REG_CS, 0x1000), (UC_X86_REG_DS, 0x1000),
    (UC_X86_REG_ES, 0x1000), (UC_X86_REG_SS, 0x5000),
    (UC_X86_REG_SP, 0xff00),
]:
    u.reg_write(register, value)
# The loader accepts segment start/end, key segment and key offset.
u.mem_write(0x5ff00, struct.pack(
    "<5H", 0xfff0, 0x3000, 0x3000 + len(raw) // 16, 0x1000, 0x141
))
u.emu_start(0x10000 + args.entry, 0x1fff0, count=5000000)
assert u.reg_read(UC_X86_REG_SP) == 0xff02, "Loader did not return"
original = bytes(u.mem_read(0x30000, len(raw)))
repo = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix="agi-loader-probe-") as directory:
    output = Path(directory) / "decoded.bin"
    subprocess.run([
        "node", "--experimental-strip-types", str(repo / "scripts/descramble-agi.ts"),
        str(args.game.resolve()), str(output), args.loader,
    ], check=True, capture_output=True, text=True)
    actual = output.read_bytes()
assert actual == original, "TypeScript output differs from original loader execution"
print(f"{args.game}: all {len(raw)} decoded bytes match")
print(f"loader SHA256 {hashlib.sha256(loader).hexdigest()}")
print(f"shipped SHA256 {hashlib.sha256(raw).hexdigest()}")
print(f"decoded SHA256 {hashlib.sha256(original).hexdigest()}")

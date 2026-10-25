"""Verify separate ESP images and the declared partition layout.

Layouts: `passport` keeps the protected AI Passport C3 app/cardid regions;
`epaper` checks the headless Waveshare S3 app and queue regions.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def verify_partitions(data: bytes, layout: str) -> dict[str, tuple[int, int, int, int]]:
    partitions = {}
    regions = []
    for start in range(0, len(data), 32):
        entry = data[start:start + 32]
        if entry[:2] in (b"\xff\xff", b"\xeb\xeb"):
            break
        require(len(entry) == 32 and entry[:2] == b"\xaa\x50", "Invalid partition entry")
        _, typ, sub, offset, size, raw_label, _ = struct.unpack("<HBBII16sI", entry)
        label = raw_label.rstrip(b"\0").decode("ascii")
        require(label not in partitions, "Duplicate partition label")
        require(size > 0 and offset >= 0x9000 and offset + size <= 0x800000,
                "Partition outside available 8 MB Flash")
        require(all(offset + size <= lo or offset >= hi for lo, hi in regions),
                "Overlapping partitions")
        partitions[label] = (typ, sub, offset, size)
        regions.append((offset, offset + size))
    require(partitions.get("factory") == (0, 0, 0x10000, 0x300000),
            "Factory partition must retain its 3 MB limit")
    if layout == "passport":
        require(partitions.get("cardid") == (1, 2, 0x356000, 0x4000),
                "Protected cardid partition moved or missing")
    else:
        require(partitions.get("cpqueue") == (1, 0x40, 0x360000, 0x400000),
                "Queue partition moved or missing")
    return partitions


def verify(build: Path, layout: str = "passport") -> dict:
    build = build.resolve()
    chip_id, target = {"passport": (5, "esp32c3"), "epaper": (9, "esp32s3")}[layout]
    args = json.loads((build / "flasher_args.json").read_text())
    files = {int(offset, 0): name for offset, name in args["flash_files"].items()}
    require(set(files) == {0, 0x8000, 0x10000},
            "Only separate bootloader, partition and application images are permitted")
    report = {"target": target, "images": {}}
    for offset, name in files.items():
        path = (build / name).resolve()
        require(path.is_relative_to(build), "Image path escapes build directory")
        data = path.read_bytes()
        limit = {0: 0x8000, 0x8000: 0x9000, 0x10000: 0x310000}[offset]
        require(data and offset + len(data) <= limit, "Image crosses protected boundary")
        if offset == 0x8000:
            verify_partitions(data, layout)
        else:
            require(len(data) >= 24 and data[0] == 0xE9, "Invalid ESP image header")
            require(data[3] >> 4 == 3, "Image must declare 8 MB Flash")
            require(struct.unpack_from("<H", data, 12)[0] == chip_id,
                    f"Image target must be {target}")
        report["images"][name] = {
            "offset": hex(offset), "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build", type=Path)
    parser.add_argument("--layout", choices=("passport", "epaper"), default="passport")
    options = parser.parse_args()
    print(json.dumps(verify(options.build, options.layout), indent=2))

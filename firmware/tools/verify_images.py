"""Verify separate ESP32-C3 images and the protected AI Passport layout."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def verify_partitions(data: bytes) -> dict[str, tuple[int, int, int, int]]:
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
    require(partitions.get("cardid") == (1, 2, 0x356000, 0x4000),
            "Protected cardid partition moved or missing")
    return partitions


def verify(build: Path) -> dict:
    build = build.resolve()
    args = json.loads((build / "flasher_args.json").read_text())
    files = {int(offset, 0): name for offset, name in args["flash_files"].items()}
    require(set(files) == {0, 0x8000, 0x10000},
            "Only separate bootloader, partition and application images are permitted")
    report = {"target": "esp32c3", "images": {}}
    for offset, name in files.items():
        path = (build / name).resolve()
        require(path.is_relative_to(build), "Image path escapes build directory")
        data = path.read_bytes()
        limit = {0: 0x8000, 0x8000: 0x9000, 0x10000: 0x310000}[offset]
        require(data and offset + len(data) <= limit, "Image crosses protected boundary")
        if offset == 0x8000:
            verify_partitions(data)
        else:
            require(len(data) >= 24 and data[0] == 0xE9, "Invalid ESP image header")
            require(data[3] >> 4 == 3, "Image must declare 8 MB Flash")
            require(struct.unpack_from("<H", data, 12)[0] == 5,
                    "Image target must be ESP32-C3")
        report["images"][name] = {
            "offset": hex(offset), "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build", type=Path)
    print(json.dumps(verify(parser.parse_args().build), indent=2))

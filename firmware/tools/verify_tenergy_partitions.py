"""Preservation guard for the installed T-Energy Flash partitions, no wire protocol."""
from __future__ import annotations

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
        require(size > 0 and offset >= 0x9000 and offset + size <= 0x1000000,
                "Partition outside available 16 MB Flash")
        require(all(offset + size <= lo or offset >= hi for lo, hi in regions),
                "Overlapping partitions")
        partitions[label] = (typ, sub, offset, size)
        regions.append((offset, offset + size))
    require(partitions == {
        "nvs": (1, 2, 0x9000, 0x6000),
        "phy_init": (1, 1, 0xF000, 0x1000),
        "factory": (0, 0, 0x10000, 0x300000),
        "cpqueue": (1, 0x40, 0x360000, 0x400000),
    }, "Active S3 partition geometry changed")
    return partitions



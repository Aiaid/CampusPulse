#!/usr/bin/env python3
"""Validate and summarize a CampusPulse raw recording."""
import argparse
import json
import struct
import sys
import zlib
from pathlib import Path

MAGIC = b"CPRAW\r\n\x1a"
HEADER_SIZE = 32
FRAME_MAX = 1728
REPORT_FIXED = 43
PAYLOAD_MAX = 1650


class FormatError(ValueError):
    pass


def later_valid_frame(data, start):
    # A later complete, CRC-valid frame is evidence that the broken length
    # belongs to the middle of the stream, not an interrupted final write.
    for offset in range(start + 1, len(data) - 11):
        size = struct.unpack_from('<I', data, offset)[0]
        if (12 <= size <= FRAME_MAX and offset + size <= len(data)
                and data[offset + 4] in (1, 2, 3, 4) and data[offset + 5:offset + 8] == b'\0\0\0'):
            frame = data[offset:offset + size]
            if zlib.crc32(frame[:-4]) == struct.unpack_from('<I', frame, size - 4)[0]:
                return True
    return False


def decode(data, include_records=False):
    if len(data) < HEADER_SIZE:
        raise FormatError("incomplete file header")
    if data[:8] != MAGIC or struct.unpack_from('<HH', data, 8) != (1, HEADER_SIZE):
        raise FormatError("invalid magic, version, or header size")
    if zlib.crc32(data[:28]) != struct.unpack_from('<I', data, 28)[0]:
        raise FormatError("header CRC mismatch")
    result = {"version": 1, "reports": 0, "stats_frames": 0, "last_stats": None,
              "event_frames": 0, "last_event": None,
              "anchor_frames": 0, "last_anchor": None,
              "valid_bytes": HEADER_SIZE, "truncated_offset": None}
    if include_records:
        result["session"] = data[12:28].hex()
        result["records"] = []
    pos = HEADER_SIZE
    while pos < len(data):
        remaining = len(data) - pos
        if remaining < 4:
            result["truncated_offset"] = pos
            break
        total = struct.unpack_from('<I', data, pos)[0]
        if total < 12 or total > FRAME_MAX:
            raise FormatError(f"invalid frame length at offset {pos}")
        if remaining < total:
            if later_valid_frame(data, pos):
                raise FormatError(f"invalid frame length before a later valid frame at offset {pos}")
            result["truncated_offset"] = pos
            break
        frame = data[pos:pos + total]
        if zlib.crc32(frame[:-4]) != struct.unpack_from('<I', frame, total - 4)[0]:
            raise FormatError(f"frame CRC mismatch at offset {pos}")
        typ = frame[4]
        if frame[5:8] != b'\0\0\0':
            raise FormatError(f"nonzero reserved bytes at offset {pos}")
        body = frame[8:-4]
        if typ == 1:
            if len(body) < REPORT_FIXED:
                raise FormatError(f"short report at offset {pos}")
            seq, mono, length, interval = struct.unpack_from('<QQHH', body)
            if length > PAYLOAD_MAX or len(body) != REPORT_FIXED + length or body[27] > 1:
                raise FormatError(f"invalid report at offset {pos}")
            result["reports"] += 1
            if include_records:
                names = ('addr_type', 'kind', 'event_type', 'props', 'data_status', 'sid',
                         'primary_phy', 'secondary_phy', 'direct_addr_type')
                record = dict(zip(names, body[26:35]))
                record.update(seq=seq, mono_us=mono, length=length, periodic_interval=interval,
                              addr=body[20:26].hex(), direct_addr=body[35:41].hex(),
                              rssi=struct.unpack_from('<b', body, 41)[0],
                              tx_power=struct.unpack_from('<b', body, 42)[0], payload=body[43:].hex())
                result["records"].append(record)
        elif typ == 2:
            if len(body) != 56:
                raise FormatError(f"invalid stats at offset {pos}")
            keys = ('mono_us', 'received', 'enqueued', 'queue_drops', 'invalid', 'written', 'synced')
            result["last_stats"] = dict(zip(keys, struct.unpack('<7Q', body)))
            result["stats_frames"] += 1
        elif typ == 3:
            if len(body) != 16:
                raise FormatError(f"invalid event at offset {pos}")
            mono, event, detail = struct.unpack('<QIi', body)
            event_record = {"mono_us": mono, "event": event, "detail": detail}
            result["event_frames"] += 1
            result["last_event"] = event_record
            if include_records:
                result["records"].append({"type": "event", **event_record})
        elif typ == 4:
            if len(body) != 21:
                raise FormatError(f"invalid clock anchor at offset {pos}")
            mono, utc, uncertainty, source = struct.unpack('<QQIB', body)
            if source not in (1, 2):
                raise FormatError(f"invalid clock source at offset {pos}")
            anchor = {"mono_us": mono, "utc_epoch_seconds": utc,
                      "uncertainty_us": uncertainty, "source": source}
            result["anchor_frames"] += 1
            result["last_anchor"] = anchor
            if include_records:
                result["records"].append({"type": "clock_anchor", **anchor})
        else:
            raise FormatError(f"unknown frame type {typ} at offset {pos}")
        pos += total
        result["valid_bytes"] = pos
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    parser.add_argument('--records', action='store_true', help='include addresses and payloads in output')
    args = parser.parse_args()
    try:
        print(json.dumps(decode(args.file.read_bytes(), args.records), indent=2))
    except (OSError, FormatError) as exc:
        print(f"decode: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

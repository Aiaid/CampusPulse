# Raw recording format, version 1

A file contains a 32-byte header followed by zero or more independent frames.
All multi-byte integers are little-endian; no C struct layout is written to disk.
CRC is IEEE CRC-32 (polynomial 0xEDB88320, initial and final XOR 0xFFFFFFFF),
the same as `zlib.crc32`.

The header contains eight bytes `CPRAW\r\n\x1a`, a uint16 version (1), a
uint16 header size (32), 16 opaque session bytes, then a uint32 CRC of the
preceding 28 bytes. Each frame contains a uint32 total length including framing,
a uint8 type, three zero reserved bytes, a type-specific body, and a uint32 CRC
of all preceding bytes in that frame. Frame maximum is 1728 bytes.

Type 1 is a report: uint64 sequence, uint64 monotonic microseconds, uint16 payload
length, uint16 periodic interval, 6 address bytes, then single bytes for address
type, kind (0 legacy, 1 extended), event type, properties, data status, SID,
primary PHY, secondary PHY, direct address type; six direct address bytes; signed
8-bit RSSI and TX power; and exactly `length` payload bytes (maximum 1650).
Metadata values and byte order of addresses are retained as supplied by the SDK.
Data status is retained so fragments are not silently treated as complete reports.

Type 2 contains seven uint64 values: monotonic microseconds, received, enqueued,
queue drops, invalid, written and synced. Counter semantics are defined by the
producer. `synced` records the report count at the last successful sync before
this stats frame was written; it therefore does not include the sync that follows
this frame. After recovery, count complete CRC-valid report frames across the
session's segments to establish what is readable; CRC validity does not prove
that any particular sync completed or that storage is immune to later failure.

Type 3 is an event with uint64 monotonic microseconds, uint32 event code and
signed int32 detail (two's-complement). Codes are 1 scanning, 2 user stop,
3 space stop, 4 scan error, 5 unexpected scan end, 6 BLE reset and 7 storage
error, and 8 is a requested safe power-off. The producer supplies detail; unknown event codes remain valid and are
reported numerically. The decoder summarizes the count and last event by default;
`--records` includes each event in stream order. A terminal event is evidence only
if it was actually written and survives recovery; a failed device or full card
may prevent recording it.

Type 4 is a time anchor: uint64 monotonic microseconds, uint64 UTC Unix epoch
seconds, uint32 uncertainty in microseconds, then uint8 source (1 RTC, 2 RTC
calibrated by host). The common three reserved frame bytes must be zero and
unknown sources are rejected. Anchors express the producer's mapping and stated
uncertainty, not independent verification that the RTC was correct. No absolute
time is inferred for files without an anchor. Existing report sequence numbers
and monotonic timestamps are unchanged. The decoder summarizes the count and
last anchor; `--records` also includes each anchor in stream order.

A complete frame with a bad CRC or malformed content is an error; the decoder
does not skip damaged frames. A short final frame is reported by its starting
`truncated_offset` and `valid_bytes` identifies the verified prefix. If a later
CRC-valid frame can be identified after a length that exceeds EOF, this is an
error. A damaged length at EOF can be indistinguishable from an interrupted write,
so truncation is a recovery indication, not proof of its cause. A partial header
is an error. Retain the original file when recovering.

`uv run --no-project python firmware/waveshare-raw/tools/decode.py FILE` emits a
summary without session ID, addresses or payloads. `--records` explicitly adds
session ID and report details, including addresses and payloads. Protect that
output as sensitive observation data.

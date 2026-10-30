# Portable v3 frozen-body queue

Local experimental building block for the controlled Waveshare v3 trial. It
does not mount storage, start radio/network/display, choose a policy, issue
sequence numbers or claim an applied configuration. No device operation is part
of these host tests. The existing producer/strict receipt matcher is its protocol
dependency. The initial supported ingestion form is one item per frozen body.

## Declared capacity

| Reserve | Fixed slots | Maximum body bytes |
| --- | ---: | ---: |
| `feature_summaries` | 8 | 32,768 |
| `node_status` | 2 | 8,192 |
| control outbox | 2 | 8,192 |
| total | 12 | 49,152 |

Every body is at most 4,096 bytes; every persisted slot record is at most 6,144.
The 12 logical slot budget is 73,728 bytes. The TF adapter can retain `.tmp`,
`.rec` and `.ack` per slot after interruptions: reserve **221,184 bytes plus FAT
allocation/directory overhead** for all 36 owned filenames. They are not
preallocated; free space and actual allocation must be checked before claiming
capacity. Other card contents remain outside this budget and are never removed.
No borrowing from status/control is allowed; feature exhaustion is explicit
`CP_V3_QUEUE_FULL`. Producers must count affected items/bytes or pause, and must
not claim zero loss. Status coalescing is a producer decision before freezing;
this queue never rewrites an existing frozen status. Do not advertise this as a
shared elastic queue beyond the actual fixed stream maxima.

`sizeof(cp_v3_queue_t)` is 12,752 bytes in the tested host ABI; the TF backend adds
a 6,144-byte comparison buffer plus its configuration. Use caller-owned static
or explicitly allocated RAM, not a small FreeRTOS task stack. No heap allocation
occurs in this component. Queue scratch is shared by operations; one worker must
serialize every call and hold the owning TF lock through each backend operation.
Integration must measure actual target task stack and RAM usage separately.

## Freeze, retry and recovery

Pass the actual `cp_v3_expected_t` generated with the body. Push verifies body
length/SHA-256 and current node/boot scope, then stores a portable little-endian
record with explicit scope, batch ID, generation, policy/body hashes, sequence,
ordinal, body length, exact bytes, CRC32 and a terminal commit marker. Strings are
zero-padded when persisted, so unused caller struct bytes are not copied to TF.
The complete record is hashed again after readback. No raw address or credential
is needed by this queue. Callers remain responsible for strict body/schema
production; the queue does not reparse arbitrary request JSON.

A duplicate pending batch must match the full serialized scope and body, not just
its batch ID. Retry reads revalidate the saved record against its original full
record hash. A changed file is quarantined even when its new content has a valid
internal CRC/SHA. Pending reads supply the original body, SHA and expected ACK
identity; adapters must send those exact bytes and never regenerate under a new
configuration.

Open never formats or repairs storage. Missing slots are free; malformed,
partially written or foreign records occupy quarantined slots. Storage IO errors
fail open rather than treating a slot as empty. Old-node/old-boot bodies remain
quarantined on disk, unchanged, and cannot be transmitted with the current boot
or assigned a replacement ID. Duplicate ordinals/batch IDs are ambiguous and
quarantined. A failed write/reclaim quarantines the slot until a later recovery;
the caller receives IO failure, not a successful enqueue/ACK.

Sequence allocation is deliberately outside this component. Within one boot,
the producer must retain its per-stream monotonic counters across policy changes
and queue reopen. A hardware/software restart must generate a fresh boot UUID;
do not reopen an old boot and reset sequence counters after acknowledged slots
have been reclaimed. Only already committed server receipts allow an old body's
reclamation; this controlled trial conservatively retains retired-boot bodies
because the server does not accept new uncommitted retired-boot evidence.

`cp_v3_queue_ack` accepts only the existing complete strict v3 receipt matcher:
protocol/schema, node, boot, stream, batch, body/policy hashes, policy ID,
assignment generation, sequence/count and committed private-source semantics
must match. A broker PUBACK, HTTP status or incomplete response cannot free a
slot. Control slots are reserved durable storage, but **have no reclamation API
yet**: control routes need their own reviewed strict matching logic. They cannot
be reclaimed using an ingestion receipt. The first trial should send control
operations synchronously with their own strict checks and leave these reserved
slots unused rather than advertise a completed durable control outbox.

## TF/POSIX adapter and synchronization

New board files `raw_v3_queue_store.h/.c` operate only inside a trusted directory,
normally `/sdcard/cpv3queue`, on an already mounted volume. They never mount,
format, erase or enumerate `/sdcard/cpraw`. All names are generated internally.
They preserve unknown files and reject occupied slots, symlinks on host, changed
lengths and oversized records.

Commit creates `qNN.tmp` exclusively, writes/syncs/closes the file, syncs owning
filesystem metadata, renames to `qNN.rec`, then syncs metadata again. Only the
complete record is logically committed; an interrupted temporary is preserved
and quarantined, not promoted speculatively. The caller must exclude every other
writer to this directory; POSIX rename by itself is not a no-overwrite primitive.
After a matched protocol receipt, reclaim first persists/syncs an exact `.ack`
intent, then removes/syncs `.rec`, then removes/syncs `.ack`. A surviving ACK
intent is quarantined conservatively. Filesystem rename/CRC framing provide a
recoverable logical boundary, not a claim that FAT is a transactional filesystem.

On host, the default metadata callback uses directory fsync (including the parent
when first creating the queue directory). ESP requires an explicit callback.
`raw_v3_queue_sd_sync(void *mounted_card)` is available for a caller-owned mounted
`sdmmc_card_t *`; alternatively provide `bool media_sync(void *context)` from the
raw-board owner. It checks the card-to-drive mapping, `sdmmc_get_status` and
`disk_ioctl(drive, CTRL_SYNC, NULL)`. Never call it concurrently with unmount.

ESP-IDF **v5.5.3** FatFs `f_sync`, `f_rename`, `f_unlink` and `f_mkdir` invoke
filesystem synchronization; VFS fsync maps to `f_sync`. The SDMMC driver's
`CTRL_SYNC` handler returns `RES_OK` immediately, so the extra callback is **not a
physical card-cache flush**. Writes use synchronous SDMMC sector operations;
card status/CTRL_SYNC success does not prove survival of sudden power loss.
Retain original raw, report all failure counters and perform target interruption,
card-removal/full-card and power-cut acceptance before making stronger claims.

Owning upstream sources inspected:
[FatFs](https://github.com/espressif/esp-idf/blob/v5.5.3/components/fatfs/src/ff.c),
[VFS adapter](https://github.com/espressif/esp-idf/blob/v5.5.3/components/fatfs/vfs/vfs_fat.c),
[SDMMC diskio](https://github.com/espressif/esp-idf/blob/v5.5.3/components/fatfs/diskio/diskio_sdmmc.c),
[card/drive mapping](https://github.com/espressif/esp-idf/blob/v5.5.3/components/fatfs/diskio/diskio_sdmmc.h).
No upstream implementation was copied into these new files.

## Synthetic acceptance

Run with the required uv toolchain:

```sh
UV_CACHE_DIR=/private/tmp/campuspulse-v3-queue-uv uv run --no-project python firmware/components/cp_v3_queue/tests/test_queue.py
```

ASan/UBSan builds production queue, producer receipt matcher and TF/POSIX adapter.
Cases cover exact-byte retry/restart, changed assignment/hash, full feature queue
with status/control reserves intact, bad/incomplete/mismatched receipts, control
ACK refusal, torn writes, changed files, retired boots, load/reclaim failures,
commit/reclaim metadata-sync failure and preservation of a separate raw original.
The SD helper has stub tests for invalid mapping, absent card, status failure,
CTRL_SYNC failure and success. These are host tests, not device or endpoint
acceptance; the SD helper still needs the target IDF build and actual card test.

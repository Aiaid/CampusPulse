# Portable v3 frozen-body queue

Portable queue for the legacy feature trial and final compact small results. It
does not mount storage, start radio/network/display, choose a policy, issue
sequence numbers or claim an applied configuration. No device operation is part
of these host tests. The existing producer/strict receipt matcher is its protocol
dependency. The initial supported ingestion form is one item per frozen body.

## Declared capacity

Legacy `cp_v3_queue_open` keeps the original CPV3Q001 profile:

| Reserve | Fixed slots | Maximum body bytes |
| --- | ---: | ---: |
| `feature_summaries` | 8 | 32,768 |
| `node_status` | 2 | 8,192 |
| control outbox | 2 | 8,192 |
| total | 12 | 49,152 |

The small-results profile uses CPV3Q002 records and defaults to4 window,
4 candidate-event,2 status and2 control slots, each with a4096-byte body limit.
`config.limits` can set smaller explicit counts/body bounds: T-Energy's proposed
1/0/1/1 layout with1024-byte bodies uses3 slots. At least one window/status/control
slot is required; events may be disabled. The total cannot exceed12. Persisted
profile/layout/body limits must match at reopen; a mismatch occupies quarantine
instead of reinterpreting or erasing a record. `cp_v3_queue_capacity` reports the
configured maximum, not a promise that quarantined slots are available.

Every body is at most4,096 bytes; every persisted slot record is at most6,144.
`cp_v3_queue_encoded_size` preflights actual bytes: legacy overhead500, new
overhead518. A1024-byte small body needs1542 record bytes; the measured678-byte
60s synthetic window needs1196. Providers must reject capacity before commit.
The maximum12-slot logical budget is73,728 bytes. The TF adapter can retain
`.tmp`, `.rec`, `.ack`, `.exp` and `.xtm` artifacts per slot after interruptions:
reserve **223,488 bytes plus FAT allocation/directory overhead** for the maximum
layout (three6144-byte records plus two96-byte minimal markers per slot). They are not
preallocated; free space and actual allocation must be checked before claiming
capacity. Other card contents remain outside this budget and are never removed.
No borrowing from another stream's reserve is allowed; exhaustion is explicit
`CP_V3_QUEUE_FULL`. Producers must count affected items/bytes or pause, and must
not claim zero loss. Status coalescing is a producer decision before freezing;
this queue never rewrites an existing frozen status. Do not advertise this as a
shared elastic queue beyond the actual fixed stream maxima.

`sizeof(cp_v3_queue_t)` is13,104 bytes in the tested host ABI; the TF backend adds
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
fail open rather than treating a slot as empty. Foreign-node/profile and legacy
old-boot bodies remain quarantined unchanged. Small-results may explicitly set
`allow_historical_small`: same-node old-boot window/event/status records remain
readable under their exact original identity and increment `historical_slots`.
Their server authorization still requires the actual historical applied ACK,
lease/time/policy/placement provenance. New pushes cannot borrow a retired boot;
old-boot control bodies stay quarantined. No body receives a replacement ID.
Duplicate active ordinals/batch IDs are ambiguous and
quarantined. A failed write/reclaim quarantines the slot until a later recovery;
the caller receives IO failure, not a successful enqueue/ACK.

Sequence allocation is deliberately outside this component. Within one boot,
the producer must retain its per-stream monotonic counters across policy changes
and queue reopen. A hardware/software restart must generate a fresh boot UUID;
do not reopen an old boot and reset sequence counters after acknowledged slots
have been reclaimed. Ordinals order active local records; they are not a global
or cross-boot sequence promise. Expiry tombstones preserve their peak ordinal on
reopen, while ACKed records can be reclaimed. A separate persistent watermark
would be required for a stronger ordering claim.

`cp_v3_queue_ack` uses the profile's complete strict v3 receipt matcher:
protocol/schema, node, boot, stream, batch, body/policy hashes, policy ID,
assignment generation and sequence/count must match. Legacy requires
`device-ingest-receipt/3`/`private_source`; small results requires
`device-statistics-receipt/3`/`small_statistics`, without the legacy inference
fields. A broker PUBACK, HTTP status or incomplete response cannot free a slot.

Small control records use exact metadata stream `config_ack` or `lease`, never
an ingestion stream. `cp_v3_queue_ack_control` passes the stored expected scope,
exact frozen body and response to a reviewed strict protocol verifier; only a
successful match permits storage reclamation. The callback must be pure and
must not reenter the queue. There is no caller-supplied success flag. Ordinary
ingestion ACK always refuses control; historical generic `control` records have
no matching reclamation path. The board's independent control component owns
actual ACK/lease receipt parsing and authority transitions.

## Source retention

Small-results open requires a trusted UTC interval callback and a distinct expiry
storage callback. Push freezes original `source_expires_at_ms` with exact body
and scope. Read/upload/ACK permission requires UTC **upper bound < expiry**;
deletion requires UTC **lower bound >= expiry**. An uncertainty interval crossing
the deadline pauses access and preserves the source. Unknown/invalid clock is
explicit `CP_V3_QUEUE_CLOCK_UNKNOWN`, never a zero timestamp or a successful ACK.

Call `cp_v3_queue_expire` periodically even offline; push/read/ACK also invoke it.
Expiry first persists a96-byte minimal tombstone (ordinal, body/full-record
hashes, source deadline, byte count and CRC), then removes only the exact source
record. No address, event ID, batch ID or token appears in the tombstone. Expiry
has separate item/byte counters and never masquerades as successful upload.
Same-node valid historical bodies can expire; foreign/profile-mismatched or
malformed bodies are not opportunistically erased. Legacy unknown-expiry records
remain preserved. Unknown/corrupt artifacts require explicit retained-data audit;
the queue does not claim it can prove their original deadlines.

Backend `load` returns0 absent,1 record,2 occupied/unknown,3 verified tombstone
with no body (reusable slot),4 tombstone plus unverified occupied artifacts, or
-1 IO. Tombstones restore peak ordinal and cannot recreate expired bodies.
`cp_v3_queue_record_check` verifies full framing/CRC/body SHA and returns record
identity for safe provider recovery. A new record may coexist with an older
tombstone only when it fully validates and has a larger ordinal. Commit/read
back the new record before clearing that old tombstone; crashes never justify
overwriting an unknown record. An equal ordinal with matching full hash is the
already expired body, so providers finish deletion or preserve quarantine.

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

Small TF integration calls `raw_v3_queue_store_set_hash` before opening to enable
full-record recovery checks. `raw_v3_queue_store_expire` implements the expiry
callback: sync `.xtm`, publish/sync `.exp`, then remove/sync the exact `.rec`.
Verified equal-record expiry intents can finish deletion on reopen; a verified
newer record remains pending until its old tombstone is cleared. Minimal `.exp`
survives source removal and is reused only after a new body commits/readbacks.

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
Small-profile cases additionally cover4/4/2/2 and1/0/1/1 reserves,1024-byte body
preflight, new-schema receipts versus legacy status receipts, uncertain-clock
deadline pauses, tombstone expiry/reuse/failure, historical exact replay without
retired-boot creation, foreign-node quarantine and strict control-verifier gating.
The SD helper has stub tests for invalid mapping, absent card, status failure,
CTRL_SYNC failure and success. These are host tests, not device or endpoint
acceptance; the SD helper still needs the target IDF build and actual card test.

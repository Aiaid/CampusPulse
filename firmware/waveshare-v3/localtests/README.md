# Local CPRAW writer integration and host checks

`../main/local_raw.c/h` is a board-local optional diagnostic writer. It reuses
`waveshare-raw/main/raw_format.c/h` by reference. The root still mounts/unmounts
TF using the existing, officially checked Waveshare ESP32-S3-ePaper-1.54 V2
adapter (SDMMC1-bit GPIO39/41/40). This module has no radio, networking, upload,
inference, TF mount, format, deletion or credential operation.

The root supplies the same TF mutex used by its small durable queue. Prepare
allocates a64-slot PSRAM report pool plus queues and an idle8KiB writer task;
it does not even create a directory. Use `local_raw_memory_bytes()` and
`local_raw_psram_bytes()` in capability/resource preflight, adding heap overhead
and the owner's other allocations. Only start after mounting and a real policy
ACK. The start call checks existing files and opens the first segment under the
shared mutex before enabling intake. Caller lifecycle operations are serialized;
the worker hook and status snapshot may run concurrently.

Before ACK, call `local_raw_probe` while inactive and mounted. It checks policy
limits, managed-file CRC/quota, free-space reserve and room for a maximum report,
then exclusively creates a temporary CPRAW-header probe, flushes/fsyncs/checks
media, closes it and removes only that exact newly created file. Existing files
are never altered/deleted and probe writes do not count as captured reports.
Metadata, writability, quota, missing-mount and invalid-directory failures remain
safely inactive and retryable. A partial write, fsync, close, unlink or media
failure concerning the owned probe latches uncertain I/O; statistics/uplink must
remain independently governed. A probe is current preflight evidence, not a
space reservation or a guarantee that subsequent writes will succeed. Start
revalidates after the real ACK. Connect the daily shared logical-write owner with
`local_raw_set_budget` while stopped before probing; NULL makes no budget claim.

The callback runs under the shared TF mutex before I/O. Directory creation is
charged1024bytes. Opening a segment prepays1024open/sync metadata bytes,
1024close metadata bytes, its32-byte header, optional clock frame and96-byte
footer allowance before exclusive creation. Each report then charges its exact
encoded frame length before fwrite; a periodic flush/fsync charges1024metadata
bytes first. Probe prepays3072metadata bytes plus its32-byte header before
creation, covering its close/removal. Read-only directory/stat/CRC validation is
never charged. No authorization is refunded for failed/cancelled writes, unused
footer allowance, rotation, cross-day cleanup or reboot. Final bounded close and
probe removal consume their earlier prepayment and never ask for fresh budget
or recheck quota, so denial cannot strand approved buffered data. These are
logical lifecycle costs, not a physical-write-day or flash/card-wear proof.

Budget denial stops raw only with `LOCAL_RAW_BUDGET`, `LOCAL_RAW_ERR_BUDGET`
and backend limit-stop counter[5]; it does not become a TF I/O failure. Queued
reports that cannot be written count as drops; only approved complete writes
can become synced. The independent statistics/uplink owner decides its own
actions and shares the same serialized global budget.

The hook copies complete legacy/extended SDK reports without an address table,
duplicate filter, AD parsing, payload sampling or truncation. A bounded queue can
still overflow, which increments drops. Unrepresentable metadata/payload fails
raw closed with an explicit invalid-report/error count, leaving statistics and
uplink decisions to their own owner. Source sequence, monotonic microseconds,
addresses/types, directed addresses, RSSI/TX power, PHYs, SID, event properties,
fragment status, periodic interval and all available payload bytes are retained.
This is an SDK-report record, never a complete over-the-air capture claim.

Files are exclusively created within `/sdcard/cpraw-v3` using actual boot UUID,
session16 and increasing segment suffix. Normal stop/restart never overwrites a
previous segment; the earlier `/sdcard/cpraw` tree is untouched. All existing
regular files in the managed directory count toward the total reservation and
are streamed through CPRAW header/frame/CRC validation before a new start.
Non-regular, unknown/corrupt, partial-tail or more than4096 entries stop raw
recording without deletion. This conservative behavior requires an explicit
owner/operator decision for damaged historical files; it is not automatic
power-loss recovery. Validation holds the TF mutex and can take time for a large
managed directory, so do it at a configuration boundary.

Segments are at least2048bytes and never exceed the configured whole-file
limit. Admission reserves complete footer frames and a64KiB FAT allocation
margin in addition to the configured free-space reserve. Segment rotation
flushes/fsyncs/closes; periodic sync occurs at the100–60000ms configured interval.
Disk-space, raw-total-quota or storage errors disable raw intake only. Remaining
enqueued reports discarded after a quota/error stop count as queue losses.
No raw bytes are sent to the server by this module.

Snapshot `counters[6]` is the boot-monotonic backend tuple:
`[enqueued,written,synced,drops,storage_or_encoding_errors,space_or_quota_stops]`.
Counters never reset on configuration restart; `synced<=written<=enqueued` is
maintained. Written means a complete report was accepted by fwrite; synced
advances only after flush/fsync and the optional media-status barrier succeed.
Footer statistics conservatively contain the previously confirmed synced count.
Snapshot also reports free slots, memory use, reason, invalid-report count and
managed bytes, without addresses, session/boot IDs or filenames.

After stop, `local_raw_verify_closed` independently takes the lifecycle and TF
mutexes and scans only the already existing managed directory. It never calls
the create/probe/budget paths, so even a missing-directory race cannot cause
mkdir or a write. Active intake, writer, in-flight hooks or an open output file
are rejected. Header/frame CRC, exact structure, file length and complete EOF
are checked; corrupted or short reads fail with a zero summary. Success returns
only aggregate files/reports/bytes/anchors across all managed boots. It performs
no charge, status reset, TTL action, repair or deletion; the caller must not
already hold the TF mutex. Successful CRC inspection does not clear an earlier
I/O latch or establish card power-loss safety/radio completeness.

`local_raw_stop` disables intake, waits for in-flight copies, drains queued
reports and closes the current file. A timeout keeps writer ownership and is
never safe to unmount. Partial write/flush/fsync/close/media failures latch
`io_failed_latched` and `safe_to_unmount=false` for the handle's boot lifetime;
there is no automatic restart after such a failure. Other raw failures remain
visible in `last_error` even when the file closes cleanly. The owner must inspect
both the returned error and explicit safety status. An optional media callback
can share the queue's `raw_v3_queue_sd_sync` card-status check. IDF5.5.3 SDMMC
CTRL_SYNC does not flush an undocumented card cache, so successful synchronization
does not prove arbitrary power-loss safety or card endurance.

The pure clock callback is shared with capture and receives monotonic
milliseconds. An anchor is emitted only when the root explicitly marks the
actual RTC verified, the callback says UTC known and the returned mapping is
valid. Source2 must follow actual `raw_clock_set` plus successful RTC readback;
host/network time alone is insufficient. No anchor appears when unknown.
CPRAW stores integer UTC seconds, so1000ms quantization is added to the supplied
uncertainty before encoding. Clock/source changes require a stopped writer.

Run without any hardware:

```sh
uv run firmware/waveshare-v3/localtests/test_local_raw.py
```

The pthread FreeRTOS fixture exercises the production writer and unchanged CPRAW
decoder under ASan/UBSan: full1650-byte extended payload/metadata copy, caller
buffer mutation, rotation/exclusive restart, verified/unknown clock behavior,
backpressure, stop timeout while the external TF mutex is blocked, existing
quota/corrupt-file preservation, free-space reserve, invalid metadata, short
write, fsync, close and media/free-space I/O failures. Fault tests inspect the
permanent failure latch before resetting test-owned state solely to join/free
the host fixture. No fixture resets the latch in production.

An actual ESP-IDF5.5.3 ESP32-S3 compile/link check is distinct from physical TF,
button, endurance, removal/full-card and concurrent upload acceptance.

## Daily budget NVS provider checks

`cp_v3_budget/budget_nvs.c` binds the pure budget core to a dedicated caller
namespace (`cpv3budg`). The caller initializes NVS without erasing and uses one
outer mutex for all budget/TF/NVS writers. The provider validates both96-byte
records with the core decoder, rejects any nonempty invalid/foreign/rollback
pair, selects the highest adjacent valid sequence and alternates slots. Equal
sequences are accepted only for identical bytes. A commit must pass exact
readback through a fresh handle before success. Commit failure may already have
persisted; the core latches and burns any reloaded reservation rather than
recovering unused credit. No namespace/key erase or automatic reset occurs.

Each store declares4096logical metadata bytes to the core. Before changing NVS,
the provider checks `available_entries` with a128-entry spare floor plus blob/
namespace overhead, matching the small flash queue's spare discipline. This
does not prove physical write amplification or endurance. Unknown/insufficient
spare statistics refuse writes, never erase unrelated settings/queue keys.

```sh
uv run firmware/waveshare-v3/localtests/test_budget_nvs.py
```

The real pure core/provider run together under ASan/UBSan with fault-injected
NVS: absent versus corrupt slots, owner/sequence/day/reservation integrity,
commit-before/after-error, failed readback, torn CRC, lack of spare space and
reboot credit burn. Local-raw budget tests additionally cover unpaid probe/open
denial, unchanged existing files/read-only validation, mid-writer and periodic
sync denial, queued losses and prepaid cleanup with no new credit.

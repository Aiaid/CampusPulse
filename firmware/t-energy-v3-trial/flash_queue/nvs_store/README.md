# Bounded NVS frozen-record adapter (experimental)

This adapter is a `cp_v3_queue_store_t` backend for the default NVS partition,
namespace `cpv3stats1`, slot keys `q00`–`q11`. It does not touch `cpqueue`,
initialize or erase NVS, create a partition, scan other namespaces, or modify
firmware configuration. `prepare` only sets up callbacks. The caller must
initialize the existing NVS normally without erase-on-error and serialize *all*
queue operations and other NVS writers against the capacity check and mutation.
Namespace separation prevents key collision; it is not a physical partition or
space reservation. NVS may move and erase physical pages during garbage
collection while preserving unrelated live logical keys. Do not use this if the
requirement forbids such NVS-managed page operations.

At most three occupied keys globally, including damaged/unknown slot keys, are admitted;
each encoded queue record is at most 2048 bytes. The legacy profile has a 488-byte header and 12-byte trailer (1548 body bytes
maximum); the small-results profile adds 18 bytes (1530 body bytes maximum).
The generic queue allows up to 4096 body bytes. A host integration test encodes,
persists, reopens and compares a 1024-byte legacy body in a 1524-byte record,
and checks that a small-results 1024-byte body is encoded into 1542 bytes. That test uses a deterministic test hash and synthetic receipts; it does not
test cryptography or server acceptance. Some legal generic queue bodies therefore
exceed this adapter limit and are rejected. No truncation, delete-oldest, formatting or coalescing occurs. Before
new stores, require the partition to have at least 128 available NVS entries plus
an estimated record allocation and overhead. This is a conservative guard, not a
reservation, a complete upper bound for GC, or proof that another namespace is
safe from resource starvation. Actual free space, settings/credential footprint,
write amplification and NVS behavior on a real device remain unmeasured. A
caller must not advertise the portable queue's twelve fixed slots or its 4096-byte
body limit as this adapter's capacity: there are at most three occupied records,
each including its envelope within 2048 bytes. Fixed per-stream reserves also
need reconciliation with this shared three-record limit. Test actual serialized
records before accepting a policy; report exhaustion and oversize explicitly.
An encoded record exceeding the limit must never be silently truncated. A
record in the small-results `cp_v3_queue` encoding has 518 bytes of overhead,
leaving at most **1530 bytes for its body** in this adapter. Future
statistics encodings may differ; measure their complete frozen envelope rather
than treating the approximate 1 KiB/minute goal as an assured capacity.
A missing slot in the queue namespace is considered free; malformed, wrong-type or
oversized values are occupied. All I/O failures fail closed. Store requires empty
slot, writes once, commits and verifies byte-identical readback. After uncertain
store or erase, RAM marks that slot occupied until reopen/reconciliation.

Reclaim verifies byte-identical frozen record, erases only that key, commits and
verifies absence. **The adapter does not itself parse or validate receipts.** Its
reclaim callback may only be invoked by `cp_v3_queue_ack` after the complete
application receipt matches, or a separately reviewed equivalent with the same
full identity and hash checks; a broker ACK or HTTP 200 is insufficient. A crash
while writing may leave the new record absent, complete, or ambiguous according
to NVS recovery. A crash after authorized reclaim may leave the record present
or absent. Preserve and retry exact bytes when present, never reconstruct with a
new ID. Host stubs model API failure timing, not actual NVS crash consistency.

Records are byte-for-byte opaque here and can retain original boot, sequence,
batch, hashes, applied policy and body across restarts if the encoded envelope
fits. **The current `cp_v3_queue_open` quarantines old-boot records.** Until the
separately reviewed historical-lease recovery and receipt rules are implemented
in the queue and backend, this adapter does not enable old-boot delivery. It
must not modify old evidence to bypass that restriction. The user-specified
future contract permits late delivery only under the historically applied
configuration and explicit lease/accept-until, validating original observation
time plus uncertainty; untrusted time and newly observed data using an old
lease must be rejected. No claim is made that the existing service already
implements these rules.

The generic queue defines 12 logical slots with kind-specific reserves, but
this adapter shares only three live records across all kinds. It
cannot promise 12 usable records, independent per-kind reservations, or a
4096-byte body. Capability declarations and admission must reflect the lower
actual limits before integration; queue-level slot reservations do not override
the backend cap. Capacity exhaustion returns storage failure, not the generic
queue FULL status; the caller must surface this distinction.

The repository T-Energy partition table gives NVS `0x6000` (24 KiB), shared by
settings, provisioning, diagnostics and other NVS users. Namespace alone does not
give 6 KiB of free capacity. ESP-IDF 5.5.3 local source inspected:
`components/nvs_flash/include/nvs.h` documents blob overhead and commit;
`src/nvs_api.cpp` shows this version's `nvs_commit` wrapper (commented as a
no-op today) and `nvs_set_blob` dispatch; `src/nvs_storage.cpp` contains blob
page/chunk handling. The API contract still requires commit. The official
[ESP-IDF NVS guide](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32s3/api-reference/storage/nvs_flash.html)
describes page recovery on power failure and says the key being written may be
lost; it also documents errors and limited free space. This does not prove
brownout behavior, storage endurance, data protection against malicious edits,
or actual board-level durability. Do not apply the guide's erase-on-recovery
suggestion to the user's existing NVS.

Host-only tests:

```sh
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I firmware/components/cp_v3_queue/include -I firmware/components/cp_v3_evidence/include \
  -I firmware/t-energy-v3-trial/flash_queue/nvs_store/tests \
  -I firmware/t-energy-v3-trial/flash_queue/nvs_store \
  firmware/t-energy-v3-trial/flash_queue/nvs_store/nvs_store.c \
  firmware/t-energy-v3-trial/flash_queue/nvs_store/tests/test.c firmware/components/cp_v3_queue/queue.c \
  firmware/components/cp_v3_evidence/wire.c firmware/components/cp_v3_evidence/evidence.c -o /tmp/cp-te-nvs-store-test
/tmp/cp-te-nvs-store-test
```

The three-record cap is only a software limit, not reserved capacity. A host
fixture using the in-development small-results profile stores one synthetic
window, status and control record and confirms that a fourth candidate record is
rejected. The host test uses real queue and receipt parsing with synthetic receipts;
NVS, clock, expiry and the digest callback are simulated. It is not server,
cryptographic, apply or hardware acceptance. Integration must measure live NVS usage and
budget namespace metadata, possible expiry tombstones, future control state,
settings, write amplification and garbage collection before promising apply or
retention. Expiry and reuse are experimental; see the transaction and validation limits below.

## Expiry and slot reuse

Bind a trusted SHA-256 implementation with `te_nvs_store_set_hash` after each
`prepare` and before queue open. Missing hash leaves tombstone slots quarantined.
`te_nvs_store_expire` validates the entire frozen record and its supplied
tombstone identity, then writes, commits and reads back the 96-byte tNN
tombstone before deleting qNN. A tombstone with no qNN returns load=3. With
both present, `cp_v3_queue_record_check` checks CRC, body digest and full-record
digest; only a fully valid qNN with strictly larger ordinal is exposed. Equal,
older, malformed or unverifiable qNN remains load=4, with the tombstone intact.

To reuse a tombstone slot, validate a strictly newer full record before writing,
write and commit qNN while retaining tNN, read back and validate exact bytes,
then delete and commit tNN. Any uncertain failure quarantines during the active
instance. After reopen, a valid newer qNN can be recovered even if tNN remains;
receipt-based reclaim deletes tNN before qNN, preserving the ordering. No body
is removed on a generic HTTP or broker ACK. Three-slot accounting counts an
occupied record or tombstone as one logical slot, and available NVS entries
still constrain the physical temporary coexistence of both keys.

Simulated failure injection covers the NVS API call boundaries and reopen,
including equal-ordinal old bodies, corrupt newer records, and ordinal recovery.
The test runner uses a deterministic test digest; an additional host run used
OpenSSL SHA-256 with the real record-check helper. These tests do not establish
real NVS garbage-collection atomicity, brownout durability or adequate space.
Expiry counters in the shared queue are RAM-only. Physical storage wear,
trustworthy time, exact receipt verification and capacity admission remain
independent requirements.

The host test also configures 1 window / 0 event / 1 status / 1 control and a
1024-byte body cap. It verifies exact readback after reopening, rejects a fourth
entry, exercises unknown and expiry-straddling clock bounds, and confirms that
a different boot quarantines all old records. Synthetic exact statistics
receipts using the real parser release window and status records; malformed
receipts do not. The ordinary ingestion ACK rejects control records and preserves them. The shared
queue now exposes a separate control-ACK callback interface, but this fixture
does not exercise an actual strict control verifier; the control reclaim path
still needs integration validation. Small-results control records require the
`config_ack` or `lease` stream; generic `control` is rejected. This test cannot
claim all three kinds can be reclaimed.

When a prior reuse committed a newer valid qNN but left an older tNN, expiry
re-reads both, verifies the complete qNN and its strictly larger ordinal, then
commits deletion of the older tNN while qNN remains. It subsequently writes and
verifies the new tNN before deleting qNN. An error at any point stops the
operation. Host tests inject a failure at each simulated NVS operation and verify
that the qNN remains unless the new tombstone already exists; re-opened peak
ordinal never falls below the newer qNN ordinal. This is not a physical power-cut
or NVS garbage-collection test.

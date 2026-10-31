# NVS identity ledger: recovery design and limits

Status: design only. There is no NVS provider, external anchor, integration, or
physical-device acceptance. This does not authorize changes to partitions,
`cpqueue`, existing NVS keys, or the board gate.

## Why two slots alone are insufficient

The core's canonical 5,288-byte record contains a generation at offset 16,
equal to boot count plus reservation count. Its successful commit path reads
back and compares the entire record under the supplied lock. On restart, however,
the only durable history exposed to the core is what the backend returns. For
example, slots containing valid generations 6 and 7 are indistinguishable from
an earlier snapshot restored after generation 8 was acknowledged. Checksums,
slot alternation, and checking adjacent generations cannot detect that replay.
Likewise, no visible namespace or key cannot distinguish a virgin medium from
an erased or inaccessible one. A corrupt page can make items inaccessible; a
key being written at power loss can be lost. See the [ESP-IDF 5.5.3 NVS
robustness and internals documentation](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32s3/api-reference/storage/nvs_flash.html#security-tampering-and-robustness).
Do not interpret missing, unknown, malformed, conflicting, or unreadable state
as an empty ledger without independent virgin-state evidence.

## Candidate external anchor protocol

One feasible direction is an authenticated, linearizable service with durable,
monotonic per-device state: explicit provisioned-virgin, committed generation
and full-record hash, and at most one pending successor generation and hash.
The service must authenticate the device and enforce a single writer, fresh
requests and responses, successor-only transitions, idempotency, and durable
acknowledgements. Replays or restoration of the service's own state are outside
this model; protecting its history is a separate requirement. The device must
have a securely provisioned service identity and trust anchor, a reliable way to
identify this ledger, and a fresh authenticated response; offline or ambiguous
service status fails closed. A hardware-backed monotonic anchor may substitute
only if it supplies equivalent durable binding to the ledger hash and a proven
atomic recovery protocol. A counter alone does not bind the record contents.

1. A read-only open queries the service and audits *both* dedicated namespace
   slots, including types, lengths, checksums, generations, and unknown keys.
   Virgin is accepted only when the service explicitly says provisioned-virgin
   and the medium audit meets an independently specified virgin-media policy.
   Unknown or contradictory evidence fails closed, without initializing or
   erasing NVS. Provisioning and replacement require a separate explicit policy.
2. Under the common writer lock and after the real budget charge and capacity
   recheck, prepare the exact next generation and cryptographic full-record hash
   at the service. Do not publish the candidate identity. If prepare is uncertain,
   query the service; do not guess or retry as a different transaction.
3. Write the successor to the inactive slot without deleting the previous slot,
   commit, then read back and validate every byte. Account for every local write,
   including bootstrap and metadata, under the same budget and lock. A failure
   or ambiguous response latches the operation closed.
4. Finalize that same generation and hash at the service. Only after a fresh
   authenticated confirmation and the core's own exact readback may the identity
   be exposed. If finalization is uncertain, query the service and remain closed
   until its state is resolved. The existing synchronous core/backend interface,
   failure semantics, and lock duration must be reviewed and possibly changed
   before implementing this protocol; the core alone does not provide it.
5. On restart, committed service state accepts only a fully validated exact match
   to its generation and hash. A pending successor must be resolved against the
   service: a matching valid successor can be finalized according to an explicit
   idempotent recovery rule; if it is missing or unreadable, stop rather than
   silently reverting to the previous record. If service state is committed but
   its matching local record is missing, stop or recover exact authenticated bytes
   from an independently specified backup. Never reuse an unconfirmed identity.

This proposal prioritizes safety over availability. It requires a defined failure
model for NVS writes, service durability and network freshness; it does not prove
recovery from complete erasure, arbitrary replay, compromised credentials,
malicious rewrite, or simultaneous loss of all trusted copies. Cryptographic
hashes detect accidental changes and bind service state; they do not by themselves
authenticate the NVS data or establish trusted time.

## Space and write accounting

For an unwrapped 5,288-byte blob, the ESP-IDF documented accounting is two
entries of overhead plus one per 32 data bytes: 168 entries per slot, or 336
for two slots, plus a namespace entry. An envelope, metadata keys, blob chunking,
and implementation-specific fragmentation can change the actual requirement.
Consult [`nvs_set_blob` and `nvs_get_stats`](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32s3/api-reference/storage/nvs_flash.html#_CPPv412nvs_set_blob12nvs_handle_tPKcPKv6size_t).
`available_entries` excludes reserved entries and is an admission signal, not a
guarantee that a write or GC will succeed. Two initial blobs already require
approximately 337 entries before any other keys or transient headroom.

The current core requires 302 currently available entries and charges 16,384
logical bytes per mutation. Neither figure establishes the first dual-slot
bootstrap cost, metadata cost, concurrent budget checkpoint cost, GC write
amplification, erase cycles, or actual capacity beside existing queue data. A
provider needs measured/verified IDF-version-specific admission and explicit
accounting for all writes, including pending metadata and both bootstrap slots;
if a safe bound is unavailable, deny the write. Never reclaim old slots or touch
other namespaces to make space. Unknown statistics and all NVS errors fail closed;
a failed or uncertain mutation is not refunded. Physical write and erase counts
must not be equated with the logical budget.

## Verification boundary

Host fault injection can exercise every modeled NVS and service I/O cut before
and after each operation, restart with durable state, use the real identity and
budget cores and SHA-256, and check that no acknowledged identity is reused.
It can enumerate malformed/foreign keys, mismatched hashes, same-generation
conflicts, missing slots, insufficient or unknown capacity, service replay and
uncertain prepare/finalize. Such tests prove properties only of the modeled
semantics. They do not prove the actual flash driver's power-loss behavior,
real partition capacity or GC amplification, service linearizability, lock
sharing by all writers, physical entropy, trusted time, or board operation.
Actual S3 build, storage measurements, integration review, and controlled physical
power-cut testing are separate prerequisites, not implied by a host pass.

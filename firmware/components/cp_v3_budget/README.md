# Cross-boot daily logical-write budget

This component authorizes bounded **logical write transactions** before the
caller performs them. One persisted allowance is shared by every policy, boot
and writer for the same stable node scope and UTC day. It does not measure flash
programming, erase cycles, NVS garbage collection, FAT allocation or physical
device wear, and it is not a power-loss acceptance result.

## Integration

Initialize NVS without erasing it, select one dedicated stable namespace, and
bind its provider. Hash the stable node scope to the 32-byte owner key; this is
an identity binding, not a credential. Both TF raw recording and upload-queue
writes must use the **same budget instance/provider**, serialized by the same
single owner or outer storage mutex.

```c
cp_v3_budget_store_t store;
cp_v3_budget_nvs_t provider;
cp_v3_budget_t budget;
/* Check each result before continuing. */
cp_v3_budget_nvs_open(&provider, "cpv3budg", &store);
cp_v3_budget_open(&budget, store, stable_node_sha256);
cp_v3_budget_configure(&budget, policy_daily_limit, 65536);

/* Trusted UTC interval for the authorization instant; no unknown-time fallback. */
if (cp_v3_budget_charge(&budget, conservative_logical_bytes,
                        utc_lower_ms, utc_upper_ms) == CP_V3_BUDGET_OK) {
    /* Perform exactly the admitted logical transaction. Never refund failures. */
}
```

The core and codec are portable C with no heap allocation, ESP calls or network.
The optional `budget_nvs.c` provider is owned separately and depends on ESP-IDF
NVS. Its caller provides the namespace; it reads/validates first, alternates two
96-byte records, commits and rereads through a fresh handle. Both nonempty slots
must decode and have compatible owner/day/reservation/sequence history. Invalid
or ambiguous data and read errors fail closed. It never initializes, formats,
migrates, erases NVS or modifies unrelated keys. NVS SDK durability and real
power-cut behavior remain separate hardware validation concerns.

## Reservation, charging and reboot behavior

`open` only loads. It grants **zero RAM credit**, including after a successful
previous boot. A valid old record's entire reserved total remains accounted:
past actual charges and any unused pre-reservation cannot be distinguished after
reboot, so both are conservatively consumed. Rebooting repeatedly cannot reclaim
that credit. Never open a new namespace, erase old state, or reset the record
when a policy changes or a limit is reached.

`configure(limit, quantum)` does not write storage or release reservations.
Typical quanta are 65536 or 262144 logical bytes. Charges inside current RAM
credit require no persistent write. When more credit is needed, the component
first persists an additional quantum (or enough whole quanta for a large charge)
**plus the provider's declared logical write cost**, then verifies exact readback.
Only afterward does it approve the caller's charge. If the final available
budget is smaller than a quantum, it reserves that smaller remainder, provided
it can cover both the pending charge and the provider cost.

For example, with a 65536-byte quantum and the NVS provider's 4096-byte logical
metadata allowance, the first one-byte charge persists 69632 reserved bytes and
leaves 65535 usable RAM credits. If the device reboots, those unused 65535 bytes
are burned. A subsequent charge must reserve new credit after the existing
69632 bytes. This can exhaust a day early after repeated reboots; it cannot
create a fresh per-boot allowance.

The caller charges before I/O and includes its conservative serialization,
temporary-file, journal and filesystem-overhead estimate. A failed/cancelled
caller transaction remains charged; there is no refund API. Provider
`logical_write_bytes` is automatically included in each new reservation and must
be at least the 96-byte serialized record. The NVS provider declares 4096 bytes
as conservative **logical metadata accounting**, not a measurement or proven
upper bound on physical flash/GC amplification.

A new lower policy limit below the already persisted reserved total stops all
new approvals, even if current RAM still contains unused credit. Raising the
limit later may permit previously reserved credit or new reservations; lowering
the limit never subtracts from the persisted total. Limits and reservation
quanta are explicit caller inputs; authenticated policy validation is outside
this component.

## Time, failures and recovery

Each charge requires a trusted UTC lower/upper interval, ordered and entirely
inside one UTC calendar day. Bounds before 2024, from 2200 onward, unknown `0/0`
or a midnight-straddling interval are rejected. UTC movement within a day never
resets usage. A day older than the persisted or already observed day is rejected.
Only a fully known later day can start a new allowance; unused prior-day RAM
credit is discarded and the first new reservation persists the later day while
incrementing the same record sequence.

`store(false)` may have committed. A successful store followed by missing,
changed or unreadable readback is also uncertain. Both cases latch the component
against all approvals and configuration changes. The snapshot exposes the last
confirmed reservation and the candidate uncertain reservation separately.
Only an explicit reopen/load can resolve the state; the new load burns any
recoverable reserved credit. Missing storage is accepted only when the provider
positively reports absence, never when an error is translated to an empty store.

No caller I/O is approved after a failed budget-store attempt. If that attempt
did not commit a valid record, its incomplete physical writes cannot be measured
or reconstructed by this ledger after reboot. Attempt counters are observable
in RAM, but this component does **not** promise an exact persistent count of
failed physical storage operations or protection against manual storage erase,
external rollback or malicious provider code. Such claims require a different
storage/measurement or trusted-hardware contract.

## Prepaid deferred cleanup

A queue owner may define one admitted logical lifecycle transaction to include
record creation and bounded future ACK/TTL deletion. It must charge a documented
conservative lifecycle cost **before making that record visible**, and enforce
that every accepted record in that dedicated namespace/version followed this
path. Later idempotent deletion consumes that already-paid obligation even
after midnight or reboot; it does not recover general RAM credit. New records,
replacement bodies, arbitrary rewrite work or legacy/imported/unknown files
cannot inherit free authorization from this rule.

This is an **authorization-day logical lifecycle budget**. It does not bound
physical bytes written on the cleanup day's calendar date. The core itself
does not issue or persist per-record prepaid tickets; the queue's owned-format
and creation invariant must establish the obligation. If that invariant cannot
be established, a reviewed ticket/migration design is required. Keeping cleanup
within a validated prepaid lifecycle allows private-source expiration without
making it depend on obtaining fresh ordinary-write budget after expiry.

## Record and snapshot

The fixed 96-byte record is encoded explicitly in little endian; no C struct
padding is persisted:

| Offset | Bytes | Content |
| --- | ---: | --- |
| 0 | 8 | `CPV3BD01` magic |
| 8 | 2 | Version 1 |
| 10 | 2 | Record size 96 |
| 12 | 4 | Reserved, zero |
| 16 | 8 | Global positive record sequence, at most 2^53−1 |
| 24 | 4 | UTC day index |
| 28 | 4 | Reserved, zero |
| 32 | 8 | Persisted reserved bytes, at most 2^40 |
| 40 | 32 | Stable node-scope SHA-256 |
| 72 | 16 | Reserved, zero |
| 88 | 4 | CRC32 over bytes 0–87 |
| 92 | 4 | `BUD!` commit marker |

CRC framing detects accidental corruption; it is not authentication or proof of
physical durability. Unknown versions, flags/padding, bad sizes/checksums,
invalid bounds, a zero owner key and scope mismatch are rejected. Sequence never
resets at day rollover and exhaustion fails closed.

`snapshot` distinguishes approved logical I/O since open, confirmed provider
logical cost, newly reserved bytes, reserved carry-in from earlier boots,
discarded current-boot credit, persistence attempts/successes and rejections.
These are accounting values, not measured physical writes. The reserved total
is the persistent daily ceiling; since-open counters deliberately are not
presented as a complete history of earlier boots.

## Synthetic verification

```sh
UV_CACHE_DIR=/private/tmp/campuspulse-v3-budget-uv uv run --no-project python firmware/components/cp_v3_budget/tests/test_budget.py
```

ASan/UBSan tests exercise exact serialization and every-byte corruption,
preauthorization, batched packet charging, credit burn across repeated reboots,
partial final quanta, lower/raised limits, UTC uncertainty/day transitions,
regression, unknown time, commits that fail before or after persisting,
corrupt readback, owner mismatch, sequence exhaustion and no-rewrite error paths.
A deterministic 1000-step adversarial replay checks that approved logical I/O
plus committed provider costs never exceed the persisted daily reservation
under repeated reboots and uncertain commits. The portable core also passes the
actual ESP32-S3 GCC 14.2 `-Wall -Wextra -Werror` syntax check. No device or network
operation is part of these tests.

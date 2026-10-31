# Existing T-Energy `cpqueue`: reuse audit and blockers

The new direction is small on-device window statistics, with raw upload disabled
by default. Do not use `flash_queue.c`'s `v3queue` partition on this board: it
requires a new partition and is only an isolated experimental adapter. Do not
flash its old trial partition table. This audit made no device connection and
makes no claim about what currently occupies the physical Flash.

The existing T-Energy table describes `cpqueue` at `0x360000`, length `0x400000`,
data subtype `0x40`. `cp_pipeline_init` checks this exact address and size.
`cp_journal` divides the partition into 12,288-byte slots: floor(4 MiB / 12 KiB)
= 341 slots with 4 KiB outside its slot range. It calls a fully erased slot FREE,
verifies valid CPQ2 records, and quarantines unknown or partial bytes. Normal
append selects FREE first and then erases ACKED slots; it also reserves eight
slots from non-control writes. Therefore direct use of normal append can erase
pre-existing acknowledged records and fails the current requirement to leave old
records untouched. The earlier `v3queue` adapter's 8192-byte boundaries do not
match the journal's 12288-byte boundaries, so remapping it onto `cpqueue` is
unsafe, even when inspecting a single apparently erased 8192-byte region.

A possible future compatibility design uses existing 12 KiB boundaries and a
strictly versioned, identifiable record wrapper within CPQ2. It must inspect the
*whole* candidate 12 KiB slot, use only an all-erased slot, never erase any
pre-existing slot (including ACKED), and hold exclusive ownership against all
other journal users. Only a slot newly written by this version and subsequently
matched to an exact durable application receipt may later be eligible for erase;
that ownership and receipt state must survive power loss and be unmistakable on
recovery. Unknown, torn, or ambiguous bytes remain quarantined. Retain the exact
frozen body and full identity for retry. Before any implementation, review how
rollback to older firmware and concurrent/legacy journal use would treat the new
wrapper; do not assume an unused byte range or the final 4 KiB is available.
There is no authorization here to alter the existing partition table or erase it.

This is not a complete cross-boot recovery design yet. `cp_v3_queue_open`
quarantines bodies belonging to a previous boot; the v3 ingestion service rejects
new batches for a retired boot (`v3_current_boot_required`). An already committed
retired-boot batch may obtain its existing receipt under the documented replay
rules, but an uncommitted one cannot currently be delivered merely by restoring
Flash bytes. Rewriting its identity, boot UUID or sequence would break its frozen
identity. A complete solution needs a reviewed server/device recovery contract
for historical boots, idempotent exact-body retry, and tests for response loss,
registration races, expiry, receipt validation and repeated power interruption.
Until then retain old bodies and report capacity exhaustion explicitly; do not
advertise reboot-safe delivery.

Write budget depends on the observed number of genuinely available slots, record
rate, failures, flash endurance and allocation policy, none measured here. As an
illustration only, at one record per minute with eight reusable slots evenly
rotated, each slot would be erased about 180 times/day. At 341 reusable slots,
about 4.2 times/day/slot. These are arithmetic examples, not lifetime estimates:
legacy records reduce capacity and no wear distribution or chip endurance has
been verified. A production design needs explicit rate/batch/retention limits,
measured write amplification, end-of-life margin, counters for dropped/coalesced
results, and fault-injection plus physical brownout testing. Do not silently
coalesce frozen records after assigning their identity.

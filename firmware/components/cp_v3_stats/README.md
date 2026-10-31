# Portable small-window statistics core

This component implements the aggregate-only default. It has no board, TF,
network, policy, journal, JSON or wire dependency. It never uploads a report or
identifier list. SDK callbacks must only copy into the caller's preallocated
queue; its worker invokes this core with the full borrowed SDK report.

Initial versions are `cp-v3-stats/1` / `unclassified-v1`. Every retained
address/type key belongs to `unknown`, and the other five category counts remain
zero. Non-NULL classifier callbacks, `rules_verified=true`, and other rule labels
are rejected at initialization. The public callback types are reserved extension
interfaces, not an activation bypass. Company ID, OUI, Phone Appearance, names,
or conflicting hints alone never produce phone/vehicle/other classifications.
`estimated_total_available` always stays false. Future verified rules need a
separate reviewed implementation and backend/policy allowlist.

## Allocation and cost

`capacity` is uint16,1–512. A power-of-two open-address hash table has at least
twice that capacity; each slot is a2-byte entry index. One16-byte entry retains
the private address/type key and a12-bit bin-presence mask. There is no eviction
or report deduplication: repeated reports count, while each retained key contributes
at most once per bin. A full table counts unretained reports explicitly.

Call `cp_v3_stats_memory_bytes`, `cp_v3_stats_memory_alignment` and
`cp_v3_stats_hash_slots` on the actual target. `init` uses caller memory;
`alloc`/`free` use explicit allocator callbacks suitable for PSRAM. Observation
and snapshots allocate nothing. Freeing/beginning clears private window keys.

Actual S3 GCC14.2 layout measured here:

| Capacity | Hash slots | Core plus entries/hash |
| --- | --- | --- |
|16|32|1584bytes|
|256|512|6384bytes|
|512|1024|11504bytes|

The core header is1264bytes on S3; a separate snapshot is1176bytes. Host ABI
header size is1304bytes, yielding11544bytes at512. These budgets exclude ingress
queues, external temporal history, upload queue, serialization, TLS and task stacks.
The core supports at most12bins:60000/5000 and30000/5000 both fit. Backend ceilings
do not grant support for a60-bin policy in this implementation.

## Window and source semantics

`begin` opens a half-open monotonic interval and clears only this core's prior
window. `observe` aggregates report count and valid RSSI for every accepted SDK
metadata report, including malformed/fragment reports and address overflow.
Legacy SCAN_RSP is event type4; extended SCAN_RSP is property bit3. SDK RSSI127
and values outside[-127,20] are unknown, not zero samples. Complete legacy data
is bounded to31bytes and extended data to1650. AD lengths, padding, company,
Appearance, UUID-list and service-data widths validate before any evidence hook
could run. No malformed prefix is classified and no fragments are reassembled.

Ordered `scan_state` transitions measure coverage independently of reports.
Before the first known transition coverage is unknown. A regressing transition
invalidates coverage for this window; snapshots conservatively report it unknown
rather than claim continuous scanning. Empty report bins do not prove absence.
Report sequence/time gaps are diagnostics, not measured over-the-air loss or
physical arrival/departure. An out-of-order report invalidates the exact maximum
gap claim, while aggregate/bin counts remain available.

`set_source` supplies measured per-window callback received/drop and external
processing-loss counters. Unknown flags remain explicit. Internal rejection of
invalid report-kind metadata is added to aggregation losses; AD errors and address
overflow remain separate scopes. Out-of-window reports are separate diagnostics
for the caller to route or account, not automatically attributed to this window.
Do not double-count internal rejection as an external processing loss.

Snapshots expose all fields needed for the frozen compact window contract:
received/worker/ADV/SCAN_RSP, bin worker/unique/RSSI-n/sum, global RSSI, measured
coverage, callback/aggregation/address losses, versions and the six quality bits.
`source_consistent` is false if any required source count is unknown or inconsistent;
a future wire adapter must not turn those unknowns into zero. Clock quality is
unknown by default; only the caller can establish a trusted whole-window UTC
mapping with `set_clock_usable`. No RTC/time anchor is invented here.

`snapshot` is a pure copy/derivation and never resets statistics or external
temporal history. Partial duration/bin count is explicit. `window_closed` means
the configured monotonic end elapsed, not capture completeness. Freeze the copied
aggregate before beginning another window. External ten-minute temporal/event
state remains separately owned and must not be cleared when a window uploads.

No wire serializer is implemented; actual transport byte-budget measurement,
policy/time authorization, durable retries and board acceptance are separate.

## Synthetic verification

```sh
UV_CACHE_DIR=/private/tmp/campuspulse-uv-cache uv run --no-project python -m unittest discover -s firmware/components/cp_v3_stats/tests -p test_stats.py -v
```

The address/undefined-sanitizer harness verifies actual allocation/free behavior,
512-key capacity, partition/report/bin/RSSI conservation, bounded deduplication,
heat, full/partial coverage, gaps and source losses, malformed/extended/fragment
reports, unclassified rule enforcement and history-preserving snapshots. The
production C source also compiles with actual S3 GCC and-Wall-Wextra-Werror.
Only synthetic data is used; no board, network or capture is accessed.

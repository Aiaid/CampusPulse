# ESP-NimBLE capture worker

One observer instance per board boot. `prepare` allocates actual statistics,
ten-minute temporal history, source ledgers, report/index pools and bounded
window/event handoffs before BLE initialization. All large arenas explicitly use
`MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT`; there is no internal-RAM fallback. Control
state and static FreeRTOS controls use internal memory. Configurable internal and
PSRAM free/largest-block floors are checked before/after each allocation and
before/after BLE initialization, host startup/synchronization and worker creation.
The default report pool is128 full SDK reports, each retaining up to1650 payload
bytes and its SDK metadata. Defaults are4 window handoff slots,1 exposed event
front and an8192-byte collector stack. The actual target ABI allocation sizes
and heap readings are returned in status; these are measured allocations, not
estimates from advertised PSRAM capacity.

Preparation waits at most5s for NimBLE synchronization while scanning remains
paused. Failure returns a sanitized stage such as `reports_alloc`,
`temporal_after`, `ble_init`, `ble_after` or `ble_sync`, an error and heap metrics.
`prepare_status` also works when the first allocation failed. Failed preparation
has boot lifetime: there is no implicit teardown/retry or memory fallback.
Neither observer-host stop nor deinit is called; this avoids the known5.5.3
observer-only deinit assertion. Scan procedure cancellation is used for pauses;
the host remains alive until reboot.

## Ownership and authorization

The collector owns all stats/temporal mutation. Network, durable upload queue,
clock mapping and optional raw TF writer remain board-owned. The raw hook runs
only on this worker and must nonblockingly copy into a separate writer queue.
Its boolean means accepted by that queue, not written, synced or uploaded.
Status separately counts hook invocations, acceptance and rejection. Report
pointers are borrowed only for the hook's duration. Do not call capture APIs or
perform filesystem/network I/O from the hook.

Only the board's exact committed applied/lease receipt path may call `start` or
extend `deadline`. The component never synthesizes policy scope or treats contact,
GET/config, a build or a generic HTTP response as permission. The initial
assignment must match the actual prepare context. This first adapter permits
only that same complete node/boot/policy/hash/placement/dataset for its lifetime;
different scope/generation is refused instead of silently changing local event
context. A future explicit reconfiguration boundary or reboot is required.
Closed-window sequence IDs cannot be reused by a resumed start. Upload stream
sequence allocation remains the board's boot-global responsibility.

Deadline checks occur before/after starting a scan, in every accepted callback
and every worker pass. A delayed scan-start command cannot authorize collection
after the frozen deadline. At expiry the accept gate closes and the worker
cancels scanning, drains older accepted reports, closes the partial window and
censors open observations as `lease_expired`. Scheduling/controller cancellation
latency is not claimed to be zero; late delivered reports are counted as ignored
and never processed under expired authority. Renewal after expiry is refused by
the deadline API; explicit new authority/start is required.

`stop_after_windows` defaults to0 for continuous operation. A nonzero value is
an explicit controlled-test limit (at most1,000,000): after exactly that many
full closed windows, acceptance stops at the boundary, `bounded_complete`
becomes true, pending handoffs remain and no additional partial window is
created merely because an uploader learned of the final window late. Episodes
are censored as `scan_gap`; history is preserved. This limit does not represent a
production sampling/address cap or an upload quota.

## Ordering, drops and window handoff

Callbacks timestamp and allocate the global report sequence under the source
spinlock, count source reports, borrow a preallocated free index, copy full legacy
or extended metadata/payload and publish the ready index nonblockingly. The
bounded1650-byte copy shares that lock, so concurrent publication cannot reorder
source timestamps. Invalid SDK lengths/pointers and exhausted pools have explicit
source loss counters. Pressure closes the accept gate and pauses scanning; no
unacknowledged snapshot is overwritten to create capacity.

A separate per-window callback ledger records received/full/invalid counts;
statistics counts are not inferred from the retained address table. Ledger
capacity is `window_slots +2`, independently bounded. Exhaustion is explicit and
cannot become a false zero-loss source claim. The worker rotates at report
timestamps and exact window boundaries while a normal scan remains active across
upload windows. Coverage is recorded from actual acknowledged capture scanning
and pauses, not inferred from the presence of reports. Initial fractional start
gaps and paused tails remain quality flags. Partial closure rounds only the
empty paused tail to integer milliseconds, keeping duration/bin/time tuples
consistent while retaining all earlier report timestamps and sequences.

Timer-driven temporal advance first takes the source lock, requires the ready
queue empty and no callbacks/held report, then captures current monotonic time
while still locked. A later callback obtains its timestamp only after acquiring
that same lock, so it cannot arrive with an earlier timestamp than an idle
advance. Earlier ready reports always drain first.

Window snapshots are copied into the bounded handoff queue; a full queue retains
an additional pending snapshot and any held report, pauses the scanner and waits
for space. `window` only peeks; `window_release` requires the exact window sequence
and assignment generation, and the board must call it only after freezing and
committing durable upload custody. The handoff itself is volatile. Queue release
does not reset temporal history. Recovery resumes only with valid remaining
authority and real handoff/temporal capacity.

## Independent temporal history and events

Temporal history must be configured for600,000ms and has its own tracks/open/
terminal capacities. Ordinary pauses use the history-preserving temporal censor
API, never the context-boundary reset. Real clock changes segment observations
through the explicit clock boundary. There is no waiting-time or arrival/boarding
inference. Address/type keys stay local, and no changing addresses are merged.

The temporal API exposes a FIFO terminal front. Capture therefore publishes
**one in-flight terminal front**, retaining it in temporal until the board's
durable freeze is followed by exact `event_release`. Extra allocated event
descriptor slots are a memory budget, not claimed parallel publication capacity;
the underlying temporal terminal pool holds its own bounded backlog. A full
terminal pool pauses capture without overwriting pending observations. Event
release requests are processed by the collector, preserving single-owner core
mutation. Repeated completed release is idempotent by ID/revision.

Default `report_events=false` explicitly consumes terminal snapshots locally,
counts `events_consumed_local` and emits nothing to the cloud. It does not clear
rolling history and cannot permanently stall merely because reporting is off.
Actual upstream report/window/event/raw writer losses remain separate counters.

## Verification boundaries

Run the production adapter with deterministic IDF/NimBLE shims and ASan/UBSan:

```sh
UV_CACHE_DIR=/private/tmp/campuspulse-v3-queue-uv uv run --no-project python firmware/components/cp_v3_capture/tests/test_capture.py
```

Cases cover continuous scan across windows, full legacy/extended raw copies,
raw-copy rejection, immutable repeated peeks, source/drop conservation, report
pool and window/event handoff pressure, retained pending snapshots, authority
expiry before capacity recovery, fractional partial closure, exactly-three-window
controlled completion without a fourth, delayed start crossing authority expiry,
source/timer race injection, history preservation, intentional report-off drain,
rejected context/sequence reuse and pre/post-allocation/BLE memory-floor failures.
The shim is a deterministic orchestration test, not a multi-core timing or RF
throughput measurement.

The production component also compiled and linked with ESP-IDF5.5.3's actual
ESP32-S3 compiler/headers in an isolated standalone probe. This validates APIs
and target compilation; it does not establish physical PSRAM capacity, battery,
pins, radio completeness, stable Wi-Fi/BLE coexistence, raw TF persistence or
production endpoint behavior. Board owners must consult the actual board's
official revision documents, measure prepared heap/stack budgets and conduct
separate physical acceptance. No device, serial or network operation is part of
this component's tests.

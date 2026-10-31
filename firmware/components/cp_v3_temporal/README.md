# Local rolling observation history and candidate episodes

Portable, caller-owned C state for the final small-statistics direction. It does
not scan, persist, upload, classify, estimate people or estimate elevator waits.
Only synthetic host replay has been run here; hardware RAM/timing and queue
integration require separate acceptance. No implementation or dependency was
copied from another repository.

## Memory and retention

`cp_v3_temporal_memory_bytes(config)` is the **exact ABI-specific arena size**,
including alignment, engine state, all address/history storage, active episodes
and terminal outputs. Allocate it once in caller-owned memory such as PSRAM;
pass the same configuration to `init`. Insufficient size or misalignment fails
before initialization. The implementation performs no heap allocation.

The default has 512 address/type tracks, 300 two-second slices (600000 ms), 64
active event slots and 64 terminal slots. The tested 64-bit host ABI uses:

| Allocation | Bytes |
| --- | ---: |
| History: 512 × 300 × 12 | 1,843,200 |
| Local address/type table | 16,384 |
| Slice coverage metadata | 4,800 |
| Active events | 15,872 |
| Terminal snapshots | 13,824 |
| Engine and alignment | 272 |
| **Exact total** | **1,894,352** |

Query the layout on the target; do not use host `sizeof` as a board measurement.
The history cell has a compile-time 12-byte assertion: RSSI sum, report count,
RSSI count, min/max and a local generation tag. Counts/indices representing up to
512 tracks use `uint16_t`. Track handles also have a `uint32_t` generation so a
stale handle fails after eviction; generation exhaustion fails rather than
wrapping. Event sequence/revision counters use `uint32_t`.

Supported slices are 1000, 2000 and 5000 ms. History is an exact multiple of the
slice width, up to 600000 ms. The ring retains that number of slices **including
the current partial slice**. Its oldest boundary therefore advances one whole
slice at each rollover; it does not retain an additional partial slice outside
the declared memory. Event state is separate: an episode may outlive every cell
from its beginning while retaining cumulative counts, coverage and RSSI.
`history_truncated` then explicitly qualifies its snapshot.

An upload window, a read snapshot, open publication and terminal release never
clear rolling history or reset cumulative episode statistics. History clears
only at an explicit context boundary or a full caller-requested wipe. Terminal
outputs survive context boundaries until the caller releases their exact ID,
sequence and revision.

## Ordered coverage and observations

One worker serializes all calls. Initialize with a real boot/config/placement
generation and a time anchor. Coverage begins unknown. Call
`set_coverage(time, true)` only after the adapter can account for scanner and
ingress coverage. Feed reports and coverage transitions in timestamp order;
advance a periodic clock **only after draining all reports with earlier source
timestamps**. Advancing states that the interval since the previous call has the
currently declared coverage. This is an adapter claim, not proof of RF
completeness. Duty-cycle/controller gaps and lost callback/worker reports must
not be presented as continuously known coverage.

Each ordered history snapshot exposes report presence, report/RSSI count,
sum/min/max, measured known-coverage milliseconds and gap milliseconds.
No-report slices become `ABSENT` only when finalized and fully covered.
Partial coverage, gaps, current partial slices and slices before a key was
tracked remain `UNKNOWN`. Observed reports remain `PRESENT` even when coverage
is partial. RSSI may be unavailable; then it contributes to reports but not RSSI
count/sum. Valid RSSI is [-127,20]. An all-zero RSSI count means min/max are
unknown; a wire adapter must serialize them as null, not zero.

The key is the exact local address bytes plus address type. Equal bytes with
different types stay separate. New/randomized addresses are never merged, and
there is no extension or reuse of the old per-window token protocol. Keys exist
only in the volatile arena and lookup/report inputs; history and event snapshots
contain no address or derived address identifier.

Late input fails explicitly and increments the rejection counter. It censors
open episodes and marks the affected retained history's coverage unknown.
Overlapping terminals that have **not** been released are changed to censored
with a new revision; an old terminal copy cannot be released accidentally.
Already released outputs cannot be recalled by this volatile component. This is
why the worker must establish timestamp order before advancing or publishing;
after a violated ordering guarantee the adapter must report the loss, not claim
that previous outputs were repaired.

## Episode semantics and bounded output

A report during known coverage can start a `visibility_segment` candidate.
Its ID is generated from caller-supplied cryptographic entropy with UUIDv4 bits;
it is not derived from the local key. `event_seq` identifies local episode
creation order. It is **not** the backend per-stream item `q`; a wire/queue owner
allocates that independent sequence for every frozen emitted item.

Only uninterrupted known absence for `gap_ms` produces `closed/observed_gap`.
The end is the observation-gap threshold and `last_seen` remains the last actual
report. This means an observation episode ended; it establishes neither arrival
nor departure, boarding nor a waiting start, and it is not a physical identity.
Scan gaps, late input, timeouts, address/event eviction, clock/config/placement
changes, reboot boundaries and lease expiry produce `censored` states.
The supported reasons and five quality bits match the small-statistics contract.

Default reporting is terminal-only: the first terminal revision is 1. Optional
open reporting explicitly calls `event_publish`, normally no more frequently
than policy `min_update_ms`. It creates the next revision only if state changed;
repeated unchanged calls return the same value. A later terminal is the next
revision. `event_at` is a read-only **local inspection**, not a frozen wire
revision: it may show new totals under the last published revision, or revision
zero before the first publication. Freeze outputs from `event_publish` or
`terminal_peek`; retries belong to the separate exact-byte durable queue.

Only full, fully covered slices without a report increase `absent_slices`.
`present_slices` counts distinct slices containing reports; neither is a count
of people. Coverage and RSSI totals accumulate across history rollover. Event
lifetime is bounded at at most one day; reaching it censors even a continuously
visible source. An explicit per-event report ceiling and per-cell count bounds
fail/censor before counters or revisions can wrap.

Address capacity evicts the least recently observed key deterministically and
censors its open episode. Active-event capacity independently censors the least
recently observed open episode while retaining address history. Both losses have
separate counters. Terminal capacity never overwrites an earlier result: excess
terminals remain in their active slots, the component applies backpressure,
coverage becomes unknown and new reports are rejected/countable. Drain with
`terminal_peek` then `terminal_release` after safely copying/freezing the exact
value. Resume known coverage explicitly. Release is not an HTTP receipt or a
claim of durable storage. A callback must not block while this worker drains.

Setting `max_open_events=max_terminal_events=0` enables history-only operation.
Reports while coverage is unknown still update history but do not open new
episodes; `event_suppressed_reports` exposes that omission. The default 64 active
slots is an explicit bound, not a promise of 512 concurrent candidates. Negotiate
and size event/output capacity separately from the 512-track history budget.

Clock epochs, UTC availability or UTC/monotonic disagreement beyond declared
uncertainty censor active episodes and reset local history. Use explicit
`boundary` for clock/reboot monotonic resets, config/place changes or lease
expiry. It censors before crossing a new context; it never manufactures a normal
gap completion from the change. A physical reboot loses this volatile arena:
recovering or censoring already-uploaded open events after power loss requires
the owning runtime/backend protocol and is not implemented by this component.

## Synthetic validation

```sh
UV_CACHE_DIR=/private/tmp/campuspulse-v3-temporal-uv uv run --no-project python firmware/components/cp_v3_temporal/tests/test_temporal.py
```

ASan/UBSan tests cover exact arena bounds and wipe, slot 511, all slice choices,
explicit ordered presence/absence/RSSI/coverage, 30/60-second snapshots, a single
700-second episode across ten-minute rollover, terminal revision ordering,
timeouts, scan loss, late events, UTC/epoch/context changes, old handle rejection,
independent identity/event eviction, terminal backpressure and entropy failure.
An independent 20-minute interval ledger checks every retained history cell for
all three slice widths. All inputs are synthetic; no hardware, real captures,
network service or backend acceptance is part of these tests.

# Elevator cohort-disappearance rules

Decision: 2026-10-25. The user selected a rule prototype: several previously
stable BLE identifiers disappear together, potentially after entering an elevator.
No model training is required. The source integrates private D1 reads, a public
aggregate endpoint and the existing field-record panel; deployment and physical
calibration remain separate acceptance steps.

## Data path

Fixed node -> existing v2 windows/address summaries/status -> private D1 ->
bounded read-time reconciliation -> pure cohort detector -> public aggregate
events -> elevator place in the existing field-record panel.

The existing ingestion protocol, ACKs, schema, retention and firmware are reused
unchanged. There are no background task delivery assumptions or event-write races:
each read recomputes at most 60 retained windows from the latest field partition
within 15 minutes. The per-place selection is one node/boot/placement/config;
different observers do not get combined into a presumed people count.

## Rule

- Five-second bins by default; the actual configured bin width is respected.
- The previous six complete bins supply the stability baseline: present in at
  least three, including at least one of the last two. Freeze this denominator
  before absence begins.
- Last sightings within two bin widths form a cohort. After the whole grouping
  horizon, require at least three complete missing bins for every member.
- At least five identifiers and 30% of the frozen baseline must disappear.
- Missing/unhealthy bins reset warmup; new arrivals do not offset lost members.
  Persistent absence emits once; later reappearance is flagged on the candidate.

The thresholds are provisional. A default synthetic example loses six of 18
identifiers after 29 seconds and confirms at 55 seconds. Closed-window upload,
health/summary availability and browser polling add further latency.

## Evidence gates

Private queries retain node, boot, placement, config and field provenance. They
check placement validity/closures, enabled nodes, evidence expiry, actual received
availability, UTC bounds and uncertainty. Summary identity/type cardinality and
report totals must match the overall window. Scan duration, overflow, quality
flags and recent node-status loss deltas also gate participation.

Sequence gaps, clock epoch changes and inconsistent UTC/monotonic deltas interrupt
the baseline. Unknown UTC does not become an invented date. Delayed uploads keep
their observation time; validity is the latest observation minus its uncertainty
plus 120 seconds. Publication is a current recomputation, not a historical as-of
backtest, and does not imply radio completeness.

The window/source bounds also limit CPU and SQL parameters. Excess or invalid
evidence fails closed to a data-quality state. A public request never returns
MACs, raw items, node/config IDs or participant lists. The event ID hashes source
context and temporal bounds, without including addresses.

## Product behavior

`GET /api/v1/places/:id/elevator-events` exposes time intervals, disappeared/stable
identifier counts, unverified status and independent freshness/quality state.
404 means unknown place; 422 means a non-elevator place; storage failure is 503.
Reads are public and no-store, with no mutation endpoint.

The panel shows candidates separately from manual waits, and clears prior results
on refresh, place change and failed requests. Field data never falls back to demo.
There is a background explanation and an explicit note that walking out, occlusion
or address rotation can look similar. Identifiers are not people, and candidates
are not verified boarding/departure events or a wait-time forecast.

## Acceptance and follow-up

See [implementation checks](../notes/elevator-cohort-implementation.md).
For field calibration, record boarding/door-close intervals and hallway-exit
negative examples. Freeze thresholds before evaluating a later labeled segment;
report event precision/recall, sample counts, data availability and detection
latency. Single-node evidence alone cannot resolve every boarding/exit ambiguity.

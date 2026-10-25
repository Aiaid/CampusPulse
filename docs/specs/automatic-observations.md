# Automatic observation references

Status: implemented and locally verified, 2026-10-25. These versioned outputs
are experimental references, not validated vehicle totals or current elevator
waiting-time predictions. Deployment and physical acceptance are separate.

## Shared collection and backward compatibility

The existing v1/v2 device endpoints, policy fields, exact-body hashes, receipts
and stream sequencing remain intact. A v2 address summary may additionally carry
`vehicle_evidence` with `schema_version: "radar-compact-v1"` and these integers:

| Field | Meaning |
| --- | --- |
| `parsed_reports` | Strictly parsed AD report envelopes |
| `malformed_reports` | Malformed envelopes discarded before adding clues |
| `name_brand_mask` | 20 fixed, versioned brand-pattern bits |
| `exclusion_mask` | 11 fixed phone, gadget, office and related exclusion bits |
| `ecosystem_mask` | Two empirical module hints; not verified e-bike identities |

The two report counters must sum to the address report count. Unknown inner
fields, versions, impossible masks and overflow are rejected. An absent object
remains absent: old firmware still uploads normally, and automatic recognition
reports unavailable rather than inventing zero. This is not a raw-report policy
change. Raw remains off unless the operator explicitly enables its existing
bounded policy.

The collector worker parses the already copied, at-most-31-byte AD payload before
discarding it. BLE callbacks still only enqueue. Each address adds a fixed
16-byte accumulator (1024 bytes for 64 slots), with no retained observed name,
payload or additional address. State resets at each collection window. Codec
batches are capped at six addresses and still enforce the assigned byte/item
limits; actual C-produced 64-address fixtures exercise both 4096 and 8192-byte
limits. Host allocation measurements do not prove C3 runtime memory margin.

## Rule-based vehicle candidates

`worker/vehicle-rules.ts` and `firmware/components/cp_vehicle/` adapt selected
MIT-licensed Radar primitives with source attribution in [reuse](../notes/reuse.md).
The new classifier separates `e_bike_related`, `car_related`,
`vehicle_ecosystem` and `unknown`. Generic UUIDs, connectability and short data
alone never establish a positive vehicle clue. BYD-related names remain car
clues; generic modules and mixed ecosystems do not become e-bike counts.

Phone/gadget/office/Fast Pair exclusions win over positive clues. Strict parsing
handles repeated fields; malformed reports cannot add positives. Conflicting
vehicle categories cause abstention, not a zero count. Imported primitive parity
and the intentionally stricter classifier are tested separately against compiled
C. The 10-second historical Radar dwell rule is not a proof of parked presence,
and the new public count describes received rule-positive identifiers only.

Public analysis uses the latest eligible single-node parking-purpose window,
with exact node/boot/placement/config/window/time and receipt matching. It does
not add overlapping receivers together, fall back to an older positive result,
read raw R2 archives, or publish addresses, names and masks. Incomplete reception
can hide either positive clues or exclusions; `incomplete_vehicle_evidence` is
not a mathematical lower-bound guarantee. Empty, missing, stale, pending or
inconsistent evidence has explicit unavailable reasons.

## Elevator historical reference

The initial reference uses completed manual elevator waits, separately from BLE
visibility candidates. It reports the empirical median and p20/p80 sample range
for comparable local-hour and weekday/weekend cohorts. Engineering availability
defaults require five samples across two local dates, a 14-day lookback and
recent evidence. These thresholds are configurable and are not measured accuracy
guarantees. The API cannot yet distinguish floor, elevator group, direction or
independent sessions; those remain unknown.

The versioned BLE extractor keeps private visibility fragments and scan-gap,
clock, loss and overflow gates. Disappearance does not confirm boarding, and
first visibility does not confirm the start of waiting. It does not manufacture
completed wait labels or candidate waiting seconds. Learned BLE-assisted wait
prediction still requires separately labeled field sessions and calibration.

## Public response and UI

`GET /api/v1/places/:id/summary` adds the optional `automatic_observations` object
documented in `/openapi.json`: independent `vehicles` and `elevator` references
with method version, evidence timestamp, expiry, samples and unavailable reason.
Existing sensor/manual records keep their own semantics and freshness. Historical
references do not make the top-level observed-data freshness current.

The UI separates candidate identifiers, car/ecosystem categories, manual
measurements and historical waiting references. Missing evidence stays unknown;
valid evidence with no positive classification may show zero identified
candidates, which does not mean no physical vehicles. Current automatic output
is not inserted into retained-record replay; the selected past cursor never
receives a current inference.

## Library upload correction and recovery

The preexisting codec legitimately emits partial summaries shorter than their
configured 5000ms bin. The old item validator incorrectly required
`bin_ms <= duration_ms`, producing HTTP422 for e.g. 1488/1880ms windows. The
server now permits the configured bin on these partial windows while enforcing
exact policy equality, real duration, bins and report accounting. No padding or
policy rewriting occurs; six real-ingest ACK/retry regressions cover the boundary.

The firmware additionally synchronizes admission, nonblocking queue insertion
and stopping; uses an exclusive end covering the last admitted millisecond;
drains after admission closes; and refuses inconsistent encoded offsets with
explicit losses. Original frozen journal bytes remain immutable. A normal
restart clears only RAM rejection flags so the fixed server can receive eligible
old-boot batches; it does not grant new policies or erase the journal.

Local verification includes 832 tests across 65 files, production frontend build,
normal/headless C3 builds, C sanitizer/OOM tests and 36 actual production-codec
batches through server validators and the classifier. Real ephemeral workerd/D1
browser checks pass desktop and 390px candidate/history/manual reference flows,
legacy absence, pending/stale input, valid zero, replay isolation and public
privacy. Hosted deployment and physical evidence are recorded separately when
completed. No accuracy,
continuous radio coverage or hardware acceptance follows from these checks.

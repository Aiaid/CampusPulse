# V3 small statistics and candidate observation events

Status: final-default implementation contract, 2026-10-30; deployment and physical
acceptance are separate. This replaces raw-first as the normal path and does not
change historical feature-upload receipts. Raw stays local by default.

## Compact transport

`POST /api/v3/statistics/ingest`, enabled-node bearer credential, HTTPS, strict
uncompressed JSON, `X-Body-SHA256` of exact frozen bytes, no query parameters.
Requests are bounded by policy and 8192 bytes globally. One batch has one stream.
Unknown fields, duplicate decoded keys, unsafe integers and invalid UTF-8 fail.

```text
{p:3,z:"statistics/1",b:batch_uuid,n:node_id,o:boot_uuid,
 c:policy_id,h:policy_sha256,g:assignment_generation,d:dataset,
 k:"window_statistics"|"candidate_events"|"node_status",x:[items]}
```

The short wire keys are fixed aliases, not arbitrary JSON renamed statistics.
One normal window produces one item, independent of retained identifier count.
`b` is UUID v4; item `q` is a per-boot/per-stream uint32 sequence starting at one.
Policy changes never reset it. Exact batch retries return the original receipt;
changed bytes/scope or overlapping sequence identities conflict. A body contains
no addresses, names, stable beacon tokens, payloads or per-address lists.

Time tuple `T=[mono_ms,utc_ms|null,clock_epoch,uncertainty_ms|null]`; UTC and error
are both present or both null. Clock epoch starts at one. An observation with
unknown UTC cannot enter public projections. The initial reliable historical
upload subset requires known UTC and conservative interval authorization.

## Window item

```text
{q,w:window_seq,t:T,d:duration_ms,b:bin_ms,
 c:[phone_candidate,e_bike_candidate,car_candidate,other,unknown,conflicting],
 r:[received_reports,worker_reports,adv_reports,scan_response_reports],
 x:[[worker_reports,visible_identifiers,rssi_n,rssi_sum],...],
 s:[rssi_n,rssi_sum,rssi_min|null,rssi_max|null],
 l:[scan_coverage_ms,callback_drops,aggregation_drops,address_overflow_reports],
 f:quality_mask,v:[extractor_version,ruleset_version]}
```

`t` marks the exclusive window end. `w` is a boot-global window counter and never
resets on policy/clock changes; scope also retains config and clock epoch. Its
duration/bin layout must match the frozen policy (partial closures explicitly
flagged). Target fixed-point 60000/5000 ms and mobile 30000/5000 ms; max 60 bins
and max 512 negotiated addresses remain real bounds. Category counts partition
retained address/type keys once per window; their sum is visible identifiers,
not physical-device count. Each bin identifier count is independently bounded;
bin counts must never be added as unique people or vehicles.

Adv+scan-response counts equal worker reports; bin report counts sum to worker
reports; bin RSSI n/sum match the window RSSI aggregate. RSSI n may be smaller
than reports when values are unavailable; min/max are null only when n=0.
RSSI samples are integers in [-127,20], and sums must fit count/range bounds.
Coverage is measured scanning time, not an invented duration or absence proof.
Loss/overflow counts are explicit and cannot be hidden behind a zero quality mask.
Worker reports plus callback/aggregation drops cannot exceed received reports;
the counter scopes are per-window source claims, matching the edge core's
`source_consistent` check. Address-table overflow is separately counted within
processed reports and must not be double-added as callback loss.

Quality mask: 1 partial closure, 2 uncertain/unknown clock, 4 scan gap,
8 address overflow, 16 callback loss, 32 aggregation loss. Unknown bits fail.
The server validates count consistency and flags, not the truth of radio claims.

Initial extractor/rules are `cp-v3-stats/1` / `unclassified-v1`. For that ruleset,
all retained keys are unknown; the other category counts must be zero. Future
verified candidate rules require explicit server/policy version allowlists.
Company ID, OUI and Phone Appearance alone do not create a phone/vehicle count.
The backend always emits `estimated_total:null` until a separate calibration
contract has passed acceptance.

## Status item

```text
{q,t:T,u:uptime_ms,s:"running"|"paused"|"failed",
 r:[internal_free,internal_min,largest_internal_block,psram_free,stack_min],
 j:[window_pending,window_bytes,event_pending,event_bytes,status_pending,status_bytes],
 l:[window_drops,event_drops,status_coalesced,upload_failures,ack_failures,retries]}
```

`u===t[0]`. Counts/losses and uptime are boot-scoped; decreasing counters in
increasing sequence order fail, including delayed insertions. Queue capacities
are checked against the frozen device medium's global capacity, including older
boot/policy backlog. Stream reserves are minimum guarantees, not maxima. A
disabled event upload stream may still report historical pending event counts;
those counts do not authorize new event capture/upload. A policy too small for
the existing backlog must fail device application or drain first. This is status, not a lease
renewal. Measure normal window bytes separately from status/control/TLS overhead;
1 KB/minute is a design target, not a guaranteed measurement.
Each resource entry in `r` may be null when unmeasured/unavailable; zero is an
actual measurement, never an unknown sentinel. Queue/loss counters remain required.
When the policy enables `local_raw:tf_cpraw`, status also requires
`a:[enqueued,written,synced,queue_drops,storage_failures,space_stops]`, boot-scoped
local-writer counters, or explicit `a:null` if unavailable. Require
`synced<=written<=enqueued`; known counters cannot regress. With local raw off,
`a` is absent or null. Raw queue/storage loss is independent of statistics
callback/aggregation loss. This small status field uploads no raw bytes.

## Independent local history and event item

Local history is independent from upload windows: initially 600000 ms, 1000,
2000 or 5000 ms negotiated slices (elevator trial starts at 1000–2000), bounded
tracks and open states, per-slice ordered presence/absence,
RSSI n/sum/min/max and scan quality. Upload completion must not clear history.
Open observation state survives history rollover in bounded cumulative form.

```text
{q,i:event_uuid,v:revision,k:"visibility_segment",
 s:"open"|"closed"|"censored",a:start_T,l:last_seen_T,u:observed_until_T,e:end_T|null,
 r:[reports,present_slices,absent_slices,coverage_ms,rssi_n,rssi_sum,rssi_min|null,rssi_max|null],
 c:"snapshot"|"observed_gap"|"timeout"|"capacity"|"clock_change"|"config_change"|"placement_change"|"reboot"|"lease_expired"|"scan_gap"|"late_report",
 f:event_quality_mask,x:[extractor_version,ruleset_version]}
```

Event IDs are random episode IDs, never addresses or derived stable identifiers.
The local address/type key is not uploaded. Do not merge changing addresses.
Events segment on reboot, clock/config/place change. An event can span upload
windows and outlive the rolling history, but has its own bounded lifetime and
capacity. Default upload mode is terminal-only; revision snapshots are optional
and rate-limited. Timeout, capacity, scan/table loss and disconnect yield censored
states, not a successful physical event. Only `observed_gap` may close an ordinary
observation segment, which still does not establish arrival/boarding/waiting.
No event is a waiting-time prediction or replacement for manual references.
`a<=l<=u<=e` for terminal events; open events have no `e` and snapshot their actual
observed prefix through `u`. Coverage/present/absent totals are bounded by `u-a`.
`u` includes real scanned absences after the last received report; it is not a
new reception timestamp. Ordinary closed events have `u===e` and require capture
authority for the whole gap. Censored `e` is a logical stop marker and may follow
`u`; it cannot add observations outside an authorized capture span. Source age
is anchored to actual observations, never extended by a later timeout marker.
An ordinary `observed_gap` closure requires absent slices and an end at least
the configured `gap_ms` after last observation. Scan/table loss instead censors
the segment. New RSSI extrema require actual additional samples whose delta
count/sum can realize them; a revision cannot invent new extrema without samples.

Event quality mask: 1 history truncated, 2 scan gaps, 4 table loss, 8 censored,
16 revision gap. Server stores latest state per scoped event plus minimal receipts,
not an unbounded revision history. Revisions strictly increase; totals and start
identity cannot regress, terminal states cannot reopen, and late/stale revisions
cannot replace newer state. Missing revisions are explicitly marked.

## Capability and policy extensions

Keep `device-config/3` and `device-capabilities/1` with additive strict support.
Policy `evidence` gains `{mode:"statistics",schema:"window-statistics/1",
extractor_version,ruleset_version}`. Upload streams gain `window_statistics` and
optional `candidate_events`, with `node_status`; old features remain historical.
Optional `temporal` is `{mode:"off"}` or
`{mode:"rolling",slice_ms,history_ms,max_tracks,max_open_events,max_event_ms,gap_ms,
report_mode:"off"|"terminal_only"|"revisions",min_update_ms}`.
Statistics mode requires an explicit temporal object, though it may be off.

Capability `statistics` declares supported schemas/extractor/rules versions;
capacity remains in existing summary/body/resource bounds. Capability `temporal`
declares slice choices and maxima for history/tracks/open states/lifetime plus
supported event schemas/report modes. Missing/null capability never grants support.
Rolling history, open-event memory and the small persistent upload queue have
separate budgets. PSRAM is not durable storage. Local TF CPRAW and statistics
uplink are independent; local_raw may be off or supported tf_cpraw, while raw
sampling and cloud archive remain off by default.

## Control, authorization and persistence

Existing v3 registration/config/real applied ACK remain required. Add explicit
`POST /api/v3/device/lease` for statistics policies: strict
`{protocol:"campuspulse/3",boot_id,policy_id,policy_sha256,assignment_generation,
contact_seq,uptime_ms}`. A committed reply binds identity/hash/sequence and includes
server time and lease deadline. GET/config/status/replayed ACK never renew leases.
Renewal before expiry extends a contiguous authorized capture span; renewal after
a gap starts a new span. Keep bounded historical spans through the acceptance
deadline so delayed windows can be checked without inventing scan coverage.

New statistics batches may use a historical successful applied policy/boot until
its frozen accept_until, including after reboot. Keep the exact original body,
boot and identity. Observation time+uncertainty must fit its policy/capability,
placement and authorized lease span; current desired pointers do not rewrite it.
Unknown/unprovable historical time fails explicitly. New observations cannot
borrow a retired boot's authority. Credentials/revocation and authorization are
rechecked inside the final D1 transaction. Quotas/identity budgets survive cleanup.

The new receipt schema is `device-statistics-receipt/3`, with existing readable
protocol/node/boot/stream/batch/body_sha256/policy ID+hash/generation/sequence range/
accepted_count/receipt_id/received_at/expires_at/retain_until fields, plus
`durability:"committed",custody:"small_statistics"`. It acknowledges source
storage, not classification accuracy. Exact retry is stable and never restores
expired data. Expired sources return the original minimal receipt with expired
state; sequence/budget tombstones prevent reuse. Old feature/raw schemas cannot
be smuggled into the small-statistics route.

### Recovery before registering a new boot

An authenticated device can submit its old frozen window/status body before
registering the new physical boot. Only its original successful applied policy,
capture span and fixed source/acceptance deadlines authorize it; no new observation
is fabricated and no old body is relabeled to the new boot.

For control queue recovery, use `X-Receipt-Only: 1` on the original config-ACK or
lease POST. This narrow mode returns only an already committed, byte-identical
receipt. If no original receipt is retained, it returns non-retryable
`409 v3_receipt_not_committed` and creates no ACK, lease or span. ACK/lease
response shapes and request hashes do not change. Old ACKs and the last retained
lease receipt can be reclaimed after a new boot/capability becomes current; stale
or changed requests still conflict. Registration/config routes reject this mode.
Credential revocation still denies receipt recovery. Admission must never be
unblocked by pretending an uncertain old control request was newly applied.

The device need not persist or download the full historical policy/lease-span
database to retransmit an opaque original statistics body. The enabled node's
current bearer authenticates the node; the original body supplies boot/policy/
generation/hash/sequence references. The backend alone resolves its retained
applied history, observation authorization, placement, source deadline and
node/day quota. This grants delivery of that frozen body only, not new capture.
There is currently no device-facing historical-proof or budget-download endpoint;
administrator inspection is not such a device API.

Local structural/hash checks protect packet integrity and privacy, not capture
authorization. The sender must still restrict recovery to known small-statistics
record kinds, the same node and trusted configured destination, keep exact bytes,
and verify the full committed receipt. Missing authority, unprovable time,
expiry or denial is not an ACK and must not be repaired by changing old scope.

Boot UUID registration is identity/idempotency handling, not physical-boot
attestation. Same current boot, registration sequence and exact bytes return the
prior registration receipt; different bytes or stale ordering conflict, and a
retired boot cannot become current again. The server cannot distinguish physical
reuse of a UUID plus identical registration bytes from a legitimate network
retry. Fresh high-quality UUIDs provide probabilistic uniqueness, not a claim
of strict whole-medium rollback detection. Capture still needs actual policy
application and lease authority; registering alone never grants it.

Server quotas are application-body bytes accepted by the server. They do not
prove a device's remaining NVS write credits, physical wear, power budget or
available space. Those need a separate small durable local ledger/admission
record and trustworthy current-day handling, or conservative refusal when
unknown. A large historical proof package is neither required for server
reception nor a substitute for that local resource ledger.

D1 stores one window row, bounded latest candidate events, bounded status/lease
anchors and necessary receipts; no per-address default table or R2 upload is
required. Cleanup is independent of enablement and old raw cleanup failures.
Public reads require field/fixed-point/placement/time/freshness/quality validation,
select one stable active placement per place (lexicographic placement ID in
`stable-active-placement-order/1`, independent of latest receipt or positive
classification), and expose only aggregate units and versions. No fallback to a
more positive peer and no summing receivers; operators change selection through
explicit placement closure/rebinding. The route is
`GET /api/v3/places/:place_id/statistics`; it does not change manual observations.
Candidate events stay private; manual elevator waits remain authoritative.
Smoothing is causal and versioned, never repairs missing input or turns identifier
counts into calibrated totals. Late windows do not refresh current activity.
Known clock uncertainty up to the initial 5000 ms admission bound is preserved
and used conservatively for authorization/freshness/continuity; a nonzero error
bar alone does not disable activity smoothing. Unknown time, gaps and actual
loss/overflow still withhold smoothing. Do not force a fake zero uncertainty.

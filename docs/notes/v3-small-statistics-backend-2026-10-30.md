# V3 small-statistics backend implementation — 2026-10-30

Current production state is tracked in the
[2026-10-31 release record](v3-production-release-2026-10-31.md). The server is
deployed over native MQTT/TLS through EMQX and the authenticated Cloudflare
gateway. Bounded concurrent device checks passed for Waveshare three windows/
three statuses and T-Energy three windows/one final status, including exact
retries and safe stops. T-Energy checkpoint/historical recovery is observed;
post-test legacy-queue byte preservation and six non-writing production probes
passed. Independent authority/source/receipt-metadata reconciliation and scoped
public exclusion also passed. Normal-run original request bytes were not
independently rehashed; the recovered 762-byte checkpoint request additionally
passed CRC/SHA and original-receipt comparison. Historical
isolated-service trials below retain their original evidence boundaries.

Historical isolated acceptance status: local implementation, synthetic acceptance, a bounded physical
normal-profile 60s/5s × 3 run and one independent local-TF concurrent window
passed. Sustained device acceptance remains separate. The 2026-10-31 authorized
release configuration now enables production control/statistics by default;
native deployment and the completed bounded remote audit are recorded separately
from long-run, calibration and arbitrary power-loss acceptance.
This follows the
user's final default: edge aggregation and small results; local TF research raw
is independently optional. The historical eight-identifier feature experiment
and raw-first drafts are preserved, not the default upload path.

## Production release configuration — 2026-10-31

The user authorized committing/pushing V3, deploying the server and then testing
both boards. `scripts/cloudflare-config.mjs` generates these public Worker vars:
`DEVICE_V3_CONTROL_ENABLED=true`, `DEVICE_V3_STATISTICS_ENABLED=true`,
`DEVICE_V3_PRODUCER_VERSIONS=["cp-v3-small/1"]`,
`DEVICE_V3_INGEST_ENABLED=false` and `CPRAW_ARCHIVE_ENABLED=0`.
The CI deploy environment uses the same defaults without requiring new GitHub
variables. Only exact `true`/`false` control/statistics overrides are accepted;
statistics cannot be enabled while control is disabled. Disable statistics alone
or both gates for shutdown. Producer expansion, malformed values and enabling
historical feature/CPRAW ingestion fail before a deploy config is written.
These non-secret vars are separate from retained Worker secrets. The ordinary
local `wrangler.jsonc` remains opt-in and keeps its placeholder resource IDs.

Apply all pending additive D1 migrations before the Worker deployment, including
0016/0017. The existing 15-minute cron attempts statistics/lease cleanup even
when an older stream's cleanup fails. Current v1/v2 ingestion routes and storage
remain supported; the new statistics namespace guards prevent frozen batch ID
or sequence collisions. Preserve old device credentials, queues and policies;
do not repurpose an old boot/stream identity for a different protocol.
Public V3 statistics stays a separate aggregate API; controlled-test data is
excluded, and enabling this release does not populate the existing v1 views.

Local release checks cover generated gates/whitelist/shutdown rejection,
historical protocol compatibility, and actual workerd migrations/concurrency.
They do not establish remote D1 migration status, production credentials, cron
execution or either board's production upload/recovery acceptance.

The subsequent native backend/gateway release `fdcddd6` passed
[CI41181875701](https://github.com/Aiaid/CampusPulse/actions/runs/41181875701)
and was deployed. `e53d176` then made the shared native transport default-off,
with explicit opt-in in the two V3 apps to preserve old V2 network owners.
The [production release record](v3-production-release-2026-10-31.md) separates
the first Waveshare MQTT three-window/three-status device success from the later
concurrent device pass and independent authority/source/receipt-metadata audit.
T-Energy's real one-window/no-post checkpoint and exact historical-window
recovery preceded a management-timeout attempt with no new normal windows/status.
Its subsequent concurrent run passed three new windows and one final status;
that intended cadence differs from Waveshare's three statuses. The isolated
HTTPS records below retain their original scope and are not the formal
production transport. The current normal runs stored exactly 3 windows / 3
statuses / 6 batches for Waveshare and 3 windows / 1 final status / 4 batches for
T-Energy, with no candidate events. Their MQTT assignments and source windows
retain controlled-test data with no public place; public statistics require
field scope and a bound place, and V3 ingestion does not write legacy projections.
Retained V2 projection rows are not evidence of new V3 public contribution;
their matched per-node count delta was not verified. Temporary administrator
sessions were revoked and the former-cookie read-only probe returned 401.

## Implemented boundary

The [strict wire contract](../specs/v3-small-statistics.md) uses one compact item
per window, independent of address capacity. It includes candidate/unknown/
conflict counts, deterministic bins/RSSI aggregates, actual loss/coverage and
versions; `estimated_total` remains null. Initial unclassified rules require all
retained keys to remain unknown. No addresses, beacon tokens, payloads or
per-address source rows are accepted by the new endpoint.

Migration 0016 adds explicit bounded capture-lease spans; migration 0017 adds
window rows, latest private event states, bounded status/sequence anchors,
receipts and quotas. A historical boot's frozen batch remains eligible until its
original acceptance deadline only when its original successful applied policy
and actual observation interval authorize it. Clock/policy/place changes segment
events. Counters/floors survive payload cleanup and prevent identity reuse.

Candidate observations distinguish last reception, actual observation cutoff
and logical end. Censored tails cannot add radio/absence coverage. Revision
totals and RSSI extrema must be possible with the additional samples. Timeout,
loss and missing coverage are not boarding or successful waiting events. Event
upload remains optional and first device acceptance starts with it disabled.

Recovery before new-boot registration uses old frozen data identities and a
receipt-only ACK/lease mode. Missing committed control receipts conflict without
creating a new old-boot capture lease. Already committed replies remain stable
after retirement; revoked credentials are rejected.

`GET /api/v3/places/:place/statistics` is a separate aggregate read. It selects one
eligible receiver, validates field/fixed-point/placement/time/quality provenance,
and uses bounded causal smoothing of mean per-bin visible identifiers. It does
not sum windows into people/vehicle totals or replace manual elevator evidence.
Private events, controlled-test data and mobile research do not enter this read.

## Measured synthetic request bytes

These are complete frozen JSON request bodies, not actual radio measurements or
capacity guarantees. Status/control/HTTP/TLS and retries are additional traffic.

| Synthetic fixture | Bytes |
| --- | ---: |
| 30 seconds / 5-second bins | 585 (1170 B/minute) |
| 60 seconds / 5-second bins | 678 |
| Dense 512-key, 20000-report 60-second window | 798 |
| Dense window with maximum-length node/policy scope | 878 |
| Wide-value valid 12-bin stress case | 1442 |
| Wide-value valid 60-bin stress case | 3904 |
| Terminal observation / censored absence tail | 610 / 613 |
| Status / status with local-TF writer counters | 430 / 452 |

The 1024-byte producer budget rejects oversized fixtures rather than truncating
them. T-Energy's planned NVS record also has encoding overhead; physical free
space, GC, power loss and three-slot admission require device acceptance. The
backend never turns a planned 3072-byte body budget into a measured capability.

## Verification and isolated service

Tests cover strict parsing, mathematical conservation, candidate revisions,
R2-free small-row custody, exact retries, historical leases/gaps, daily quota,
write-after-revocation/deadline rollback, old-protocol namespace conflicts,
expiry/floors and independent cleanup. Separate local workerd/D1 tests exercise
real constraints and races; passing these does not establish board reliability.

The statistics-specific integration client passed 23 HTTPS synthetic checks,
including registration, assignment, actual synthetic ACK, compact window/status,
stable receipt retries, conflicts/wrong-node rejection and explicit lease renewal.
Actual device modes only prepare/inspect; they never create a board ACK or upload
observations on its behalf. Pure checked-in generators create reproducible
statistics and control fixtures without private captures or credentials.
The continued-task full regression passed 108 files / 1421 tests. The additional
receipt-only control recovery change then passed 51 focused control tests and
TypeScript validation; it still requires firmware transport adoption before
preregistration control recovery is accepted as a device feature.

The public-tunnel service start was rejected by automatic approval review because
the current authorization did not explicitly cover public exposure of real test
identities/authentication surfaces. That tunnel was stopped. The safer test
service is bound only to the actual private LAN interface, with a short-lived
private test CA, matching IP SAN and strict certificate/name/date verification.
It is not remotely deployed Cloudflare infrastructure. Device LAN reachability
requires per-board TCP/TLS testing. CA bundles never contain a private key.

The first normal-profile Waveshare attempt subsequently reached this LAN TLS
service, registered its own capability, fetched generation 1, and committed a
failed `resource_exhausted` ACK. It produced no window/status source. The firmware
session is investigating arena/resource preparation; this partial failure is not
normal-profile physical acceptance. Historical feature-trial success is separate.

On continuation, automatic review also rejected restarting this LAN service and
cross-thread message sends because it required explicit authorization in the
current chat. The listener was stopped and a connection check confirmed it was
closed. Source-TTL housekeeping continues locally without a network listener or
private-key use. Service restart and further cross-thread sends remain pending
that authorization; this is not a successful new normal-profile device run.

The user later explicitly authorized both cross-thread synchronization and
public connectivity in the backend chat. After checking 0600 secret files, zero
retained radio source payloads and eight loopback exposure cases, the temporary
Cloudflare Quick Tunnel was approved and started. Its source service binds only
127.0.0.1; cloudflared verifies the origin test CA and name, and public clients use
normal public-CA verification. No TLS-verification bypass is enabled.

The public statistics client passed 20 synthetic checks. A further five public
receipt-only cases retrieved committed ACK/lease replies, rejected absent or
changed renewals, and left the complete authorization state unchanged. Real
Waveshare statistics remain zero (one prior resource-failure ACK); T-Energy has
not registered V3. Public access therefore does not imply physical acceptance.
Private bootstrap profiles now contain the new public test origin and no local
test-CA override. Raw and historical per-address upload gates remain off.

The service begins drain after approximately 90 minutes, then clears remaining
sources at their original TTL and exits. A separate owned-connector guard stops
only this temporary tunnel when the source service ends, with a three-hour
fallback lifetime. Production infrastructure and protected device data are
unchanged. The temporary hostname and credentials remain in ignored private
operational files, not this note.

On 2026-10-31 (Asia/Shanghai), the previous run was confirmed stopped with zero
remaining source payloads. The same isolated database, credentials and retention
settings were restored behind a new temporary public hostname. Eight public
exposure checks passed. Private client/bootstrap profiles were refreshed without
changing device identities. A 20-minute, one-assignment watcher reads only the
Waveshare's actual fresh capability and publishes a compatible raw-off policy
with the observed generation CAS; it never registers, ACKs or uploads for the
device. T-Energy remains inactive. The restored public endpoint passed 20
synthetic statistics checks and five receipt-only checks; synthetic authorization
state was unchanged by receipt recovery.

The corrected board then registered its actual capability and committed an
applied generation-2 ACK. Four status records and their matching receipts were
stored, with successful contiguous lease renewals, zero reported window/event
drops and no public projection rows. Window requests returned HTTP 409 and no
window was initially stored. The firmware session safely stopped with original frozen
windows retained on TF. Its timing analysis found that the first window's end
uncertainty, projected back over the duration, could put its conservative start
several milliseconds before the initial lease span; this remains a diagnosis to
confirm using the original request/error response, not permission to relax the
server's capture checks.

The isolated helper now records at most seven aggregate rejection-code counters
(`code`, `status`, bounded `count`, `last_at_ms`). It stores no node identity,
request, token, hash or free-form message. Eight integration-server tests and
TypeScript validation passed. After the board stopped, the same-realm source was
restarted to enable this diagnostic without changing existing policies, ACKs,
lease spans or source TTLs. The public hostname stayed the same. A shorter
remaining service lifetime preserves the original approximately 90-minute test
window.

Replaying the original TF batches confirmed exactly one diagnostic rejection:
`v3_statistics_capture_unauthorized`. The first generation-2 window remains on TF
with its original identity and TTL. Its later windows 2 and 3 (60000ms each),
and the historical extra partial window 4 (486ms, quality mask 7), were committed
under their original generation-2 authority after the new boot registered.
Every stored receipt matched its batch/policy/sequence metadata. Device serial
logs measured these unchanged request bodies at 768, 768 and 516bytes; the
database stores their full-body digests and normalized items, not original body
lengths. These historical successes do not count toward the corrected boot's
three-window acceptance. Generation 3 has a real applied ACK and separate lease;
its three new windows and first-window exact retry then passed. Public projections
remain empty.

Generation 3 stored exactly windows 1–3, each 60000ms, plus three status receipts.
Device logs measured complete window bodies of 767/768/768bytes and status bodies
of 456/458/457bytes. The deliberate first-window retry returned the same receipt
and did not add a row. SDK report totals were 5960/6322/6220; callback,
aggregation and address-overflow losses were zero in these windows. Recorded
coverage was 59999/60000/60000ms, clock uncertainty 679/709/739ms and quality masks
6/2/2. These retained uncertainty and gap flags are not a zero-error or complete
radio-observation claim. Device history advanced 34/64/94 slices across uploads.
Contiguous lease renewal reached contact 3. The device reported three current
window ACKs, three current status ACKs, zero current pending batches and safe
cleanup; one historical rejected window remains pending on TF. Historical ACKs
were counted separately. This is bounded real acceptance, not sustained 512-key
load, arbitrary power-loss recovery, classifier accuracy or deployment acceptance.

An independent generation-4 boot then enabled TF-only CPRAW recording while
retaining the same small window/status uplink. Its policy used 1MiB segments,
32MiB managed storage, 1MiB minimum free space, 1s sync and a 64MiB/day logical
write cap; these are test policy limits, not measured endurance. Cloud raw sample
and archive remained off. The backend verified exactly one 60000ms window and
one status receipt, with no duplicate row from the exact retry. Device logs
measured the bodies at 772 and 487bytes. The window retained 6326 SDK reports,
59999ms coverage, 680ms clock uncertainty, quality mask 6 and zero reported
callback/aggregation/address-overflow loss.

The uploaded status's raw snapshot was enqueued/written/synced =
6326/6326/6243, with zero raw queue drops, storage errors or space stops. It
preceded final sync and must not be described as the final file result. The
firmware session separately verified device-final enqueue/write/sync =
6326/6326/6326, one 487877-byte file, one clock anchor and a successful read-only
CRC scan covering all 6326 reports. Device final cleanup was safe with zero
current pending and one preserved historical rejected window. Backend CPRAW
uploads/policies, historical-feature source rows for the device and public
projection rows all remained zero. The two one-assignment watchers exited;
the source service and its owned-connector guard retain their existing drain
and real-TTL lifecycle. No production deployment or new device activation was
performed by this acceptance.

Private state is isolated under ignored `data/v3-statistics-integration/`; the
synthetic, Waveshare and T-Energy nodes have distinct credentials. Default profile
enables only control/statistics, disables feature ingest/CPRAW, and seeds neither
device capabilities nor ACKs. Local maintenance and drain include the new small
statistics sources, run independently of old raw cleanup, and report backlog.
The previous feature-trial sources were cleared at their real TTL and its service
exited; its minimal receipts and redacted acceptance evidence remain intact.

## Remaining acceptance

Extend actual queue admission, observed clock uncertainty, heap/contiguous block/
stack peaks, serialized body and encoded record bytes, callback/aggregation/
history losses, retries, cross-window open state and restart drain on each board.
Extend the bounded microSD/statistics coexistence test to sustained load and
power-loss recovery; local recording never enables cloud raw. Ten-minute history
and episodes longer than history have replay tests; this note does not claim a
completed long live elevator pilot.
Production enrollment/clock recovery, capacity/cleanup throughput, calibration
and manual TF/stopwatch validation remain separate. Deployment and the current
bounded MQTT device evidence are recorded in the release note linked above;
the bounded remote metadata audit passed, with the original-byte distinction
above. Scheduled real-deadline cleanup and sustained operation remain separate.

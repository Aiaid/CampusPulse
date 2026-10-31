# V3 production release — 2026-10-31

Status: the native MQTT backend/gateway is deployed. One bounded Waveshare
production MQTT run passed the device-side three-window/three-status, exact-retry
and safe-stop checks. A subsequent concurrent run passed device-side checks on
both boards: Waveshare three windows/three statuses, T-Energy three windows/one
final status, with exact retries and safe stops. T-Energy also passed a durable
checkpoint and reclaimed that historical frozen window after restart.
Independent Cloudflare authority/source/receipt-metadata reconciliation,
controlled-data public exclusion, post-test legacy-queue preservation, six
non-writing gate checks and temporary administrator-session revocation passed.
Normal-run original request bytes were not independently rehashed; the
checkpoint's recovered 762-byte request has that additional verification.
The earlier [isolated Waveshare acceptance](waveshare-small-statistics-acceptance-2026-10-30.md)
and [backend verification](v3-small-statistics-backend-2026-10-30.md) retain their
original scope and do not substitute for this production run.

The user's subsequent transport correction requires the existing native
MQTT/TLS → Hangzhou EMQX → Cloudflare gateway → `MqttDeviceApi` path. The direct
HTTPS board attempts documented below are historical diagnostics. The
[V3 MQTT frame and authenticated backend](../specs/device-v3-mqtt.md) passed
local relay/workerd/service-binding/D1 tests and is deployed. The bounded device
evidence below establishes the bounded release acceptance. Sustained operation
and arbitrary power loss remain separate. A Mac proxy is not the production path.

## Deployed server

The real Worker is [pulse.anend.net](https://pulse.anend.net).
The native V3 backend and gateway were deployed from `fdcddd6`;
[CI run 41181875701](https://github.com/Aiaid/CampusPulse/actions/runs/41181875701)
completed `check` and `deploy`. The later `e53d176` source change makes native
MQTT default-off in the shared component and explicitly enabled in the two V3
apps, preserving the old V2 owners' build boundary. It does not itself establish
new hardware acceptance.
The subsequent `c54aaf7` release passed
[CI run 41187235858](https://github.com/Aiaid/CampusPulse/actions/runs/41187235858)
(`check` and `deploy`), with 112 test files / 1475 tests in the full suite.

The earlier
[CI run 41171820515](https://github.com/Aiaid/CampusPulse/actions/runs/41171820515)
completed both `check` and `deploy` for commit `fb703fa`. Remote D1 migrations
0013 through 0017 are applied. Six independent, unauthenticated, non-writing
gate/public-read checks passed. This earlier release remains the migration/gate
baseline; it does not establish the later MQTT device results.
After the MQTT runs, all six non-writing production gate/public-read probes
passed again. These read-only probes are separate from device delivery and
independent source/receipt reconciliation.

The release enables V3 control and small statistics for producer
`cp-v3-small/1`. Historical V3 feature ingestion and CPRAW upload remain disabled.
Cloud raw and per-address uploads are off; `unclassified-v1` keeps observed
identifier keys in `unknown`. Local research recording remains an independent
option. Aggregate BLE-visible identifiers are not a count of people or a
validated elevator-wait estimate.

Both existing production device credentials were recovered/reused without
rotation. Normal administrator APIs created separate unlocated
`controlled_test` placements, with no public place association. Existing nodes,
legacy credentials, v1/v2 policies and retained queues were not repurposed as
isolated-test identities.

## Production baseline and evidence boundaries

A read-only baseline and initial snapshot were recorded before the new physical
run. The baseline includes older production activity:

| Source | Rows |
| --- | ---: |
| v1 ingestion batches | 214 |
| v2 ingestion batches | 30,285 |
| v2 ingestion items | 11,276 |
| Existing v2 public sensor projection | 3,845 |
| Manual public observation projection | 0 |
| V3 feature batches/items | 0 / 0 |
| CPRAW uploads | 0 |
| V3 statistics batches/windows/status/events | 0 / 0 / 0 / 0 |

Both new V3 assignment-generation baselines were zero. An absent V3 control row
before a board registers is expected. Global public counts must not be treated
as zero or attributed to this release. Both cohorts had zero V3 source rows at
that initial snapshot and no new V3 public contribution. Subsequent isolation
checks scope new generations to
their actual `controlled_test` dataset, unlocated placement and batch identities;
they must not infer contamination from unrelated retained public rows.

The read-only collector retains original query responses privately and produces
only cohort/generation, boot digests, sequences, observed durations, uncertainty,
quality/loss/report counts, control/lease state and receipt-metadata comparisons.
Stored receipt metadata can be reconciled against the source rows and assignment;
this does not rehash an original frozen device request unless those exact bytes
are separately available. No identifiers, credentials or raw captures are
included in this document.

## Flash preservation and bounded NVS recovery

Complete Flash backups were preserved privately before changes. Partition-table
bytes remained identical and firmware updates were app-only. Protected device
data and the legacy queue partition were excluded from application flashing.

T-Energy initially had only 34 available NVS entries because an old MAC-statistics
cache occupied space. After explicit user authorization to delete that earlier
cache, recovery deleted exactly `scanstats/devs` (12,300 bytes). Official NVS
parser comparison verified that the target was gone, all other 29 keys retained
the same type, length and value digest, no keys were added and exactly one was
removed. Used entries changed from 596 to 206; available entries changed from
34 to 424. This was a targeted cache deletion, not an NVS reset or credential
rotation.

The old 4 MiB `cpqueue` was bit-identical to the pre-V3 baseline and full backup
at the preservation checkpoint. After the V3 tests, a read-only 4,194,304-byte
readback again matched both the pre-V3 queue and the corresponding full-backup
region byte-for-byte. The post-test comparison passed; the private comparison
report retains the digests without publishing queue contents or identifiers.

## Historical direct-HTTPS diagnostics

Waveshare's real capability-registration POST reached the production D1 service.
Its response path then encountered a TLS timeout/reset. No successful device
configuration ACK or production statistics window followed that attempt.

After the NVS space recovery, T-Energy's first production TLS attempt timed out
and stopped safely. No capability registration or statistics window was accepted
from that attempt.

These attempts preceded the user's transport correction and are not native
MQTT acceptance. The reviewed exact-request retries and explicit opt-in whole
SDK DNS cache recovery belong to the historical HTTPS diagnostic path. The
cache operation can affect other pending DNS queries and is not a per-host
eviction. It is not used as a substitute for the formal MQTT path.

## Bounded native MQTT device evidence

The formal app/USB configuration accepts production only as native MQTT/TLS to
the fixed broker with the system CA bundle; missing broker credentials fail
closed, with no production HTTPS fallback. Nonproduction HTTPS remains an
explicit diagnostic mode. Original frozen request bytes and receipt authority
are preserved across the transport change; a PUBACK alone is not custody.

Waveshare's first native MQTT run completed three statistics windows and three
status uploads. The device's strict receipt matcher accepted all six responses,
and the deliberate first-window retransmission returned the same receipt.
Complete window bodies measured 764/765/765 bytes; status bodies measured
452/454/453 bytes. Device completion reported three window ACKs, three status
ACKs, no storage fault and safe cleanup with storage/raw/network return codes
all zero. This is one bounded device-side run, not proof that both boards passed
concurrently or that the remote database has independently reconciled every row.

T-Energy's checkpoint stopped after one durably stored window with
`no_post=1`, zero volatile handoffs and a required restart. A later normal boot
reported exact historical recovery of that window and zero durable pending
records, without changing its original identity/body. The management-side HTTPS
configuration step then timed out; that run ended with zero new windows/status
and was not marked passed. That attempt established historical recovery rather
than a new normal collection pass; the later concurrent run is recorded below.

The subsequent Waveshare-normal/T-Energy-normal concurrent run passed its
device-side bounded checks:

| Device | New windows | New status records | Complete window-body bytes | Exact retry | Safe stop |
| --- | ---: | ---: | --- | --- | --- |
| Waveshare | 3 | 3 | 765 / 765 / 765 | Passed | Passed |
| T-Energy | 3 | 1 final status | 763 / 762 / 763 | Passed | Passed |

Waveshare reported zero candidate-event uploads and no storage fault; final
storage/raw/network cleanup return codes were all zero. Its status bodies
measured 454/454/453 bytes. T-Energy reported `passed=1`, zero request failures,
one retry attempt, zero frozen volatile handoffs and network-stop return code
zero. Its three windows retained 6257/6345/6236 SDK reports with zero reported
callback drops, processing drops or address-capacity overflows. These bounded
software counters do not establish complete over-the-air reception.

## Independent Cloudflare reconciliation

The current normal runs have exactly the expected committed rows:

| Device | Windows | Status rows | Batches | Candidate events | SDK reports across three windows |
| --- | ---: | ---: | ---: | ---: | ---: |
| Waveshare | 3 | 3 | 6 | 0 | 19,810 |
| T-Energy | 3 | 1 | 4 | 0 | 18,838 |

Applied ACKs, lease authority, actual boot scope, source rows and strict stored
receipt tuples matched independently. Every window was 60,000 ms with 5,000 ms bins;
source TTL matched its original policy. Callback/aggregation/overflow counts
were zero. Each board retained 59,999 ms coverage and quality mask 6 for its first
window, then 60,000 ms and mask 2 for the next two. Preserve these gap/uncertainty
flags; zero software-loss counters do not prove radio completeness.

For the normal runs, `original_request_bytes_rehashed:false`: this independent
audit checks stored authority/source/receipt metadata, rather than recomputing
every original frozen wire request. The device's strict request/receipt matcher
and exact-retry checks provide a separate layer of evidence.

The checkpoint has stronger byte-level evidence: its original 762-byte request
was recovered from the NVS snapshot, the record/CRC validation passed, and its
independent SHA-256 matched the original Cloudflare receipt's body digest. The
recorded receipt time follows the host-side NVS-snapshot capture time. That is
host collection-time sequencing evidence, not a server-signed reset or power-loss
instant. This acceptance covers a planned normal restart, not arbitrary power loss.

Both current assignments use MQTT with `dataset=controlled_test` and no assigned
public place. All their new V3 windows retain that scope, and the public
statistics query requires field data and a bound place. V3 ingestion does not
write the legacy projection tables. Thus this run's controlled V3 data is
excluded from public results. Existing V2 projections remain retained; the
per-node query covers all legacy generations, while the initial baseline was
global. A matched per-node legacy-count delta was not verified, so no claim is
made that all legacy/global projection counts stayed unchanged.

The separate post-test legacy-queue comparison and non-writing production probes
have passed.
No per-device identifiers, network names, credentials or raw observations are
published here; the original serial logs, checkpoint material and read-only
database evidence stay in ignored private storage.

## Bounded result and remaining work

The bounded native MQTT release, checkpoint/normal-restart recovery and concurrent
two-board acceptance passed within the evidence limits above. T-Energy's one
final status is intentional and differs from Waveshare's three-status cadence.

For this trial, source payload TTL is one hour from the conservative observation
cutoff, rather than from a later retry. Minimal receipt metadata follows
the current contract: `retain_until = max(source expiry, accept_until + 7 days)`.
Keep source expiry, acceptance deadline and receipt retention separate. Do not
delete trial sources early or change frozen TTLs to manufacture cleanup success;
observe the ordinary bounded retention path at the real deadline.

Temporary release administrator sessions were revoked by exact session-hash
selection. A direct read-only request with the former cookie returned 401;
accounts and device credentials were not modified by that cleanup.
Production cron execution and real-deadline retention cleanup, sustained radio
load, arbitrary power loss, long offline operation, storage endurance and field
calibration remain separate acceptance beyond this bounded run.

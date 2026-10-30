# Isolated v3 backend integration, 2026-10-30

Status: limited physical v3 trial passed across three windows and two successful
boots. External test ingress is stopped; the local service is draining private
sources under their original TTL before automatic shutdown.

The user authorized coordinated device/backend testing. This session owns the
backend and test tooling; the firmware session owns the board image and physical
evidence. No historical TF captures were uploaded.

## Test service and isolation

Cloudflare Wrangler authentication was expired, so no remote Worker or production
database was changed. The test backend runs local workerd through Miniflare with
all 15 migrations, independent persistent D1/R2 storage and separate synthetic and
physical-device registrations. A temporary Cloudflare Quick Tunnel exposes its
HTTPS listener to the board. This is a local integration service reached through
a tunnel, not a deployed Cloudflare Worker or a host translating device data.

`scripts/v3-integration-server.mjs` starts the restricted control/ingest/archive
entrypoint on loopback HTTPS. It has no general UI or synthetic cleanup route.
Only this test instance enables v3 and CPRAW gates. Private configuration and
storage live under ignored `data/v3-integration/`; credentials and device
bootstrap files are mode 0600. Do not copy them into this note or a commit.

The temporary hostname changes when the tunnel restarts. Recreate the private
profiles from the current server configuration and verify `/health` before
provisioning the board. The public endpoint uses normal public certificate
validation; the tunnel's loopback origin uses an isolated development certificate.

## Reproducible preflight

Use the isolated synthetic profile with `scripts/v3-device-integration.mjs
--config <private-profile> --phase exercise`. The real-device profile uses
`--phase prepare` only after the board registers capabilities; it never registers
or acknowledges on behalf of the board. `--phase verify` reads the existing
device acknowledgement without creating one.

The external HTTPS synthetic run passed 18 checks: capability registration and
retry, administrator assignment and retry, device config, synthetic application
and retry, feature/status custody and exact receipt retries, conflicting bytes
and wrong-node denial. This proves the synthetic client/server path only.

A newly generated 32-byte CPRAW header passed manifest, chunk, file commit,
commit retry and authorized exact-byte readback. It contained zero radio reports
and was kept separate from the physical-device registration. No real TF segment
was used, and this does not demonstrate autonomous board CPRAW upload.

## Physical trial parameters and remaining evidence

The agreed trial subset is passive 1M, `controlled_test`, 10-second windows,
1-second bins, at most 8 address/type identifiers, company IDs and Appearance,
all-worker report accounting, one item and 4096 bytes per request. Window budgets
are 10,000 examined reports and 65,536 canonical evidence bytes. The trial image
declares local raw unsupported; existing raw files are preserved.

The TF queue body budget is 49,152 bytes/12 items, with feature 32,768/8,
status 8,192/2 and control 8,192/2 reserves. Normal 12 physical slots occupy
73,728 bytes; recovery can require 221,184 bytes plus filesystem overhead, so
the firmware reserves a 262,144-byte journal pool. These are implementation
budgets supplied by the firmware session, not measured endurance or throughput.
The shared producer supports 16 identifiers, but the first physical trial is
limited to eight so an entire window fits the eight reserved feature slots and
can be synced before any network send. Component capacity is not the trial's
advertised capacity.

The physical acceptance checklist requires the actual board's capability registration,
verified policy digest, applied ACK, observed feature/status batches, unchanged
receipt on a deliberate retry, and queue release only after matching committed
receipts. Preserve separate evidence for reception losses, storage recovery,
lease expiry and rejected uploads. Existing limitations on retired-boot new
uploads and production resource/retention acceptance continue to apply.
The third attempt below closes the control/custody/retry checks for two windows;
queue reopen and cleanup have separate completion records.

## First physical attempt

The board itself registered one capability and fetched the administrator's
matching assignment. Its HTTPS operation for the applied ACK failed before it
obtained a complete response. A persisted read-only D1 snapshot showed one
capability, one assignment, zero applied/failed ACKs and zero feature/status
batches. The board ended this attempt without sending feature data. This is a
control-path partial result, not a successful capture/upload acceptance.

The firmware session is investigating TLS/internal-memory behavior after BLE
initialization, adding numeric stage/error/heap diagnostics and exact-byte
control retries. A new boot will receive a new assignment; the previous attempt
and private evidence remain intact. No host-generated device ACK is used.

## Second physical attempt

The second boot completed HTTPS registration, configuration retrieval and its
terminal ACK request. BLE initialization left insufficient internal memory for
the firmware resource gate, so the device committed a failed ACK with
`resource_exhausted`. The persisted snapshot showed two capabilities, two
assignments, zero applied ACKs, one failed ACK and zero feature/status batches.
This verifies a real device failure report and fail-closed behavior, not an
applied policy or successful observation upload. The firmware session continues
memory-allocation work before a new boot and assignment.

## Third physical attempt: two-window custody passed

Firmware 0.2.2 sent its own capability, obtained assignment generation 3 and
committed an applied ACK over HTTPS. Two BLE windows then produced 16 feature
items and two status items. A persisted read-only backend snapshot confirmed
exactly 18 batches/items, feature sequences 1–16 and status sequences 1–2, all
under generation 3. All 18 receipt metadata checks matched the stored body hash,
boot, batch, stream and sequence. The firmware reported that its deliberate
first-feature retry returned the same receipt; no duplicate row was created.

The windows saw 1,198 and 1,248 SDK reports. The retained eight identifiers
accounted for 534 and 480 reports; the address-table overflow counters were
664 and 768. Callback drops were reported as zero. Evidence-budget totals were
13,261 and 13,275 bytes, including the array wrapper and separators. Backend
accounting matched these values. These are bounded SDK observations with
explicit overflow, not radio-complete capture or physical-device counts.

The isolated backend's two public projection tables remained empty, and this
device had no v1/v2 batches. Data stayed in private v3 tables. Previous control
attempts remained as three capabilities/assignments, one applied ACK and one
failed ACK; the first attempt had no terminal ACK. Detailed hash/sequence
snapshots are kept in the ignored private integration reports, not this note.

The firmware reported a 90,035-byte internal-memory minimum, 6,436-byte stack
minimum and 331,776 accounted storage-write bytes for this run. These are the
firmware session's trial diagnostics, not sustained-capacity or endurance tests.

## Fourth attempt: queue recovery, real timeout retry and safe stop

Firmware 0.2.4 reopened the TF queue with feature/status pending counts zero,
zero retired entries and zero corrupt entries. It registered a new boot and
committed assignment generation 4. Its one window saw 1,227 SDK reports, retained
319 reports across eight identifiers and reported 908 address-table overflow
reports, with callback drops zero. The evidence-budget total was 13,256 bytes.

The first feature request actually timed out waiting for response headers. The
board retried the original queued bytes and received a committed receipt, then
its deliberate exact repeat matched the same receipt. Backend verification
found only eight feature batches/items and one status batch/item for generation
4, with sequences 1–8 and 1. All nine receipt metadata checks matched. Together
with generation 3 this is 24 feature and three status records, with no duplicate
rows from the timeout/retry. Both public projection tables remained empty.

The firmware reported nine matched durable ACKs, final feature/status pending
counts zero, zero queue I/O errors, successful network stop and TF unmount, and
its final safe marker. Reported minima were 88,343 internal-memory bytes and
6,356 stack bytes; accounted storage writes were 165,888 bytes. These observations
cover this small trial only. They do not establish endurance, full-radio capture,
cross-boot draining of unacknowledged records or production service capacity.

## Cleanup and service shutdown

After the final board stop, the owned Quick Tunnel was terminated. The backend
was restarted in immediate drain mode. A persisted read-only snapshot after
restart retained four capabilities/assignments, two applied ACKs, one failed
ACK, 24 feature records and three status records. No host issued a device ACK.

The restarted service returns `503` with `ready:false, draining:true` and rejects
new API traffic. The explicit local synthetic-archive retirement removed only
the generated CPRAW test source; it preserved its minimal receipt and did not
touch a real-device archive or TF card. No historical capture was uploaded.

Internal maintenance runs every 60 seconds using the real clock. Private v3
sources retain their original one-hour deadlines; the last source expires at
**2026-10-30 14:12:20 Asia/Shanghai**. The service stays in drain until sources
are cleared, then exits. Minimal receipts and the redacted acceptance reports
remain separate. A running host is required for on-time physical cleanup; the
launcher also performs maintenance on startup and records pending cleanup on
interrupted shutdown. Live-row deletion is not a claim of backup erasure.

Private operational state is `maintenance-status.json` / `shutdown-status.json`
under the ignored integration directory. The reproducible final invocation is
`node scripts/v3-integration-server.mjs --shutdown-after-ms 1
--retire-synthetic-archives`. No production Worker, database, gate or deployment
was changed.

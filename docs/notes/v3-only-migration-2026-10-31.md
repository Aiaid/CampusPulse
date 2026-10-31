# V3-only device protocol migration — 2026-10-31

Status: **V3-only source implementation and local integrated verification
complete.** Publication and production deployment must be established by the
actual [Check and deploy workflow](https://github.com/Aiaid/CampusPulse/actions/workflows/ci.yml)
run for the pushed main commit; the local results below are not deployment
confirmation. See the [completed roadmap entry](../design/ROADMAP.md).
This migration includes no new flash or physical-device run.

The source migration is committed as [`7525ab7`](https://github.com/Aiaid/CampusPulse/commit/7525ab7).
The [main release workflow](https://github.com/Aiaid/CampusPulse/actions/workflows/ci.yml?query=branch%3Amain) records publication and deployed smoke-check results.

## Scope and retained evidence

The user requested a complete migration to V3 and explicitly required all
historical collection records to remain intact. This retires obsolete V1/V2
device protocol and application code, not historical observations or custody.

- Existing D1 collection rows, receipts, policies, placements and private R2
  objects remain preserved. Existing migrations remain in order for fresh and
  upgraded databases; code retirement introduces no destructive data migration.
- The removed V1/V2 retention job is no longer scheduled. V3 statistics,
  experimental V3 feature and separately gated CPRAW cleanup keep their own
  contracts; stopping old retention does not disable current V3 cleanup.
- Manual observations, device identities, credentials, administrator accounts,
  Passkeys, settings and audit records remain independent application data.
- Private captures, TF files, backups, ignored build output, saved NVS and old
  Flash queues are not deleted, converted or automatically replayed. Read-only
  compatibility with older NVS credential layouts preserves saved settings;
  it is not an old device-protocol implementation.

A read-only full production D1 export was preserved privately before release:
42,373,601 bytes, file mode 0600, with a private SHA-256 manifest. Its contents,
credentials, database identifiers and private manifest values are not published.
This verifies that an export was retained; it is not an R2-object backup or a
restoration drill. Existing private R2 objects remain intact.

The [historical metadata export helper](../../scripts/dump-ingestion.mjs) now
reads retained D1 metadata only. It does not call the retired live research HTTP
routes, download raw payloads or claim to rehash original request bytes.

Preserving historical rows does not imply that a retired protocol still has a
current ingestion endpoint or a current administrator reader. In particular,
old sensor rows do not become V3 measurements or fill gaps in V3 public history.

## Current server and map contract

The current source routes device capabilities, immutable assignments,
acknowledgements, renewable capture leases and small statistics through V3.
The default production producer remains `cp-v3-small/1`; `unclassified-v1`
leaves identifier keys in `unknown`, and `estimated_total` remains null.
Cloud raw and per-address uploads are off for this selected profile. Local TF
research recording and separately gated archive experiments retain their own
contracts. Identifier keys are not measured people or vehicles.

The device transport is native MQTT/TLS → Hangzhou EMQX → authenticated
Cloudflare gateway → `MqttDeviceApi`. CPV3 framing is mandatory. Unframed legacy
JSON, malformed frames and retired operations are rejected. The existing
`cp/v1/<namespace>/<boot>/req/ingest/<rpc>` topic namespace stays stable so the
migration does not rewrite deployed hardware/broker ACLs; its name does not
permit V1/V2 payloads. Exact application receipts, frozen bytes, policy scope
and capture authority govern reclamation; broker PUBACK alone is insufficient.

The authenticated V3 HTTPS endpoints remain the API/logical operation contracts
used by the private service binding and independent API checks. Selecting native
MQTT for production does not retire those handlers or permit caller-selected
internal identity headers. See the [MQTT contract](../specs/device-v3-mqtt.md),
[control contract](../specs/device-v3-control.md) and
[small-statistics contract](../specs/v3-small-statistics.md).

Old V1/V2 device upload/config/control routes return 404. Independent business
APIs under `/api/v1`, including public places, manual observations and
administrator authentication/identity operations, keep their own contracts.
Their URL version is separate from the retired device-wire versions.

Public sensor history reads eligible V3 statistics with original `policy_id`
and `assignment_generation`, source timestamps, clock uncertainty and quality.
It checks actual capability/assignment/applied-ACK/lease authority and does not
fall back to V1/V2 projections or substitute receipt time for measurement time.
Manual observations and synthetic simulation remain independent. Existing maps,
search, layers, actor illustration, historical screenshots and provenance are
preserved. The README labels earlier screenshots as historical where their
management interface predates this migration.

V3 administrator configuration and diagnostics use actual capabilities,
validated immutable policy assignments, actual ACKs and stored V3 evidence.
A device without a V3 capability report is unavailable for that assignment
workflow rather than receiving an invented profile. Source/API implementation,
browser acceptance and device application are separate evidence.

## Firmware boundary

Active network applications are [Waveshare V3](../../firmware/waveshare-v3/README.md)
and [T-Energy-S3 V3](../../firmware/t-energy-v3-trial/README.md), using independent
`cp_v3_*` collection, statistics, temporal, queue and transport components.
They wait for physical USB setup and retain their bounded runtime limits. USB
settings delivery, validated policy assignment, actual device ACK and durable
upload are distinct states.

The old shared network/provisioning/runtime/pipeline/journal application code
and its C3, earlier T-Energy and ePaper collector entries are retired. The
local prototype MQTT relay is retired; its historical README and Git history
retain provenance. The authenticated EMQX-to-Cloudflare gateway remains active.

Board BSP, fonts, notices, general BLE/vehicle algorithms and source provenance
remain. The independent [offline raw recorder](../../firmware/waveshare-raw/README.md),
CPRAW formats and V3 local-TF dependencies remain. `cp_core` now retains neutral
board/display types; `cp_usb` retains framing required by the offline recorder.
Their retention does not re-enable the old supervisor or setup/upload chain.
There is no current AI Passport C3 V3 application claim.

“V2” in Waveshare ESP32-S3-ePaper-1.54 V2 is a hardware revision, not a device-wire
protocol version. Likewise, CPRAW versions, USB export formats and saved NVS
layout compatibility are separate from V1/V2 collection-protocol retirement.
Protected Flash and credentials must still be preserved before any future
explicitly authorized device write; source removal does not erase a device.

## Verification and historical provenance

Local integrated verification completed for the V3-only source:

- Repository suite: 89 test files / 1,171 tests passed; production build and
  TypeScript checks passed.
- Native MQTT gateway: 111 Node tests and its TypeScript check passed.
- Independent targeted review: 173 backend tests and 70 gateway tests passed.
  The old public cache-key issue was closed, and general security coverage was
  retained when retiring protocol-specific tests. These targeted checks overlap
  other suites and are not additional unique-test totals.
- Administrator browser acceptance passed in actual Chromium, including the
  complete workflow, and WebKit/fallback and MQTT identity-pool paths. The
  administrator core has 145 passing targeted tests. Configuration uses actual
  capabilities, immutable validated assignments, device ACK/evidence and V3 USB
  startup rather than synthetic device state.
- Both active S3 applications have fresh builds and host-verification evidence.
  The private full D1 export's existence, 42,373,601-byte size and 0600 mode were
  checked separately from application tests.

These are local software/build and read-only preservation checks. The actual
[Check and deploy main workflow](https://github.com/Aiaid/CampusPulse/actions/workflows/ci.yml)
for the pushed commit establishes hosted checks and deployment; this note does
not pre-claim that the new version is deployed. Build success does not establish
radio completeness, actual collection, current-image installation, battery
behavior, endurance or arbitrary-power-loss recovery. No new flash or physical
acceptance was performed for this migration. No new image hash is represented
here as a physically tested binary.

The preceding bounded production evidence was recorded in commit
[`69a0fee`](https://github.com/Aiaid/CampusPulse/commit/69a0fee8dde227e1123c3defd21481569c8b1760)
and the [production release record](v3-production-release-2026-10-31.md).
It covers the actual tested two-board native MQTT windows/statuses, exact
receipts, planned-restart checkpoint recovery and protected legacy-queue
preservation within that record's scope. It does not transfer physical
acceptance to the newly built post-retirement images. Sustained/offline,
saturation, arbitrary-power-loss, battery and field-calibration work remains
open in the [roadmap](../design/ROADMAP.md).

[Device v2](../specs/device-v2.md), [ingest v1](../specs/ingest-v1.md) and
[old provisioning](../specs/local-provisioning-v2.md) remain as explicitly retired
documents. Their former source/test paths can be resolved against the
[pre-retirement source snapshot](https://github.com/Aiaid/CampusPulse/tree/69a0fee8dde227e1123c3defd21481569c8b1760).
Retain their historical results and source boundaries rather than treating them
as current commands or deleting the evidence.

No images were added, edited or recaptured by this documentation update.

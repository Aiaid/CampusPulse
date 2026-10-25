# Administrator device diagnostics and uploaded evidence

Status: implemented locally, 2026-10-25. Deployment and physical-device acceptance
are independent of the checks below. This adds no firmware fields or protocol
migration. All example and browser acceptance records are synthetic.

## Evidence presented

The device page separates three clocks: the latest v2 control contact, latest
committed ingestion receipt, and latest `node_status` sample. It shows their
server receipt times and ages, boot IDs, the status measurement UTC/monotonic
clock and uncertainty, plus the policy referenced by that sample. A recent
control request does not refresh an older status sample. A status from another
control boot is labeled as prior-boot evidence; an old measurement received
recently is labeled delayed. Missing UTC stays unknown. The page uses the
server-provided stale threshold and a ticking age without silently polling.
Refresh obtains new records.

Scanning/raw state, heap, local storage and loss counters are device declarations
at the displayed sample, not continuous measurements or hardware verification.
Raw OFF is independent of window/address-summary upload. An older firmware's
raw-memory pause declaration while the sample's raw policy is OFF is retained
and explicitly identified as inconsistent, rather than rewritten by the UI.
Maximum contiguous heap, minimum heap, TLS stages and task stack diagnostics
are not in the current wire status; inspect authorized USB diagnostics for them.

All four queues show reported pending/capacity, without converting absent fields
to zero. Pending includes data not yet uploaded and possibly data committed on
the server whose ACK has not yet been processed by the device. A cloud durable
receipt does not prove local ACK processing or reclamation. Loss counters have
separate meanings and are not summed into an invented total; counts from distinct
boots must not be subtracted directly. Board/firmware declarations remain separate
from independent hardware verification.

## Authenticated uploaded-batch explorer

Two read-only endpoints are available after the existing initialized-admin
session check (the bootstrap-only session and bearer device/research credentials
cannot use them):

- `GET /api/v1/admin/devices/{id}/batches`: v1/v2 durable receipt metadata,
  optional `stream`, `limit` 1–50 (default 20), opaque `before` keyset cursor up to
  256 characters; receipt timestamp and batch ID determine the stable ordering.
- `GET /api/v1/admin/devices/{id}/batches/{batchId}`: one device-bound receipt,
  up to 128 retained D1 items, and at most one original private R2 object.

Receipt metadata includes protocol, stream, receipt ID, SHA-256, server received
time, boot, firmware, placement/config/dataset, accepted sequence range and count,
and retention deadline. The detail view adds the retained projection's measured
UTC range and exact body size only when an object was actually read. A receipt
range can include intentionally skipped raw sequence numbers; it does not by
itself establish lost reports. No endpoint can retrieve device-local unuploaded
content.

`ble_windows`, `node_status` and v2 `address_summaries` store validated,
normalized D1 JSON. They do **not** retain original request whitespace, numeric
spelling or full request bytes. v1 raw has no D1 item projection; v2 raw keeps
sequence/window bookkeeping. Both raw protocols can archive exact request bytes
in private R2. List requests never read or enumerate bucket objects. Expired
payloads are hidden immediately even if retention cleanup has not run.

A selected archive is bounded by the ingestion cap (65,536 bytes), checked
against the receipt SHA-256, decoded as UTF-8 JSON and inspected for credential
fields before exposing its directly decoded text. The UI never reconstructs
wire bytes from a projection. Missing, expired, oversized, malformed, corrupted
and sensitive-field archives have distinct unavailable states. Projection keys
associated with credentials are removed defensively. Network passwords,
enterprise identities and device credentials are not intentionally stored in
these ingestion payloads or serialized by the new endpoints. Private bucket keys
are not returned. API responses are no-store, same-origin/session protected and
contain no automatic registration, credential rotation, publication or writes.

BLE identifiers and advertisement content are private observations, not exact
people counts. The batch detail explicitly labels field/demo/controlled-test
provenance. It does not expose private evidence through public map APIs or grant
admin cookies access to the separate research-token endpoints.

## Verification

- `npx vitest run tests/admin-device-diagnostics.test.ts tests/device-diagnostics-display.test.ts tests/device-v2-admin.test.ts tests/admin.test.ts tests/openapi.test.ts`
  covers authentication/origin, pagination ties and input bounds, D1 provenance,
  selected R2 exact-byte integrity, immediate expiry, missing/oversized archives,
  credential-key redaction, and old-boot/stale/delayed status classification.
- `npm run build` checks TypeScript and builds the production frontend.
- `node scripts/device-diagnostics-browser-smoke.mjs` starts its own ephemeral
  workerd with real D1/R2 and production frontend assets, signs in through the
  actual admin UI, uploads synthetic status/windows/address/raw fixtures through
  ingestion APIs, and checks old-boot display, memory reasons, unknown counters,
  selected summary/original text and desktop/mobile layout. It does not touch
  hardware, production credentials or existing user browser sessions.

No external code or images were imported for this change. Existing repository
components, ingestion fixtures and test helpers are reused in place.

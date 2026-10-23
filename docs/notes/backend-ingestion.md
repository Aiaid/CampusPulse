# Ingestion server implementation and local acceptance

Date: 2026-10-23. Status: **implemented and locally verified; production
provisioning/deployment is in progress; firmware/hardware validation is pending**.
Earlier deployment records cover the earlier web/manual API only.

## Implemented API

The same-origin `/docs` and `/openapi.json` describe nine operations: six existing
web/manual operations plus these device/research routes.

| Operation | Credential | Behavior |
| --- | --- | --- |
| `POST /api/v1/ingest` | Registered per-node bearer token | One immutable window/raw/status batch; exact-byte SHA-256 header; all-or-nothing durable ACK |
| `GET /api/v1/device/config` | Same node credential | Registered policy, server limits, expiry and retention; optional `capture_config_id` for an older queued policy |
| `GET /api/v1/research/batches/:id?node_id=...` | Separate `RESEARCH_TOKEN` | Private original raw batch plus on-demand versioned AD parsing; no object URL or key |

Device credentials are SHA-256 digests in `device_nodes`, with enable/disable and
rotation independent of the operator and researcher secrets. Use random tokens
with at least 128 bits of entropy; accepted wire syntax is 16–256 printable ASCII
characters. Tokens cannot provision nodes, select another dataset, or enable MAC
capture. Registry rows define immutable node/placement/dataset/config scope.
`GET /device/config` without an ID chooses greatest `accept_until_ms`, then ID;
queued batches should request their exact ID. There is no remote configuration
activation handshake yet.

Upload bytes are limited to 64 KiB/128 items and any smaller registered limits.
Status batches contain exactly one item. Duplicate decoded JSON keys, invalid
UTF-8, unknown structural keys, unsafe integers, conflicting count equations,
wrong raw identity policy and malformed transport hex are rejected before storage.
Only the reproducible `report-rate-v1` index is accepted; calibrated indices await
an algorithm registry. Config validation freezes deterministic sampled raw mode
as `seq_mod_n_eq_0`, and passive scans cannot submit scan responses.
Status/quality labels use bounded lowercase identifier syntax; their full enum
vocabulary is not yet frozen. Errors never reflect unrecognized caller key names.

For `X-Body-SHA256`, hash the exact UTF-8 bytes sent, including whitespace and
trailing newline. Swagger does not calculate this header. Generate a frozen body
file and calculate its digest externally for upload testing; browser reformatting
changes the hash. An HTTP 200 is useful to firmware only after every ACK identity,
stream, hash, count and durability field matches the frozen local batch.

D1 atomically commits each receipt and its window/status rows. A SQL trigger
excludes inclusive overlapping sequence intervals per node/boot/stream, including
internal holes. Same node/batch ID with different bytes returns 409. Successful
identical retries return only the original ACK, including after policy expiry or
raw retention deletion. A maximum sequence is never treated as a contiguous ACK.

Raw uploads conditionally create the private R2 object with its SHA-256 checksum,
then commit the D1 index/receipt. Existing objects are rehashed on retry. R2 or D1
failure returns no success ACK. Unreferenced objects can remain after D1 rejection
or expiry during archival; they are not research-queryable. **Automatic orphan
cleanup is deliberately disabled** until a lease/tombstone design protects
in-flight commits. Operators must account for these objects in capacity audits.

The parser preserves repeated/unknown AD elements, name bytes, little-endian
UUIDs and company IDs, flags, power and appearance. Malformed air payloads remain
archived; malformed interpretations are marked. Classification stays `unknown`
with ruleset `unclassified-v1`; no vehicle detection accuracy is claimed.

## Public projection and placement changes

Summary/history keep manual observations separate and add sensor results. Public
sensor windows require dataset `field`, known UTC, known uncertainty ≤30 seconds,
UTC no later than server time, and an entire interval including uncertainty inside
the original placement lifetime. Unknown quality labels and clock/time faults are
withheld from the public projection; this first slice permits only
`partial_window`, `unique_table_overflow`, `aggregation_drops`, `raw_drops`, and
`raw_pressure_pause` (or an empty flag list). These are device claims, not an
independently verified clock or RF-quality measurement.

A sensor window is fresh until `utc_ms - uncertainty_ms + 90000`; older eligible
windows remain visibly stale within the last 24 hours. Unknown UTC, transit
placements with no place, controlled tests and demo data never become current
field activity merely because they arrived now. No identifier sets, payloads,
raw keys, per-address data, or people-count interpretation enter public results.
History caps manual and sensor arrays independently at 200 with separate truncation
flags; it does not add unique counts across windows or nodes. Registry presence
does not establish measured sensor coverage; the existing place coverage field
remains `unconfigured` pending physical acceptance.

For a mobile placement change, insert a one-time immutable closure first:

```sql
INSERT INTO placement_closures
  (placement_id,node_id,valid_until_ms,recorded_at)
VALUES ('old-placement','node-id',1792742400000,'2026-10-23T08:00:00.000Z');
```

Use the actual agreed split boundary, then create the next placement/config.
The database rejects overlapping placements for one node and any reopening.
Delayed old data keeps the old placement and remains stored, while windows outside
its effective lifetime are withheld publicly. Firmware still must split windows
at changes; the server cannot infer the physical move or GPS location.

## Provisioning and local operation

Use Node 24, `npm ci`, `npm run db:migrate`, and ignored `.dev.vars` for the
operator/research secrets. Default local Wrangler binds emulated D1 and R2.
The committed example config and every automated test use synthetic data.
No real devices or credentials are seeded by migrations.

Prepare a private config JSON matching the strict fixture shape, and a placement
JSON with exactly `id`, `node_id`, `place_id` (nullable), `valid_from_ms`, and
`valid_until_ms` (nullable). IDs must match the config; fixed `place_id` must already
exist. Save the new random device token in an owner-only regular file without a
trailing newline. Then generate a reviewed, ignored SQL import:

```sh
node --experimental-strip-types scripts/provision-device.mjs \
  --config /private/path/config.json --placement /private/path/placement.json \
  --token-file /private/path/device-token --output .wrangler/provision-device.sql
npx wrangler d1 execute campuspulse --local --file .wrangler/provision-device.sql
```

The SQL contains only a token digest and uses owner-only output permissions. It is
new-node provisioning, not credential rotation or an idempotent rerun command.
It has no explicit BEGIN/COMMIT (unsupported by D1); when using a D1 binding,
`buildProvisioningStatements` can be executed with `DB.batch` atomically.
A failed CLI import must be reconciled against registry rows before another run;
do not blindly replace immutable policy. No admin enrollment endpoint is exposed.

Production needs reviewed D1 migrations, provisioned device registries, a private
R2 bucket with public access disabled, its `CLOUDFLARE_R2_RAW_BUCKET` Actions
variable, and an independent Worker `RESEARCH_TOKEN` secret. Production deployment now fails before publishing if the private bucket variable
is absent, and the deployment smoke requires `raw_storage: configured`.
An API-only test environment may still omit R2; raw requests then fail closed
with 503 while window/status routes remain available. Do not enable broad bucket
lifecycle deletion that removes raw evidence sooner than its registered policy.
Production resource creation and online verification must be recorded separately below.

A 15-minute scheduled handler deletes bounded pages of committed expired raw
objects and window/status rows. Raw default retention is 24 hours and aggregate
retention 7 days. Research reads deny expired raw data immediately, even if a
cleanup backlog exists. Receipts retain minimal hash/range/ID metadata until at
least configuration deadline plus seven days and all referenced data expiry.
Deleting receipts requires their records and raw reference to be gone. Cleanup
errors surface through the Worker scheduled invocation; there is no alerting
integration or orphan collector yet.

## Acceptance evidence and remaining work

Run:

```sh
npm test
npm run build
node scripts/ingest-runtime-smoke.mjs
# With local Worker 8791 and ignored .dev.vars OPERATOR_TOKEN configured:
SMOKE_URL=http://127.0.0.1:8791 node scripts/docs-browser-smoke.mjs
```

The runtime verifier uses the installed Wrangler dependency graph (Miniflare and
esbuild), ephemeral local storage and synthetic tokens only. It verifies real
workerd D1/R2: migrations, plain provisioning SQL, three streams, concurrent exact
retries, original durable receipts, 409 overlap rejection, private raw parsing,
demo exclusion, and a negotiated 32-window atomic transaction. Unit/integration
checks additionally inject R2/D1 failures, verify no false ACK, retain ACKs after
cleanup, reject invalid credentials/policies, and validate strict parsing.

Browser acceptance checks the nine-operation Swagger UI, protected GET failures,
operator creation/cancellation, no authorization leakage to public reads and no
credential persistence after refresh. It uses only an isolated local database;
this is backend docs regression, not renewed frontend field-flow acceptance.

Not established: cloud provisioning/deployment of this slice, firmware encoder or
ACK reclamation, sustained throughput/quotas, measured radio completeness, device
clock trust, battery/storage acceptance, vehicle classification, research account
roles, rate limiting or alert delivery. No old backend implementation was copied.

Implementation references: Cloudflare's [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
and [R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations).

## Production acceptance workflow

The explicit `RUN_INGEST_ONLINE_SMOKE=1` guard and allowlisted HTTPS target protect
`scripts/ingest-online-smoke.mjs`. Its private mode-600 ops file contains the
registered demo node/config/placement and independent device/research credentials;
none are printed. The verifier checks all three streams, exact ACK identities and
bytes, duplicate/conflict/overlap responses, authentication/validation negatives,
private research parsing, and public field snapshots before/after demo writes.
It writes a sanitized local report; a rejected raw overlap may leave one known
unreferenced object. It does not assert hardware or radio acceptance.

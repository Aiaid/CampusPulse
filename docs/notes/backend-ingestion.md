# Ingestion server implementation and local acceptance

Date: 2026-10-23. Status: **deployed on Cloudflare and verified with isolated
synthetic online uploads; firmware/hardware validation is pending**.
The cloud acceptance section below covers this ingestion server. Earlier
web/manual deployment records are historical and do not substitute for it.

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
With Admin v1, `GET /device/config` without an ID selects the explicitly assigned
desired version. Legacy nodes without an assignment still choose greatest
`accept_until_ms`, then ID; queued batches should request their exact ID.
The additive `POST /device/config/ack` records an authenticated device application
report. Firmware polling/application and physical validation remain pending;
see [Admin v1](../specs/admin-v1.md). This supersedes the original no-handshake
limitation; earlier deployment evidence below does not cover the new endpoints.

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
do not blindly replace published historical policy. The separate authenticated
[Admin v1](../specs/admin-v1.md) now supports enrollment, credential rotation,
editable capture drafts and publication without manual SQL imports. The original
script remains available for controlled provisioning.

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

Not established: physical-node provisioning, firmware encoder or
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

## Cloudflare production acceptance — 2026-10-23

Backend-only implementation commit: `6f7775af2c71efa36e4a5a38a9e33629de1b387b`.
[CI/CD run 39921619389](https://github.com/Aiaid/CampusPulse/actions/runs/39921619389)
passed checks and deployment, including 66 tests, build, real local workerd D1/R2,
frontend browser regression and nine-operation Swagger UI browser checks.
The published frontend and CSS/JS hashes matched the exact committed release
snapshot; concurrent Pixi/actor changes were excluded. Four unchanged release
PNGs were metadata-checked without exposing private values; no identifying
embedded metadata was found.

Initial accepted Worker version: `8cfe8cf0-53b9-4876-9d7c-a1f09dd49ddf`, 100% traffic.
The additive `0002_ingestion.sql` migration is applied to the existing production
D1. `campuspulse-raw` is R2 Standard with APAC location hint, public r2.dev disabled,
no bucket custom domains and no object-expiration rule. The default seven-day
incomplete multipart abort rule is separate from evidence retention. Worker
`RAW_BUCKET` and the 15-minute cleanup schedule are configured; actual 24-hour
expiry execution has not been observed yet.

The owner enabled R2 and explicitly approved an independent `RESEARCH_TOKEN` and
a demo-only node credential. Local recovery material is mode 0600 under ignored
`.wrangler/ops/`; no credential was committed or printed. Existing operator
credentials were preserved. No physical device is registered by this test.

Online acceptance used [pulse.anend.net](https://pulse.anend.net), with:

| Check | Observed result |
| --- | --- |
| Health/config | 200; ingestion implemented, raw storage configured, demo policy only |
| Window/raw/status upload | One committed batch/record each; exact hash/identity/count/durability verified |
| Identical frozen retries | Same original receipt IDs and receive times; no duplicate D1 batches |
| Changed bytes / overlapping sequence range | 409 batch_conflict / seq_range_overlap |
| Missing auth / other node / field escalation | 401 / 403 / 422 |
| Wrong body hash / inconsistent hex length | 400 / 422 |
| Research read | 200 only with independent researcher credential; original body hash and versioned parsing matched |
| Public field projection | Before/after unchanged: no sensor windows or manual records from the demo |
| Cross-role access | Nine checks passed; device/research/operator scopes stayed separate, original operator still authenticates |
| Post-test disable | Synthetic node disabled in D1; its former credential returns 401 |

D1 reconciled exactly three demo batches, one window row and one status row. The
raw-overlap rejection intentionally exercised the R2-before-D1 failure boundary
and may leave one small synthetic unreferenced object. It is not a success receipt
and automatic orphan deletion remains disabled. Synthetic committed evidence
follows the configured retention policy. Raw test addresses/names are fixture
content, not captured radio observations.

`/docs` rendered all nine operations in a real browser; `/openapi.json` returned
OpenAPI 3.1. The workers.dev origin passed the hosted deployment smoke. One direct
request to workers.dev from this Mac reset before TLS establishment, whereas
the custom domain passed the full API acceptance. That single network sample
does not establish a durable availability rate or a Worker API failure.

The sanitized local evidence files are `.wrangler/ops/ingestion-smoke-result.json`,
`auth-isolation-result.json`, `ingestion-public-result.json`,
`ingestion-cleanup-result.json` and `ingestion-deployment.json`. They contain no
credentials or raw advertisement content. The two independent secrets remain
separate; real firmware devices require their own scoped enrollment.

# D1 usage and public-read optimization

Date: 2026-10-29, Asia/Shanghai. This change optimizes v2 reads and index
maintenance without changing capture policies, device firmware, frozen upload
bodies, acknowledgements, or configured retention. The user permits discarding
v1 observations; public sensor projection now reads v2 only. Legacy tables and
ingestion helpers are not migrated into v2 or used by that projection.

## Failure and retained evidence

The production 24-hour investigation found about 1.8 billion D1 rows read for
about 18,300 Worker requests. Most of the spike was the old administrative
whole-history UNION join, separately fixed by `14d2634` and deployed at
2026-10-29 12:09:53. A caught HTTP 503 / `storage_timeout` still has Worker
outcome `ok`; zero runtime exceptions do not establish an error-free API.

The remaining public-window query read 54,729 rows to return 201 records; its
receipt fallback read 49,033 rows to return one. The expiry-index plan visited
retained address summaries before filtering the place/window stream. The
`received_at` column is server receipt time; `utc_ms` is source observation time.
They must not be interchanged when handling delayed uploads.

## Query and server cache behavior

Each placement now contributes at most 201 eligible, indexed v2 windows before
the existing global time/node/sequence ordering and limit. The fallback chooses
one eligible receipt per placement before its global winner. Quality, expiry,
closure, unknown-clock, purpose and cross-stream provenance checks remain.
Large local fixtures verify matching global results with 30,000 unrelated
private rows, multiple placements and tied timestamps.

The Worker Cache API caches only cookie-independent, successful public JSON GETs:

| Route | Server TTL |
| --- | ---: |
| Place summary and public settings | 10 seconds |
| Place history, separately per allowed range | 30 seconds |
| Place catalog | 60 seconds |

`X-CampusPulse-Cache` reports `HIT`, `MISS`, or `BYPASS`. A hit returns before
calling D1. Browser responses remain `Cache-Control: no-store`; this is a
server-side cache, not browser persistence. Snapshot `as_of`, `from` and `to`
retain their real query time. Manual refresh and successful manual-write
refresh send `Cache-Control: no-cache`, bypassing the server cache. Other clients
converge at the short TTL. Authorization, private/admin/device/research paths,
mutations, invalid/unknown query parameters, errors, and personalized response
headers are excluded. Cache failures fall back to the database. Cache is local
to a Cloudflare location; simultaneous cold misses are not globally collapsed.

This is bounded snapshot caching, not a persistent incremental materialization.
A miss still reconstructs the requested bounded range using indexes. A future
incremental materialization must account for receipt-time backfill, manual
cancellation, placement changes and retention, not only maximum observation time.

## Polling

Visible sessions read summaries every 30 seconds, history every two minutes and
the catalog every five minutes, scheduled after completion. Hidden pages stop
scheduled network reads; return-to-page events coalesce. Requests have bounded
timeouts, do not overlap, and a confirmed manual write queues one forced fresh
read if it races an older read. The record form shares matching map/catalog
reads and preserves range selection, history and the replay cursor.

## Write amplification and safe deployment

Migration 0009 adds narrow public-window indexes and a node/batch/sequence index
for private reads and retention foreign-key probes. Status, placement-window
and raw-object expiry indexes become partial, while prefix-redundant receive
indexes are removed. The overlap index orders interval ends first for advancing
uploads without changing inclusive overlap rejection or out-of-order backfill.

The primary/identity uniqueness, parent provenance UNIQUE, budget tombstones,
per-item consistency and budget triggers, and transactional assertions remain.
No v2 row is rewritten or deleted by either migration. Existing configured
retention still applies; this is not indefinite retention.

Migration 0010 drops the redundant window index only after the updated Worker
has removed the old explicit index hint. Initial production rollout therefore
applies 0009, deploys/verifies the new Worker, then applies 0010. Do not run both
initial migrations before updating that old Worker.

## Verification

`node scripts/d1-usage-smoke.mjs` runs identical validated synthetic batches on
real ephemeral workerd/D1 with the pre-0009 and optimized schemas. Seed and
migration costs are excluded from ingestion measurements.

| 40 windows / 16 addresses / raw off | Before | After |
| --- | ---: | ---: |
| D1 rows read by commit transactions | 17,341 | 8,680 |
| D1 rows written by commit transactions | 8,480 | 6,080 |
| Additional writes for exact retries | 0 | 0 |

Measured writes decrease 28.30% for this particular synthetic workload. It is
not a universal fleet rate. The test compares complete v2 item/receipt/budget
snapshots across migration, checks private item values, exact retry ACKs,
atomic over-budget rollback and foreign keys. Dedicated tests also preserve
out-of-order intervals and inclusive endpoint collision rejection.

Production rollout and post-deployment measurements are pending; append actual
times, read counts and cache-hit evidence only after verification.

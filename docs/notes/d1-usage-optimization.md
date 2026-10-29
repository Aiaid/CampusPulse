# D1 usage and public-read optimization

Date: 2026-10-29, Asia/Shanghai. This change optimizes v2 reads and index
maintenance without changing capture policies, device firmware, frozen upload
bodies, acknowledgements, or configured retention. The user permits discarding
v1 observations; public sensor projection now reads v2 only. Legacy tables and
ingestion helpers are not migrated into v2 or used by that projection.

> Status update: this note preserves the first optimization's accepted results.
> The read path and the former incremental-cache limitation below are now
> superseded by the deployed [backend incremental cache](backend-incremental-cache.md).
> Original capture/receipt preservation and the short server result-cache layer
> remain applicable; use the newer note for current query and maintenance costs.

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

## Production acceptance

Source `936fbc0ef687b483263b81daf57ef24d72231b56` was built from a clean Git
archive, excluding another active session's unfinished 128-address changes.
The full 1,016-test suite passed in the working source. Repeating the clean
snapshot's suite concurrently with its build caused two existing timeout-only
failures; both files then passed separately (15 tests) without code changes.
Build, exact-byte device workerd/D1/R2 smoke, real-D1 usage benchmark, public
history/replay browser smoke and polling/cache-bypass browser smoke pass.

0009 applied at 12:49:29; Worker version
`58841422-43d8-4a2f-9311-439b56cd9a2a` deployed at 12:49:55, 100% traffic.
0010 applied after the new Worker was verified deployed. All times are
2026-10-29 Asia/Shanghai. No device configuration, serial access, capture policy
or firmware operation was performed by this release.

| Production query, same frozen cutoff | Before | After |
| --- | ---: | ---: |
| Public windows, 201 results | 54,729 rows read | 1,241 rows read / 2.74 ms SQL |
| Receipt fallback, one result | 49,033 rows read | 5,310 rows read / 14.67 ms SQL |

The fallback still tests eligibility among that placement's field windows; the
index removes unrelated private rows, not all per-window quality predicates.
The ordinary summary only calls this fallback when no timed public window is
available. These are individual production SQL measurements, not fleet-wide
percentage guarantees.

Before rollout, a frozen receipt cutoff selected 45,489 existing v2 items and
16,738 receipts whose expiry was more than one hour away. Their counts and
summed content lengths match after both migrations; production foreign-key
check returns zero errors. Local migration tests additionally compare complete
item/receipt/budget snapshots, not only counts/lengths. New uploads continued;
their changing budget totals were not misreported as a frozen snapshot.

Real public HTTP checks in the serving LAX location confirm all four cached
route types return `MISS -> HIT -> HIT`; repeated cached snapshot bytes match,
browser cache remains `no-store`, and explicit manual refresh returns `BYPASS`.
A cache hit returns before invoking the D1 handler, so those repeated HTTP reads
perform no D1 query. Cache remains per-location and naturally cold after deploy.
The final release's 13 image assets were inspected with ExifTool; no identifying
embedded metadata fields were found, and no image was modified.

Cloudflare query analytics, excluding index-creation statements, also record:

| Recorded production writes | Before, 12:43–12:49 | After, 12:51–12:55 |
| --- | ---: | ---: |
| Item INSERT statements / rows written | 628 / 5,574 | 417 / 2,608 |
| Mean write rows per item INSERT | 8.876 | 6.254 |
| Batch INSERT statements / rows written | 66 / 660 | 11 / 88 |
| Mean write rows per batch INSERT | 10 | 8 |

These are Cloudflare adaptive analytics over different short traffic windows,
not matched capture loads or invoice totals. They confirm lower observed write
amplification without claiming the synthetic percentage as a universal rate.
One-time index migration writes are separate from these ingestion statements.

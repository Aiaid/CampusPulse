# Backend incremental public cache

Date: 2026-10-29, Asia/Shanghai. This extends the deployed
[D1 usage optimization](d1-usage-optimization.md). The user requested a backend
cache updated only for newly committed or changed data, including delayed
uploads, cancellation and expiry, while preserving collection and v2 history.

## Incremental maintenance

`public_sensor_projection_v2` materializes public field-window candidates in D1.
Source insert/update/delete triggers maintain only the corresponding complete
`node_id,boot_id,stream,seq` identity in the same transaction. Server
`received_at` is retained separately from observation `utc_ms`. No timestamp-only
watermark is advanced, so equal receipt timestamps, late uploads and rebooted
sequences cannot be skipped. Exact upload retries return the original receipt
before writing again. No-op source updates skip projection maintenance.

The sensor cache copies only field BLE windows. Address summaries, raw reports,
health/control streams, demo and controlled-test data are not copied. Immutable
capture/placement provenance and static quality/closure eligibility are resolved
when the affected cache row changes. Closure changes update only existing
affected cache rows whose eligibility changes. They do not resurrect expired
cache entries that were already cleaned up.

`public_observation_projection` retains every active manual record. Source
changes update the corresponding cache record; cancellation removes it, allowing
the older active observation to become latest without rescanning or rebuilding
the entire cache. Original cancelled records remain in the authoritative table.
Display `valid_until` is not a deletion deadline: stale manual history and the
bounded elevator cohort remain available.

Both tables are derived read models, not replacements for canonical evidence.
No canonical v2 row, journal body, receipt, private evidence, capture policy,
device setting or firmware is rewritten by these migrations. Cache-write
failure rolls back its enclosing ingestion transaction, so the server cannot
acknowledge source data that the transaction failed to commit.

## Reads and time

Public sensor queries use place-wide projection indexes directly, including
global ordering and the existing 201-row detection limit. Manual summaries use
two indexed latest-purpose probes; history and the elevator baseline read the
incremental active-record cache. Vehicle inference continues its existing
bounded, authoritative private-evidence lookup, so delayed summaries and their
expiry are still evaluated correctly.

History range, future receipts/observations, freshness and `expires_at_ms` remain
read-time decisions. A clock crossing does not require another upload to make
a previously future record visible or an old record stale/expired.

The existing Cloudflare Cache API layer still reuses short-lived JSON snapshots;
its key version is advanced for this release. A result-cache hit calls no D1
handler. A miss/forced refresh reads the already maintained backend projection,
rather than rebuilding it from canonical history. Browser responses remain
`no-store`. The public summary/history response header
`X-CampusPulse-Projection: incremental-v2` identifies the deployed read path.

## Expiry, recovery and rollout

Read-time expiry filtering is authoritative even if maintenance is delayed.
The cron also prunes at most 5,000 expired sensor projection rows per invocation
through an expiry index, independently of canonical retention's 500-row cleanup.
This prevents an older canonical-cleanup backlog from repeatedly slowing cache
reads. Deleting a cache child never deletes canonical history. Cache-maintenance
failure is logged with a fixed category and does not prevent the original
retention/R2 cleanup. Manual observations are not pruned by display validity.

The initial migration bootstraps the derived tables in the migration transaction;
new source triggers maintain subsequent changes. A fresh projection rebuild
must use one D1 transaction/batch for clear-and-backfill, not expose partial
initialization. Edge-cache eviction affects only JSON reuse: persistent D1
projections remain available.

Initial staged deployment: apply 0011, deploy and verify the new Worker, then
apply 0012 to remove the canonical public indexes still named by the old Worker.
Deploy from a committed clean source snapshot while other local sessions work.

## Verification and costs

Migration tests compare complete canonical contents, bootstrap and incremental
rows, retries, no-op updates, rollback, tied timestamps, late data, source
repairs/deletion, strict quality guards and closure reclassification. API tests
cover cancellation fallback, manual backfill, dynamic freshness/history,
future records, and retained elevator samples. Retention tests cover indexed
bounded pruning, canonical preservation and maintenance-failure isolation.

`node scripts/public-projection-runtime-smoke.mjs` uses validated synthetic
envelopes and real ephemeral workerd/D1. The measurement wraps every
`first/all/run/batch` execution within the named commit/read phases, excluding
seed/migration, HTTP authentication and validation overhead.

| Synthetic workload: 40 timed windows, 640 summaries, 40 statuses, one unknown-clock receipt | Before projection | Incremental projection |
| --- | ---: | ---: |
| Commit-phase read rows | 8,684 | 8,807 |
| Commit-phase write rows | 6,096 | 6,178 |
| Uncached 40-window read, canonical oracle vs projection | 801 | 40 |
| Uncached receipt fallback, canonical oracle vs projection | 724 | 1 |
| Additional write rows for two exact retries | 0 | 0 |

Maintenance costs are real: this workload adds 82 write rows (1.35%) and 123
read rows to ingestion; it does not add per-address projection writes. A
separately measured expiry pass removes 41 cached rows, reads 164 rows and writes
41 rows, leaving every canonical item/receipt/budget byte unchanged. These are
specific workload measurements, not universal fleet ratios or invoice totals.
Canonical-query oracle counts are independent reference-query measurements,
not a claim that every preceding production API had the same query plan.

## Production acceptance

Validated source `58266e2e1c6a62e97c6cef6a8d0f42e57defcdb4` was built from a
clean committed snapshot, excluding concurrent uncommitted hardware changes.
1044 unit/integration tests, TypeScript/build, the complete GIS regression, exact
device v2 workerd/D1/R2 checks and the real-D1 projection benchmark passed.

The staged 0011 → Worker → 0012 rollout completed on 2026-10-29. Worker version
`930369c4-c60b-4878-a28b-d7e8ce9d1b4b` received 100% traffic at **13:36:02
Asia/Shanghai**. A forced public request returned HTTP200, `incremental-v2` and
`BYPASS`. No serial, firmware, device-policy or collection operation was made
by this release; the separate hardware session resumed after this server handoff.

Production uncached SQL measurements return 201 windows with 201 rows read and
one receipt fallback with one row read (4.73ms /0.51ms in the recorded sample).
The preceding indexed version's samples were1241/5310 rows respectively;
these are individual measurements at different timestamps, not matched fleet
traffic or a universal latency percentage.

Independent canonical-source queries at the same cutoff matched exact record
identities and item payload bytes for all five real places, both history-window
and receipt-fallback paths. The production active-manual projection also matched
its source (zero active rows in this snapshot); positive cancellation/history
cases are covered by isolated real-D1 and API tests, not synthetic production
field writes. Those ten full-source comparisons are one-time audit reads, not
the normal public query path.

A frozen pre-rollout receipt cutoff selected **48361 v2 items and17186 receipts**
whose expiry was more than one hour away. Their counts and summed content
lengths match after rollout, and foreign-key checks return zero errors. Local
migration tests additionally compare complete source snapshots byte for byte.
Production cache-expiry cleanup found zero eligible rows, read two rows, wrote
zero and performed no canonical deletion; positive expiry and backlog tests run
only against isolated databases.

All four result-cache route types again returned `MISS → HIT → HIT`, with
identical repeated snapshot bytes, browser `no-store`, and explicit manual
`BYPASS`. Hits do not execute the D1 handler. The serving location in these
HTTP samples was LAX; CacheAPI remains per-location. The final release's13
image assets were checked with ExifTool, with no identifying embedded metadata
fields detected and no image modifications.

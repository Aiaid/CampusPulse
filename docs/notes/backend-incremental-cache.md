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

Production acceptance is pending; record deployment identity, actual read costs,
cache-hit behavior and canonical-preservation checks after coordinated rollout.

# Elevator cohort integration

Date: 2026-10-25. Scope: rule-based, read-only integration into the existing app.
No model training, firmware changes, database migration or production data writes.

## Implemented

- `worker/elevator-cohort-rules.js`: stable cohorts, frozen denominator, grouped
  disappearance, deferred confirmation, deduplication and reappearance flags.
- `worker/elevator-cohort-adapter.js`: v2 window/summary reconciliation and bins.
- `worker/elevator-cohort-store.js`: bounded private D1/health reads, field-only
  partitioning, placement/expiry/clock gates and aggregate event projection.
- `worker/index.ts`: public elevator-events GET route; existing manual and sensor
  summary contracts are independent. OpenAPI covers the new route.
- `src/campus/ElevatorEvents.jsx`: integrated into the existing field-record
  dialog for elevator places, refreshed every 30 seconds with abort/race guards.
  Unavailable, degraded, warming and stale observations remain distinct.

The rule and demo code are original work from this session. No external algorithm
or model implementation was imported. Private inputs remain private and the
public route never publishes raw identifiers or source items.

## Local verification

The managed shell cannot reach its configured network proxy. Source was restored
from the GitHub connector at `5a44b501690c5bbfacf0746f87a8fc61baf01d4b`;
local npm dependencies could not be installed from the empty cache.

Dependency-free checks ran with Node 24:

```sh
node tests/elevator-cohort/rules.checks.mjs
node --experimental-transform-types tests/elevator-cohort-store.checks.mjs
```

The first has 23 rule/adapter/output checks. The second has 17 real SQLite cases
using the production commit path, including field/test/demo isolation, summary
incompleteness, scanning/overflow/loss, private expiry, placement closure, boot
isolation, receive availability, stale uploads and same-epoch clock mapping jumps.

Vitest adds HTTP API tests and OpenAPI schema checks; its default suite also invokes
both native regressions. The new read-only browser smoke checks the real empty
endpoint plus explicitly mocked candidate/unavailable/error UI responses at phone
size, without submitting manual or sensor records. CI runs this with the existing
build and browser checks. Hosted results and physical accuracy must be reported
separately; local native checks alone do not establish deployment/browser success.

## Runtime limits

Only the latest eligible node/boot/placement/config partition at the selected
place is analyzed. At most 60 windows in 15 minutes, 3840 summaries and 65 health
records are read; output is capped at 20 events. Truncation is explicit.
No unlimited history, durable event archive or claimed background processing is
introduced. Window-level scan time does not prove complete per-bin radio reception.

Next physical acceptance: fixed elevator-lobby placement, verified v2 address
policy and time sync, labeled boarding/exit examples, measured end-to-end delay.

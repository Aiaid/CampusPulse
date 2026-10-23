# First web/API slice

Status: implemented first slice; local SQLite, build and browser checks recorded
in [development notes](../notes/development.md).
This is not the BLE ingestion v1 implementation. No firmware is included.

## Public reads

- `GET /api/v1/health`: runtime liveness, explicitly reports ingestion unavailable.
- `GET /api/v1/places`: registered logical places, kind, provisional normalized
  schematic anchors, an optional verified GIS image anchor (library only), and
  unconfigured sensor coverage.
- `GET /api/v1/places/:id/summary`: latest active manual observation, source,
  observation time, validity deadline and freshness. Sensor data is `null`.
- `GET /api/v1/places/:id/history?minutes=15`: active manual observations in
  1/5/15/60/1440 minutes; maximum 200 records and a truncation indicator.

An empty summary means no data, never zero people or zero vehicles. Public fields
exclude device credentials, BLE identifiers and raw payloads. Responses are not cached.

## Operator writes

Set `OPERATOR_TOKEN` as a Worker secret (local development: ignored `.dev.vars`).
The browser accepts a token for the current form session; it must not be compiled
into frontend environment variables. Writes reject a mismatched Origin header.

`POST /api/v1/observations` requires bearer authentication and JSON under 8 KiB:

```json
{
  "id": "c3dca7ef-48a3-4500-a809-08a666223f0e",
  "place_id": "east-parking",
  "kind": "parking",
  "observed_at": "2026-10-23T05:00:00.000Z",
  "parking_min": 4,
  "parking_max": 7
}
```

Use a fresh UUIDv4 and actual UTC observation time. Elevator records instead have
`kind: "elevator"` and integer `wait_seconds` (0–7200), without parking fields.
Parking bounds are integers 0–10000 with min ≤ max. Place kind must match.
Only observations within the past 24 hours (up to 30 seconds clock skew ahead)
are accepted. Validity expires 15 minutes after observation, not reception.

Insertion returns 201; an identical ID/body retry returns 200; a changed body for
an existing ID returns 409. Response confirmation follows the D1 write. Cancellation
is idempotent `DELETE /api/v1/observations/:id` with the same operator credential.
Correct an error by cancelling it and submitting a fresh record.

No device ingestion or research/raw receipt route is implemented. No production
operator identity, rate limiting, retention job or deployment is claimed by this slice.

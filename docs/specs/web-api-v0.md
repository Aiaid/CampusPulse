# First web/API slice

Status: implemented first slice; local SQLite, build and browser checks recorded
in [development notes](../notes/development.md).
This document retains the original manual API contract. The additive device API
and sensor projection are described in [ingestion implementation](../notes/backend-ingestion.md)
and [ingest v1](ingest-v1.md). No firmware is included.

## Interactive documentation

`GET /docs` (also `/docs/`) serves Swagger UI; `GET /openapi.json` returns the
OpenAPI 3.1 description of nine implemented operations (six web/manual plus three
device/research operations). These routes are
public and require no database access or operator credential. The specification
uses the current origin, so the same routes work in local development and after
deployment. Unsupported methods return 405; HEAD returns headers without a body.

Use **Try it out** to execute a public read. For writes, choose **Authorize** and
enter only the opaque operator token, without the `Bearer` prefix. Authorization
is held in page memory and cleared by refresh; it is not written to browser
storage or included in the published specification. The self-hosted UI sends
requests only to this origin and does not contact an external schema validator.
Executing POST or DELETE changes the current environment's real records.
Generated request examples are synthetic; replace values with actual manual
observations before submitting. Refresh the specification to get fresh example
UUIDs/timestamps; retries must retain the exact original ID and content.

This is shared-operator bearer authorization: all token holders can create and
cancel any manual record. Account login, JWT sessions, personal ownership and
role-based access control are not implemented. The existing same-origin write
check and fail-closed behavior remain in effect.

Local verification (2026-10-23): OpenAPI 3.1 standard validation, API/contract
tests, production build, actionlint and Wrangler dry-run passed. Real Chromium
executed Swagger UI reads, missing-token rejection, authorization, creation and
cancellation in a separate local D1 store, then verified that refresh clears
authorization. No external requests, credential persistence or page errors were
observed. This test did not write production records. Hosted CI/deployment is a
separate acceptance step.

## Public reads

- `GET /api/v1/health`: runtime liveness, reports ingestion implemented and whether raw storage is bound; it does not probe dependencies.
- `GET /api/v1/places`: registered logical places, kind, provisional normalized
  schematic anchors, an optional verified GIS image anchor (library only), and
  unconfigured sensor coverage.
- `GET /api/v1/places/:id/summary`: latest active manual observation, source,
  observation time, validity deadline and freshness; an independently sourced eligible field sensor window may also be present.
- `GET /api/v1/places/:id/history?minutes=15`: active manual observations in
  1/5/15/60/1440 minutes; maximum 200 records and a truncation indicator.
  Adds a separate bounded `sensor_windows` array and `sensor_truncated` flag.

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

Device ingestion/research routes and a bounded ingestion-retention job are now
implemented; see the linked implementation notes. Production account identity,
rate limiting and manual-observation retention remain unimplemented.
Cloud deployment and browser/API verification are recorded in the
[CI/CD notes](../notes/ci-cd.md); these do not validate devices or BLE reception.

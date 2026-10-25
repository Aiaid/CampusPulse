# First web/API slice

Status: implemented first slice; local SQLite, build and browser checks recorded
in [development notes](../notes/development.md).
This document retains the original manual API contract. The additive device API
and sensor projection are described in [ingestion implementation](../notes/backend-ingestion.md)
and [ingest v1](ingest-v1.md). Firmware is outside this document's scope; the
current Passport implementation is described in [firmware chain](../notes/firmware-chain.md).

## Interactive documentation

`GET /docs` (also `/docs/`) serves Swagger UI; `GET /openapi.json` returns the
OpenAPI 3.1 description of implemented public, operator, administrator,
device and research operations. The additional management contract is documented
in [Admin v1](admin-v1.md). These routes are
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
cancel any manual record. Individual accounts, operator JWT sessions and
per-user operator record ownership are not implemented. A separate administrator
account with password/Passkey sessions now protects `/admin` management; see
[authentication](admin-auth-v1.md). It does not grant operator or researcher access.
The existing same-origin write
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
- `GET /api/v1/settings`: public site name and initial demo/field mode only;
  no administrator settings, credentials or device information.
- `GET /api/v1/places`: registered logical places, primary legacy kind and enabled
  `observation_kinds`, provisional normalized
  schematic anchors, an optional verified GIS image anchor (library only in the
  initial seed; editable through the administrator registry), and
  unconfigured sensor coverage.
- `GET /api/v1/places/:id/summary`: latest active manual observations per kind in
  `latest_observations`, the legacy `latest_observation`, source,
  observation time, validity deadline and freshness; an independently sourced eligible field sensor window may also be present.
- `GET /api/v1/places/:id/history?minutes=15`: active manual observations in
  1/5/15/60/1440 minutes; maximum 200 records and a truncation indicator.
  Adds a separate bounded `sensor_windows` array and `sensor_truncated` flag.

An empty summary means no data, never zero people or zero vehicles. Public fields
exclude device credentials, BLE identifiers and raw payloads. Responses are not cached.

`sensor` and each record in `latest_observations` are independent sources.
Top-level `freshness` is fresh if any source is fresh; render a manual record against its own
`valid_until` and a sensor window against its own freshness, rather than applying
the combined status to both. Public sensor windows include their node,
placement/configuration, observation time, validity, scan duration, report count,
visible-identifier count and quality fields. These are observation metrics, not
people counts. Place `coverage` remains `unconfigured`; it is not inferred from a
map anchor or a successful upload.

The frontend's unified observation timeline consumes summary while following
live time and this history contract when its cursor is pinned. The initial range
is 60 minutes, with 15/60/1440-minute choices. At a history cursor, sensor windows
apply within `[observed_at - duration_ms, observed_at]`, with nodes shown
separately; manual records apply within `observed_at <= cursor < valid_until`.
Gaps do not inherit adjacent records. Returning to live resumes summary display;
the shared read session refreshes summary and history together in either state.
These are client display semantics; the stored timestamps remain unchanged.
`minutes`
selects a window relative to request time, with a maximum of 1440 minutes;
arbitrary start/end dates, paging and file import are not provided. Retention
and source eligibility can remove windows, and cancelled manual records are
excluded. Respect both truncation flags instead of implying a complete recording.

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
Parking bounds are integers 0–10000 with min ≤ max. The kind must be enabled in
the place's `observation_kinds`; parking and elevator can coexist at one place.
Only observations within the past 24 hours (up to 30 seconds clock skew ahead)
are accepted. Validity expires after the configured observation TTL (15 minutes
by default), measured from observation, not reception. Settings affect new records;
existing records and identical retries keep their original expiry.

Insertion returns 201; an identical ID/body retry returns 200; a changed body for
an existing ID returns 409. Response confirmation follows the D1 write. Cancellation
is idempotent `DELETE /api/v1/observations/:id` with the same operator credential.
Correct an error by cancelling it and submitting a fresh record.

Device ingestion/research routes and a bounded ingestion-retention job are now
implemented; see the linked implementation notes. Production account identity,
rate limiting and manual-observation retention remain unimplemented.
Cloud deployment and browser/API verification are recorded in the
[CI/CD notes](../notes/ci-cd.md); these do not validate devices or BLE reception.

# Admin v1 / 管理界面与接口

**Authentication update:** migration `0004_admin_auth.sql` replaces shared-token
login with a restricted first-use bootstrap, managed account/password and Passkeys.
See [administrator authentication](admin-auth-v1.md) for the current flow and
acceptance. The shared-token session description and261-test record below are
historical evidence for the earlier management slice, not the upgraded auth path.

Status: implemented and locally verified (2026-10-24).
This additive slice is not a deployment or physical-device acceptance record.
The existing shared worktree contains independent lighting/research changes;
admin acceptance does not validate those changes.

## Scope and authentication

`/admin` is a separate React entry in the existing application. It uses the same
Worker and D1; it does not require a second hosting service. Navigation covers
fleet overview, devices, places/deployments, capture policies, settings and audit.
No raw advertisements or BLE identifiers appear in management responses.

Set an independent, high-entropy `ADMIN_TOKEN` Worker secret. Do not reuse the
operator, device or research credential. The login exchanges this credential for
an expiring HttpOnly, SameSite=Strict cookie; HTTPS cookies are Secure. The local
HTTP exception is for loopback development. Sessions are server-revocable and
logout invalidates the session. Changing the administrator secret invalidates
signatures. Neither the administrator credential nor the device credential is
saved in browser local/session storage. This is one shared administrator role;
individual accounts and per-user permissions are not implemented.

Login and management mutations require a matching Origin header. Requests fail
closed if administrator authentication is not configured. Runtime errors return
bounded, structured messages without input contents, tokens or SQL details.
Responses use `Cache-Control: no-store`. Device credentials are generated using
Web Crypto and stored only as SHA-256 digests. Registration and rotation reveal
the new credential once; it cannot be recovered by list/detail/audit reads.
Rotation immediately invalidates the old credential, and disabled nodes cannot
authenticate. Neither action erases uploaded records or pauses hardware locally.

## API surface

All management paths below are relative to `/api/v1/admin`. See the same-origin
`/openapi.json` and `/docs` for operation details.

| Route | Purpose |
| --- | --- |
| `GET/POST/DELETE /session` | Check/login/logout shared administrator session |
| `GET /overview` | Fleet contact freshness and pending policies |
| `GET/POST /devices` | List/register independently credentialed nodes |
| `GET/PATCH /devices/:id` | Health/history and editable name, board, enabled state |
| `POST /devices/:id/rotate-credential` | Replace device credential; one-time reveal |
| `POST /devices/:id/placements` | Register deployment and close an earlier open deployment |
| `GET/POST /places`, `PATCH /places/:id` | Edit logical places and map anchors |
| `GET/POST /configs`, `PUT /configs/:id` | List/create/edit versioned capture drafts |
| `POST /configs/:id/validate` | Check the saved draft and registry associations |
| `POST /configs/:id/publish` | Publish a validated version and assign desired policy |
| `GET/PUT /settings` | Read/save runtime settings with optimistic revision |
| `GET /audit` | Read bounded, redacted management history |

Draft and settings updates carry their current revision; stale saves return 409.
Management mutations and their audit entry commit together. Tokens, credential
digests, raw payloads and unbounded client content are excluded from audit detail.
A successful write response follows persistence, not just an optimistic UI update.

## Editable settings and retained history

The previous blanket immutability model becomes an editable management workflow:

- Device names, board labels, enabled state, place metadata and site settings can
  be changed through validated APIs.
- Capture drafts can be edited repeatedly before publication. Publication creates
  a policy version and selects it explicitly as the device's desired policy.
  Clone a published version with a fresh ID to change it; already queued data
  still refers to its exact original policy. The server preserves historical
  published policy content rather than rewriting what collected data means.
  New publication requires a currently active deployment, checked both before
  and inside the transaction so concurrent relocation cannot publish stale scope.
- Moving a device ends the earlier deployment interval and starts another one.
  Old batch placement IDs stay unchanged. A registry write alone does not move
  hardware, split an in-progress capture window or make new firmware run.
- A place-kind change must not contradict existing manual-record history.

This is deliberate versioned editing, not an unrestricted database editor.
References, receipt hashes, old record expiry and historical collection identity
must remain explainable after a settings change.

Settings include site name, initial demo/field mode, contact-staleness threshold,
manual-observation TTL, and default raw/aggregate retention for new capture drafts.
`GET /api/v1/settings` is public and exposes only the site name and initial mode.
The map reads these before mounting; changes affect a new page load, not a user's
current mode selection. If settings cannot be loaded, the map uses an explicit
field-mode fallback and displays a notice. New manual records use the TTL at
insertion; changing it does not rewrite existing records. New drafts inherit
retention defaults; published policies retain their own retention values.

## GIS location editing

The place editor now uses the same official GIS raster/camera as the public map.
Picking a point converts it to the existing complete-image normalized
`gis_anchor`; the separate schematic `anchor` is preserved. Coordinate changes
require explicit operator verification before saving. Verified, in-scene places
appear in public field maps/search/details, with direct place links and record
selection using the same ID. Missing/outside-scene positions are reported rather
than substituted. See [location settings](../notes/gis-location-settings.md) for
the coordinate transform, refresh behavior and local verification boundaries.

## Contact, health and device application

Recent contact is computed from server receipt timestamps, not a device's UTC or
sequence number across boots. Missing status is unknown, not zero or healthy.
Status fields show the last uploaded snapshot with its receipt time: scan/Wi-Fi
state, memory, storage, per-stream queues, buffer pressure, losses and failures.
Optional battery voltage or RSSI is only shown when reported. Historical or
expired status is not evidence that the device is scanning now.

Policy state distinguishes desired version, batch-reported version and explicit
activation report. `GET /api/v1/device/config` selects the desired version when
assigned; legacy nodes retain their previous selection behavior. An explicit
`capture_config_id` still retrieves an older policy for queued batches.

`POST /api/v1/device/config/ack` uses the node's own bearer credential and accepts
`{capture_config_id,state:"applied"|"failed",message?:machine_label}` for its assigned
policy. A batch bearing a config ID does not count as an activation ACK. An applied
state is the device's own report, not independent hardware validation. Firmware
polling, safe window split, durable queue preservation and actual application on
each physical board remain separate work. The management interface must show
pending until the relevant evidence arrives.

## Setup and acceptance

Apply all additive D1 migrations, configure the independent administrator secret,
build, and open `/admin`. Do not paste secrets into tracked config, commands or
logs. `.dev.vars.example` documents the local secret name only; actual credentials
belong in ignored private files or the Worker secret store.

Local browser acceptance uses disposable credentials and a separate local D1/R2
state directory. It exercises authenticated management writes, editing and
revision conflicts, policy publication, settings persistence, session refresh/
logout and a phone layout. It does not write to production or validate physical
configuration activation.

Local acceptance on 2026-10-24:

- All three migrations applied to a separate local Wrangler D1 store; existing
  legacy provisioning still worked in the workerd ingestion regression.
- Full repository suite: 261 tests in 29 files passed at the verification cutoff,
  including 14 admin integration/security tests; TypeScript and Vite build passed.
  Concurrent frontend work contributes tests to this aggregate; admin acceptance
  does not independently establish its visual or physical properties.
- Real local D1/R2 workerd ingestion regression passed three streams, concurrent
  identical retries, overlap rejection, private research reads and demo isolation.
- Real Chromium passed rejected/corrected login, token rotation with old-token
  rejection, disable/enable, device/place/deployment creation, editable draft
  validation/publication, cloning and changing a published policy while exact
  original content/retention stayed retrievable, and synthetic config ACK-to-UI.
- Browser refresh preserved settings, audit excluded secrets, logout revoked
  access, and credentials stayed out of persistent storage. Phone checks at
  390×844 verified readable device rows, inner table scrolling and no document
  overflow; desktop/login/phone screenshots were inspected privately, stripped
  of metadata and rechecked without exposing credential inputs.
- Read-only Swagger rendered all 32 operations without runtime errors. The
  actual admin page returned its frame/CSP protections, and changing the public
  site name/default field/demo mode changed a newly loaded map's brand, title
  and synthetic-actor visibility. Original test settings were restored. The
  previously deferred manual-record browser-write regression was not resumed.
- API tests exercised expiry/tampering/role isolation, concurrent draft/settings
  revisions, mutation/audit rollback, inactive deployment and closure/publication
  races, null/array validation, newest-receipt health across boots and new-record
  TTL changes without changing old records or identical retries.

No production records were written, no administrator production secret was set,
and no commit or deployment was performed. The browser ACK was synthetic and
establishes only endpoint/UI behavior. Individual firmware activation, real
devices, physical deployment and sustained radio/storage behavior remain pending.

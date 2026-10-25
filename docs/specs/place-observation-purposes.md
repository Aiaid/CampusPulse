# Multi-purpose places and device deployments

Status: implemented and locally verified, 2026-10-25. This change records observation
purposes and preserves source attribution; it does not implement automatic
vehicle classification or elevator wait prediction.

## Place purposes

A place describes one physical location. `observation_kinds` enables one or more
of `activity`, `parking`, and `elevator` there. The administrator interface calls
these 活动监测, 电动车监控 and 电梯观测. The legacy `kind` field remains a primary
label for older clients, not an exclusive restriction on that location.

The additive migration initializes existing places from their original `kind`;
it does not silently enable more purposes. Both old single-kind requests and new
array-based administrator requests remain supported. Empty, duplicated or
unsupported purpose lists are rejected. Disabling a purpose affects new manual
entry, while existing records, cancellation and evidence timestamps remain
available under the existing history and retention rules.

Public summaries add independent `latest_observations.parking` and
`latest_observations.elevator` records. The older `latest_observation` field stays
available. Each result uses its own observation time and expiry: a new elevator
record must not overwrite a parking record or make an expired result fresh.
The live cards, manual-entry form and pinned history use these separate kinds.
Activity uses the shared BLE window metrics; visible identifiers remain distinct
from people, vehicle counts and occupancy.

## Device place and work purposes

For an existing device, open **设备管理 → device → 修改地点与工作方式**. Select a
place and one or more work purposes enabled at that place. An unlocated/mobile
deployment may select any supported purposes, but it remains outside fixed-place
public sensor projection. The same editor retains access to capture parameters.

Selected `observation_kinds` are immutable deployment metadata, not new fields
inside the strict firmware capture policy. Changing the place or selected
purposes creates a new deployment and publishes a new configuration referencing
it. The device still performs the common BLE collection/upload workflow; this
does not request three scans, enable raw capture or install additional algorithms.
An online device can obtain the new configuration without re-registration,
credential rotation, USB reconnection or a firmware update for this metadata.

Saving establishes the desired version. Only the matching device activation ACK
establishes application; queued observations retain their original deployment and
configuration. The interface must distinguish desired and applied places/work
purposes, including while offline or when application fails.

Deployment creation and policy publication currently use separate transactions.
If a response is lost, retries reconcile fixed deployment/policy IDs and the exact
selected purposes rather than creating duplicates. A partially successful save
can close the previous deployment before policy publication finishes; keep the
editor open and retry the retained operation. This limitation is not an atomic
device reconfiguration guarantee.

## Verification

Acceptance must cover migration from existing data; both manual types at one
place; independent result freshness; history after purpose changes; same-place
device purpose changes; changed-place publication; lost-response reconciliation;
desired/applied separation; and desktop/mobile browser operation. Local synthetic
tests do not establish deployment, physical activation or field accuracy.

Local acceptance: 669 tests / 60 files and the production build passed. The
new `scripts/place-purposes-browser-smoke.mjs` uses actual ephemeral workerd/D1
with synthetic data to create a three-purpose place, show independent expired
parking and fresh elevator records, submit both kinds, relocate an existing
node, change only its purposes at the same place, preserve original policy and
deployment content, and transition pending to applied through an explicitly
simulated device ACK. Desktop and 390px forms passed. Existing configuration
editing browser coverage still passes invalid-bin rejection, correction after
validation failure, committed-response loss retries and mobile editing. Real
ephemeral D1/R2 v1/v2 ingestion checks also passed after migration. Both new
browser flows run in CI; hosted release and physical activation are separate.

The existing provisioning browser fixtures now include the same normalized
place/deployment purpose metadata returned by the migrated API. Full Chromium
provisioning and the installed WebKit device-page checks pass, as does the real
ephemeral D1/R2 uploaded-evidence browser flow. Synthetic provisioning peers and
activation ACKs remain distinct from physical-device acceptance.

# Default saved V3 startup — 2026-11-06

Status: implementation, targeted software verification and both S3 image builds
passed. Release and actual saved-profile reboot remain separate gates.
This supersedes the earlier blanket restriction on saved PEAP in the
[November 3 authentication repair](v3-usb-wifi-auth-2026-11-03.md).

## Default operator flow

The administrator USB wizard defaults to saving configuration and continuous
operation. Open, personal and explicitly unverified PEAP are supported. Changing
network mode preserves the operator's preference. Cancelling saving retains
temporary one-to-three-window operation. Strict CA-verified PEAP remains manual
USB, with full chain, hostname and certificate-date checks; the implementation
does not weaken them to break the pre-network clock dependency.

Only a newly submitted save flow can automatically prepare the initial policy.
It waits for real matching node/USB-boot capabilities, reuses a previously applied
template without expanding its limits, and requires its deployment to remain
valid. Without an approved template, only a sole valid unlocated deployment may
receive the conservative controlled-test profile. Missing or ambiguous deployment
requires explicit management. Merely opening a page never publishes a policy.

The pre-submit desired generation, digest and startup-grant revision are pinned.
External policy changes, revocation, a different boot, closure or CAS conflict
stop automatic writes. Preparation, validation and assignment are distinct from
the device's real applied ACK. After the matching durable ACK and literal
`V3 STARTUP SAVED`, the flow requests one seven-day renewal grant. Failure or
authentication cancellation leaves a precise incomplete state, without retries.
Ordinary manual approval/revocation remains available.

## Saved profile and authentication

Startup record v2 adds an explicit PEAP NONE choice, retaining the 1280-byte
record bound, CRC, node/key binding, inactive-slot readback and selector commit.
Old open/personal records remain readable. Disabled v1 PEAP records retain
unknown trust for read-only credential reuse; unknown trust is never interpreted
as NONE and cannot be re-saved or automatically started.

Both S3 runtimes save and restore the explicit choice. A dedicated PEAP-NONE
clock entry establishes Wi-Fi using the supplied identity/username/password,
obtains a candidate date, then performs the unchanged strict HTTPS and pinned
signature/nonce verification. Only that verified result authorizes formal
MQTT/TLS. Failed cleanup retains network ownership and prevents the next owner.
The original clock entry still rejects PEAP. Cloud TLS is unchanged.

No legacy settings, queues, Flash partition table, CA trust or timestamp is
silently migrated. CA-mode credentials are not stored in this profile. Host CLI
saving remains explicit opt-in; the new defaults apply to the administrator UI.

## Control compatibility and concurrent administration

New setup assignments include optional `expected_startup_revision`; the backend
checks it against the same startup-version guard used by the write transaction.
The pre-USB generation/digest must also remain unchanged. An unrelated newer
policy cannot become the setup baseline or be overwritten by an older template.

Fresh committed assignment responses expose their own revision transition in
`X-CP-Startup-Revision-Before`, `X-CP-Startup-Revision-After` and
`X-CP-Startup-Revoked` headers. Exact retained retries preserve identical JSON
receipts and omit these transaction-only hints. The UI validates the headers;
wire JSON fields alone cannot establish transition evidence. A flow can accept
its own policy-triggered grant revocation but cannot override an external one.

Expired capability preparation returns `409 v3_capabilities_expired`. The wizard
also prevents preparation on expired or mismatched USB capabilities. Both board
policy waiters follow actual capability expiry and conservative current-clock
bounds instead of a fixed 180-request limit; late responses cannot activate an
expired snapshot. Waiting and expiry are reported separately from generic run
failure. T-Energy's recognized profile now receives its actual 128 KiB/day uplink
ceiling, with incompatible new policies rejected before device delivery.

## Verification boundary

Targeted backend/control/startup and header normalization tests, provisioning
unit/browser regressions, startup/NVS fault tests, clock verifier and executed
mock-SDK bootstrap tests passed. Parser/UART and both board wait helpers have
sanitizer coverage, including policies arriving after the old request-count
limit, clock failure and cancellation. These are software results, not proof of
real PEAP reboot, radio completeness, sustained daily capacity or arbitrary
power-loss recovery. Hardware images and acceptance are recorded after actual
build and device verification, with credentials/captures kept private.

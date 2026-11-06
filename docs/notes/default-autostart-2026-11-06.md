# Default saved V3 startup — 2026-11-06

Status: committed, pushed and deployed. Waveshare completed the normal webpage
save flow, real applied ACK, automatic grant and saved-profile restart. T-Energy
applied the new continuous-operation budget; its subsequent upload/restart
acceptance is still being recorded. Same-boot continuous renewal is a separate
follow-up and is not established by the earlier restart test.
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
failure. T-Energy preparation distinguishes the original 1 MiB storage /
128 KiB uplink tier from firmware advertising the new 192 MiB logical-storage /
8 MiB uplink tier. New policies use the matching tier; old immutable policies,
ledger charges and historical receipts are retained. Logical storage accounting
is not a measurement of physical Flash writes or endurance.

Grant approval permits a concurrent lease heartbeat only when the exact startup
revision, boot, capability digest, desired/applied source and immutable applied
ACK remain unchanged. Policy, boot and revocation races still reject approval.
Revocation retains its full control-version guard.

## Production release and physical evidence

The default setup release was committed as `884e715`, with later USB/runtime
fixes in `3bb6f36`, `5e48c7d` and `773ced6`. Source `f3ede69` adds online-control
interfaces, the precise grant guard and the compatible T-Energy budget tier,
while preserving the separately published frontend/simulator source. Its direct
production release applied additive migration 0021 and published:

| Component | Cloudflare version |
| --- | --- |
| Main API and frontend | `4890317c-2992-4bc4-8e96-1c2db583fda0` |
| Native MQTT gateway | `8d70441b-7809-4fe9-9ee2-a3d3742c68fa` |

No historical collection records or legacy device queues were deleted. Existing
production bindings, credentials and the exact simulator allowlist were retained.
The direct release used targeted checks and a production build; this note does
not claim a new completed hosted CI run.

The [Waveshare acceptance record](waveshare-default-startup-acceptance-2026-11-06.md)
separates the ordinary USB-free power restart from a later diagnostic USB reset.
The USB-free boot registered and applied a policy, but USB was reconnected before
it completed a full window. The subsequent saved-profile boot uploaded windows
without host configuration or time commands. Neither is an all-day or arbitrary
power-loss test. The newer continuous, same-boot runtime remains separately
tracked.

## Verification boundary

Targeted backend/control/startup and header normalization tests, provisioning
unit/browser regressions, startup/NVS fault tests, clock verifier and executed
mock-SDK bootstrap tests passed. Parser/UART and both board wait helpers have
sanitizer coverage, including policies arriving after the old request-count
limit, clock failure and cancellation. These are software results, not proof of
radio completeness, sustained daily capacity or arbitrary power-loss recovery.
The bounded real PEAP restart evidence is recorded separately above. Hardware
images and acceptance are recorded after actual build and device verification,
with credentials/captures kept private.

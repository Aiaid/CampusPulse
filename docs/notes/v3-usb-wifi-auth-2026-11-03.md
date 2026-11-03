# V3 USB Wi-Fi authentication repair — 2026-11-03

Status: local implementation and scoped software verification. Publication needs
the actual release CI/CD result. No serial port was opened, no hardware was
flashed, and no real PEAP wireless handshake or new hardware acceptance was
performed for this repair. Earlier physical results retain their original
firmware, network and time scope.

Current-policy correction: the user's subsequent clarification supersedes this
note's earlier mandatory-CA PEAP requirement. No CA means an explicitly
unverified EAP server; opting into CA verification requires strict chain,
hostname and certificate-date checks. The earlier mandatory-CA implementation
and its software checks are history, not the current provisioning policy.

## Migration gap and repair scope

The V3 migration retained settings and transport capabilities for open Wi-Fi and
enterprise PEAP, but the new administrator USB flow and bootstrap receivers
blocked those modes. Earlier tests covered the personal-network happy path and
did not establish authentication-mode equivalence. This was an integration and
regression-coverage gap. The shared V3 transport already had certificate security
settings; the repair does not establish that every older PEAP path lacked them.

The browser, both S3 USB receivers and private host tools now carry explicit
authentication mode and mode-specific fields. MQTT credentials and native
production transport remain independent. No legacy settings, historical cloud
records, device queues, NVS settings structure or persisted startup profile
format is migrated or expanded.

The same-node device bearer and MQTT credentials can now be reused locally on
the physical device. USB reports readiness rather than exporting secrets; this
does not import an old network configuration or migrate stored records.

## Current input contract

The private host Wi-Fi JSON and flat `V3START` Wi-Fi fields use the following
contract. Browser/host inputs may omit `security` to retain the existing
personal-network default. Tools always send it explicitly: the firmware's
`V3START` wire requires the field.

| Field / mode | Requirement |
| --- | --- |
| `security` | `open`, `personal` or `enterprise_peap` |
| `ssid` | 1–32 printable-ASCII characters |
| Open `password` | Present and empty |
| Personal `password` | 8–63 printable-ASCII characters, or exactly 64 hexadecimal digits |
| PEAP `password` | Present and empty; this is the personal-network field |
| PEAP `eap_username`, `eap_identity`, `eap_password` | Each 1–128 printable-ASCII characters; outer identity is explicit |
| PEAP `eap_server_verification` | `none` or `ca`; the UI defaults to `none` |
| PEAP `none` | Omit `eap_ca_pem` and `eap_domain`; do not verify the RADIUS server |
| PEAP `ca`: `eap_ca_pem` | Exactly one real PEM X.509 CA certificate, at most 4096 bytes; Basic Constraints must assert CA, and Key Usage must permit certificate signing if present |
| PEAP `ca`: `eap_domain` | One DNS hostname, at most 253 characters, with 1–63-character labels; a single label such as `radius` is allowed; IP literals, URLs, wildcards and lists are rejected |

Printable ASCII means byte values 0x20–0x7e. SSID and credential byte lengths
therefore equal character lengths in the current browser/CLI/firmware contract.
This path does not admit arbitrary UTF-8 SSIDs or credentials. PEM uses its
restricted ASCII certificate envelope and line endings instead of the credential
text rule. Open/personal inputs reject EAP fields, and PEAP rejects a nonempty
personal password. Mode changes discard stale mode-specific form fields.
The complete `V3START` line remains bounded by the existing 8 KiB limit.

The browser checks lengths, field combinations and PEM structure. Those checks
are not X.509 authentication. The host preflight uses `cryptography` to parse a
real CA; the firmware/shared validator uses actual mbedTLS X.509 parsing, rejects
multiple certificates or trailing material, and checks the CA properties above.
Successful local CA parsing does not itself authenticate a remote RADIUS server.
Invalid supplied trust material is rejected rather than silently selecting
`none`. After a failed submission, secret fields are cleared and the chosen
verification mode remains selected.

## Authentication, clocks and cleanup

The transport selects PEAP only. In `none` mode, the SDK receives no EAP CA and
does not use its EAP CA bundle, selecting its unverified-server behavior. The
time-check flag alone is not the mechanism that selects this mode. The UI
clearly warns that a fake authentication server may obtain enterprise account
credentials, without adding a separate approval popup. This restores the
user-confirmed behavior when no CA is available.

In `ca` mode the network owner supplies the EAP CA and expected server hostname,
enables certificate date checking and installs fresh trusted physical-USB time
before Wi-Fi starts. Chain, hostname and validity checks are mandatory in that
mode. The expected hostname is a peer identity constraint, not an alternate
MQTT or API endpoint. The transport's zero-valued verification enum retains CA
verification for existing callers; the USB flow selects `none` explicitly.

EAP CA material belongs only to Wi-Fi authentication. The fixed production MQTT
broker continues to use the public CA bundle; EAP material cannot override it
or populate the diagnostic HTTPS `server_ca_pem` field. Production still rejects
custom broker/HTTPS trust. Explicit nonproduction HTTPS diagnostics retain their
separately authorized trust configuration.
Neither EAP mode weakens MQTT, HTTPS, Cloudflare service authentication or signed
clock verification.

Owned credential buffers are cleared after confirmed teardown. If network stop
is unconfirmed, borrowed EAP CA storage remains alive until confirmed stop to
avoid releasing memory the SDK may still reference. This cleanup contract does
not claim that every SDK heap copy has been zeroed.

## Manual recovery and saved startup

Manual USB PEAP remains available: the administrator page and T-Energy bounded
flow support one to three windows. Waveshare retains its separately bounded
host-trial window contract. The temporary run uses the fresh physical-USB clock
and never persists EAP credentials or trust material into a startup profile.

PEAP save/autostart is separately rejected in both verification modes. The
unchanged persistent profile does not store the verification choice or trust
material, and the boot path does not implement saved PEAP. A verified cold boot
also needs trusted time before RADIUS authentication. The missing pre-network
clock is not a reason to prohibit the `none` mode: its persistence and boot-path
support are independently unfinished. Enabling saved PEAP requires an explicit
profile/boot design and separate validation.

Open/personal profiles still support explicit saved startup and signed-clock
recovery. `V3 START ACCEPTED` means frame admission; only `V3 STARTUP SAVED`
confirms committed/read-back startup state after a real applied ACK. Existing
saved-profile validation, administrator grants, storage budgets and safe-restart
rules remain in [persistent startup](../specs/v3-startup.md).

## Local credential reuse and recovery

`V3 HELLO` reports independent `credential_state` and `mqtt_state` values:
`ready`, `missing` or `unavailable`. It never returns a bearer, password, token
hash or MQTT secret. An older HELLO without these fields is unknown, not proof
of absence. Readiness only describes locally usable material; it does not prove
that network authentication, cloud authorization or deployment will succeed.

For an already registered same-node device, the browser defaults to local reuse
when the corresponding state is `ready`. `V3START` explicitly sends
`reuse_saved_credential:true` with `device_token` omitted, and/or
`reuse_saved_mqtt:true` with all four MQTT fields omitted. Node, boot and
readiness are checked again before START. Reuse is restricted to canonical
`CP_API_ORIGIN` and native production MQTT; saved secrets cannot be sent to an
isolated HTTPS destination. Fresh registration uses the newly returned secrets,
without falling back to an old stored slot.

The device prefers a valid selected V3 startup profile. Only a genuinely absent
V3 store permits read-only legacy credential fallback. Corrupt data, a bad or
missing selector in a nonempty store, a missing selected blob, a different node
or an I/O error produce `unavailable`; the device never promotes an inactive
slot. Only the device bearer and MQTT fields are copied for reuse, not old SSID,
password, EAP trust or other network fields. No store write or migration occurs.

The two readiness states are independent. A ready device bearer with missing
MQTT material can reuse the bearer and recover MQTT through the protected
administrator endpoint. The server stores only a hash of the original device
bearer and cannot recover it; its encrypted MQTT registry has a different
recovery capability. Missing/unavailable/unknown material keeps manual backup
and recovery actions available, without automatic credential rotation or making
every returning operator enter credentials again.

## Scoped local verification

The optional-verification and credential-reuse correction has local software
checks for browser/host contracts, simulated USB interaction, strict CA parsing
and cryptographic negatives, and saved-credential selection/fault handling.
The final local repository suite passed 93 files / 1,229 tests, and the
production frontend build passed. The browser exercised local-only reuse,
explicit server-MQTT recovery and failure-source latches; its 35 serial unit
cases also passed. T-Energy completed its full host chain, including 23,404
parser checks and 43 CLI cases; Waveshare CLI and parser checks passed. Both
S3 application builds passed. These suites overlap and are not additive.
Publication must be confirmed by the actual release workflow. No new flash or
real PEAP wireless handshake has been performed for this correction.

### Earlier mandatory-CA repair snapshot — superseded policy

The earlier repair reported the following local checks before the user corrected
its mandatory-CA policy. These retain their original scope and do not establish
verification of the subsequent optional-mode/reuse changes:

- The complete repository suite: 93 files / 1,223 tests, plus the production
  frontend build. These include existing V3 identity, startup and custody checks.
- Real Chromium administrator USB interactions for open, personal and PEAP,
  including the startup UI and manual-only PEAP gate, with a simulated USB peer;
  36 JavaScript unit cases and the frontend production build.
- T-Energy parser/UART host checks, including 23,392 parser assertions, and
  40 Python host-tool cases; Waveshare 33 host cases and 11 CLI cases.
- Actual host mbedTLS 3.x parsing and chain verification under ASan/UBSan, with
  synthetic certificates: valid trust, wrong CA, wrong hostname, expired/future
  leaf and expired/future CA cases. These exercise real cryptographic checks,
  not a mocked certificate verifier or a PEAP wireless handshake.
- Fresh ESP-IDF 5.5.3 builds and image validation for both S3 applications.
  Final coordinator integration and the full T-Energy host chain also passed,
  including owned CA lifetime, failed-stop preservation, MQTT boot/mode binding
  and the unchanged closed runtime gate.

Browser USB behavior uses a test peer; host fixtures and certificate chains are
synthetic. None of these checks establishes actual RADIUS interoperability,
wireless coverage, certificate behavior on a deployed access point, saved-profile
cold boot, arbitrary power-loss recovery or production publication. No actual
SSID, device address, password, private certificate or capture is recorded here.

# V3 USB Wi-Fi authentication repair — 2026-11-03

Status: local implementation and scoped software verification. Publication needs
the actual release CI/CD result. No serial port was opened, no hardware was
flashed, and no real PEAP wireless handshake or new hardware acceptance was
performed for this repair. Earlier physical results retain their original
firmware, network and time scope.

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
| PEAP `eap_ca_pem` | Exactly one real PEM X.509 CA certificate, at most 4096 bytes; Basic Constraints must assert CA, and Key Usage must permit certificate signing if present |
| PEAP `eap_domain` | One DNS hostname, at most 253 characters, with 1–63-character labels; a single label such as `radius` is allowed; IP literals, URLs, wildcards and lists are rejected |

Printable ASCII means byte values 0x20–0x7e. SSID and credential byte lengths
therefore equal character lengths in the current browser/CLI/firmware contract.
This path does not admit arbitrary UTF-8 SSIDs or credentials. PEM uses its
restricted ASCII certificate envelope and line endings instead of the credential
text rule. Open/personal inputs reject EAP fields, and PEAP rejects a nonempty
personal password. Mode changes discard stale mode-specific form fields.

The browser checks lengths, field combinations and PEM structure. Those checks
are not X.509 authentication. The host preflight uses `cryptography` to parse a
real CA; the firmware/shared validator uses actual mbedTLS X.509 parsing, rejects
multiple certificates or trailing material, and checks the CA properties above.
Successful local CA parsing does not itself authenticate a remote RADIUS server.

## Authentication, clocks and cleanup

The network owner supplies the explicit EAP CA and expected server hostname,
selects PEAP only and sets `esp_eap_client_set_disable_time_check(false)`.
Fresh trusted physical-USB time must be installed before Wi-Fi starts, so the
server certificate chain, hostname and validity interval can be checked during
authentication. No certificate/time bypass is introduced. The expected hostname
is a peer identity constraint, not an alternate MQTT or API endpoint.

EAP CA material belongs only to Wi-Fi authentication. The fixed production MQTT
broker continues to use the public CA bundle; EAP material cannot override it
or populate the diagnostic HTTPS `server_ca_pem` field. Production still rejects
custom broker/HTTPS trust. Explicit nonproduction HTTPS diagnostics retain their
separately authorized trust configuration.

Owned credential buffers are cleared after confirmed teardown. If network stop
is unconfirmed, borrowed EAP CA storage remains alive until confirmed stop to
avoid releasing memory the SDK may still reference. This cleanup contract does
not claim that every SDK heap copy has been zeroed.

## Manual recovery and saved startup

Manual USB PEAP remains available: the administrator page and T-Energy bounded
flow support one to three windows. Waveshare retains its separately bounded
host-trial window contract. The temporary run uses the fresh physical-USB clock
and never persists EAP credentials or trust material into a startup profile.

PEAP save/autostart is separately rejected. Cold boot cannot currently obtain
trusted time before RADIUS authentication, so it cannot safely bootstrap the
network needed for signed-clock recovery. This restriction does not remove the
manual USB path or permit weakening certificate checks. A pre-network trusted
clock design and separate validation are required before enabling saved PEAP.

Open/personal profiles still support explicit saved startup and signed-clock
recovery. `V3 START ACCEPTED` means frame admission; only `V3 STARTUP SAVED`
confirms committed/read-back startup state after a real applied ACK. Existing
saved-profile validation, administrator grants, storage budgets and safe-restart
rules remain in [persistent startup](../specs/v3-startup.md).

## Scoped local verification

The integration checks for this repair cover:

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

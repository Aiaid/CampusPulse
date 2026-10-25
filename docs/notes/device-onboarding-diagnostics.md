# Device onboarding, configuration edits and network diagnostics

Status: implementation and verification in progress, 2026-10-25. This follows
the reported failed connection on the Passport running `cp-3fc2ec917f52`.
It does not establish the original network failure's exact cause.

## Observed failure and evidence boundary

The user confirmed a 2.4 GHz WPA2 personal target network. Chrome held the
physical USB port; the user released it for inspection. Opening that port with
pyserial's prior `dtr=False, rts=False` setup produced
`rst:0x15 (USB_UART_CHIP_RESET)`, application initialization, an initial
`session_busy`, then `waiting` with approximately 299 seconds remaining.
A separate passive open, without sending any application command or explicit
reset, also captured that reset reason. The former failed attempt's RAM-only
status was therefore unavailable; no Wi-Fi disconnect reason or IP event was
recovered. Do not infer a wrong password, blocked NTP or rejected credential
from this lost scene.

The installed official ESP-IDF monitor uses another no-reset opening sequence:
pre-assert DTR/RTS, open, release RTS first, then release DTR. One controlled
comparison on this Mac/Passport captured zero boot bytes over eight seconds and
returned the existing session with about 97 seconds remaining. This is evidence
for that pyserial path, not proof that Chromium's `port.open()` always resets.
The local physical smoke helper now uses the monitor sequence. See the
[official monitor source](https://github.com/espressif/esp-idf-monitor/blob/master/esp_idf_monitor/base/serial_reader.py),
[pyserial opening caveat](https://pyserial.readthedocs.io/en/latest/pyserial_api.html#serial.Serial.open)
and [C3 technical reference](https://documentation.espressif.com/esp32-c3_technical_reference_manual_en.pdf).

A minimal read-only cloud-registry query could not run under the host's current
Cloudflare authorization (provider error 7403). This was a management API error,
not an observed response from the device's HTTPS request. No registry row,
credential or production observation was modified. Raw serial/query material
stays ignored and private under `captures/network-debug-*`.

## Registration and reconfiguration

A factory node has one cloud identity. Initial registration creates its independent
`cpd_` credential once; duplicate registration is a conflict, not an instruction
to replace its identity. Reconfiguring Wi-Fi must retain that identity, placement
and valid desired capture policy by default.

The wizard first reads the physical factory identity, then explicitly inspects
cloud enrollment. Only the API's specific unknown-device 404 permits the new
registration branch. Network/auth/API failures must not be treated as absence.
A lost registration reply requires reconciliation, never a blind second POST.
An existing credential cannot be recovered from the server. An already-enrolled
physical device may explicitly reuse its validated saved credential in RAM,
without returning that secret to the browser. When a verified USB/BLE device
explicitly reports no saved credential, the network form offers one explicit
"reauthorize and connect" action instead of requiring a manually copied key.
Its adjacent notice explains that the old credential becomes invalid; the
existing administrator reauthentication and rotation endpoint remain in force.
Saved credentials use the internal reuse path without rotation. Unknown/old
firmware cannot claim this recovery capability; backup-key entry stays under
advanced options.

Before issuing a replacement, the form validates the Wi-Fi fields and the exact
escaped local payload length (496 BLE plaintext bytes or 1024 USB JSON bytes).
The recovery helper rereads the same physical identity, supported transport,
configurable session state, cloud enabled state and current desired config
before each actual POST, including after an administrator reauthentication
dialog. If the device now has a saved credential, it reuses it instead. A
returned replacement stays only in wizard memory and is retained through a
local preflight or network-validation failure; those retries never issue again.
A lost/malformed issuance reply is uncertain and blocks another automatic
issuance in that wizard. Only an explicit server reauthentication rejection can
be retried automatically, after repeating the readiness checks.

Local submission, successful Wi-Fi validation, saved settings, cloud contact and
fresh configuration ACK are separate states. A fresh heartbeat cannot turn an
older applied ACK into proof of the current reconfiguration.

## Direct position and policy edits

### Prepared settings stay editable

The setup wizard now behaves as a settings form: it loads the desired location
and dataset, including values from an expired policy, and keeps them editable
after Save. Saving changed values makes them the current desired settings;
unchanged valid values cause no write. Existing scan, raw-capture, summary,
upload, identity and retention choices survive location/dataset edits. The
server keeps historical references internally without making the operator
choose a version-management workflow.

Cloud settings can be saved without a device credential, and Wi-Fi can be
entered before credentials or a physical connection are ready. Only sending
to the device requires its matching identity, usable credential and currently
valid saved configuration. Missing prerequisites have visible explanations.
An in-flight or uncertain device submission temporarily locks changes; an old
failure with another attempt ID cannot unlock it. After confirmed completion,
the operator can modify settings again and explicitly start another network
write. USB refreshes the same port; BLE asks for the new on-device PIN.
Generating an AP handoff alone does not claim that the device accepted it or
lock the form; editing its configuration clears the generated handoff.

Local Chromium/WebKit regression covers repeated edits/saves, no-op saves,
editing before credential readiness, expired-policy renewal, external changes,
lost replies, stale status correlation and editing after applied confirmation.
This is browser acceptance with synthetic peers, not another physical-network
acceptance claim.

### Full capture configuration editor

The UI adds direct editing and publishing of a new version, including v2 address
summary/control fields, bounded raw capture, and a device-detail entry for
Wi-Fi reconfiguration. Existing values prefill the form; history and already
queued observations retain their original version/placement references.

The current API registers placement and publishes configuration in separate
transactions. A successful placement write can close the prior open interval
before publication succeeds. The form reports this intermediate state and
retains fixed IDs for read-before-retry recovery; it does not claim cross-API
atomicity or device application. A new version is desired until a matching
applied ACK arrives.

## Network diagnostics and remaining verification

### Asynchronous transport repair and timing evidence

Source review of the pinned ESP-IDF 5.5.3 identified two transport defects relevant
to this diagnosis: asynchronous connect failures did not copy the internal TLS
error into the transport error handle, and nonblocking SSL read waits could
return zero without `EAGAIN`. The HTTP body path then treated a normal one-second
poll gap as an incomplete response instead of yielding to the next poll. The
build-local, fingerprint-checked repair fixes these paths and a socket-lookup
failure's duplicate cleanup risk. CA, hostname and certificate-date checks remain
strict. Actual generated-function ASan/UBSan tests cover these behaviors.

The 90-second elapsed figure belongs to the entire candidate-validation budget,
which can contain repeated 12-second requests; it is not evidence of one
90-second TLS handshake. Deadline finalization now preserves a currently observed
specific failure. Allocation failures report `resource_exhausted` immediately
instead of leaving an old TLS stage to time out. Numeric-only logs expose socket
errno, TLS errors, internal free/largest heap and request elapsed time. Collector
startup failures likewise retain their error and a numeric failure phase.
No retained-record layout change is needed; the new error enum is appended.

On the newly selected enterprise network, the connected Passport reported an
initial saved validation with HTTP 200 after 14.771 seconds and a software reboot.
A later read showed repeated post-boot HTTP-connect errors, with the settings
still saved. This establishes that initial TLS succeeded on that network; it does
not establish continuous upload or identify the cause on the earlier network.
Sanitized, ignored evidence stores only numeric/error/state fields, not raw UART,
SSID, enterprise identity, password, nonce or credential values. Physical repair
acceptance is tracked separately from these source findings.

With `cp-3ced53455c1e` on that same saved network, a sanitized 90-second
boot trace showed three successful HTTP 200 contact requests, interleaved with
two following TLS-stage request deadlines at about 12 seconds. The minimum
8-bit heap reached 2,636 bytes. This identifies severe memory pressure alongside
the timeouts; it does not prove an allocator failure or a radio conflict.
The response adapter now allocates only after positive response data arrives,
starting at 256 bytes and growing up to the existing 8,193-byte bound. Contact,
configuration, activation and upload requests therefore no longer reserve an
8 KB body buffer during TLS setup. Allocation failure preserves the old buffer
for cleanup and reports `resource_exhausted`; ASan/UBSan tests inject every growth
failure and cover size, deadline and cancellation bounds. Device acceptance of
this memory change initially progressed as follows: `cp-6eea874e246c` received
both contact and desired-config HTTP 200 responses, with a minimum heap of
11,180 bytes before BLE initialization. BLE host initialization then returned
`ESP_FAIL`; subsequent TLS attempts reported `MBEDTLS_ERR_SSL_ALLOC_FAILED`
(`0x7F00`) with a largest free internal block of only 13,312 bytes. This proves
TLS allocation failure in this post-startup state, rather than a certificate
rejection. It does not identify the exact failed BLE allocation.

The Passport defaults disable the two Wi-Fi IRAM throughput optimizations so
their shared D/IRAM becomes available for heap allocations. Three actual pinned
C3 headless builds measured 11,264 additional bytes with RX optimization off and
18,944 with both off; data/BSS sizes stayed identical. These are link-map gains,
not an independently measured throughput or radio-coverage result. BLE startup
logs retain numeric controller state and before/after free/largest/minimum heap.
TLS SSL-allocation failures now report `resource_exhausted` and increment a
boot-lifetime counter, retained through network restarts. Each request clears
stale HTTP/TLS details before starting so a previous HTTP 200 does not appear as
the current handshake's result.

### Automatic RAM-pressure protection

The allocation-free guard measures internal byte-addressable free RAM and its
largest contiguous block, separately from Flash queue pressure. These initial
Passport thresholds are engineering guardrails, not a measured radio-capacity
claim:

| Action | Free / largest internal block | Timing |
| --- | --- | --- |
| Pause optional raw samples | Below 32 / 18 KiB, either limit | 2 seconds idle |
| Resume raw samples | At least 36 / 20 KiB, both limits | 10 seconds healthy idle |
| Stop scan and release BLE | Below 24 / 16 KiB, either limit | 5 seconds idle |
| Admit BLE startup/recovery | At least 56 / 24 KiB, both limits | Recovery also needs 30-second cooldown and 10 seconds healthy idle |

An in-flight HTTPS request breaks sustained low-pressure intervals and pauses
healthy-idle recovery accounting; normal TLS temporary allocations therefore do
not alone trigger a pause. Healthy idle time accumulates across requests, while
an unhealthy idle sample resets it. A new
explicit network allocation-exhaustion event after client cleanup can force a
scan pause. Recovery requires a fresh valid desired-policy response after the
pause and an unexpired lease. The guard preserves the server's desired sampling
and window configuration rather than silently rewriting it. It seals actual
partial windows and resumes at a new time origin, leaving the pause visible as
an observation gap.

`node_status` reports `memory_pressure` or `memory_raw_pressure` as the pause
reason, and reports raw capture as paused when suppression is active. Paused
devices continue periodic status attempts and retain frozen batches for normal
durable ACK handling. The administrator page translates both memory reasons.
After a failed partial SDK BLE initialization, another BLE initialization is
blocked for that boot because generic deinitialization is unsafe. USB/AP setup
remains available; BLE setup reports that a manual restart is required. No
automatic restart, credential change or Flash erase is introduced.

Host tests exercise pressure duration, fragmentation, TLS exclusion, hysteresis,
cooldown, fresh-policy/lease boundaries, SDK retry prevention and USB recovery.
Physical acceptance and tuned threshold performance remain separate.

The first three-minute run of `cp-194d461feb09` recorded 17 HTTP 200 results,
three 12-second request deadlines and a minimum free heap of 25,908 bytes.
Its initial 28 KiB contiguous startup requirement refused BLE despite about
70 KiB total free and 26 KiB largest blocks. Startup/recovery admission is now
24 KiB contiguous, retaining the separate 56 KiB total-free requirement. A
nonblocking claim on the existing HTTP resource serializes BLE initialization
against TLS allocation; the policy is rechecked under that claim. Contention
does not consume the desired-policy sequence or create a false failure ACK.
All claims release before activation reporting, avoiding recursive mutex use.
HTTP completion evidence identifies only numeric request kinds and bounded
response sizes, enabling contact/config/activation/ingestion to be distinguished
without logging their content or credentials. This correction still requires
its own physical acceptance.

The `cp-d4204cafe753` run established the next boundary: BLE initialization
succeeded with 72,864 internal bytes available, but consumed 60,060 bytes before
host/collector task stacks. The collector task allocation failed and normal
teardown restored about 73 KB, followed by successful contact/config/activation
and ingestion HTTP 200 responses. This proves status delivery and safe pressure
teardown, not successful observation collection.

The subsequent fixed-budget correction reduces two display DMA stripes from
15,360 to 3,840 bytes and uses smaller single-connection NimBLE pools, three
controller activities and six static Wi-Fi RX buffers. Advertising-report event
capacity and packet sizes remain unchanged. The pinned SDK's global dynamic TLS
record buffers are enabled for enterprise Wi-Fi and HTTPS, retaining full 16 KB
incoming and 4 KB outgoing limits; certificate/key ownership and verification
remain unchanged. The independent enterprise handshake cleanup option releases
used CA/DHM/key data where applicable, not the record buffers by itself. Task
stack sizes are retained, and numeric high-watermarks provide evidence for any
later stack tuning. The idle recovery timer now accumulates healthy idle time
across HTTP requests so frequent cloud work cannot indefinitely prevent recovery.
An actual-raster ASan/UBSan regression also catches an existing cross-call DMA
buffer reuse problem, preserving ping-pong phase across odd-stripe renders.

### Network authentication modes

The administrator wizard and device-hosted setup page explicitly select WPA2
personal, open Wi-Fi, or WPA2 Enterprise PEAP/MSCHAPv2. An empty personal-network
password remains invalid; it never silently downgrades to open. Enterprise
configuration takes a username, password and optional outer identity (defaults
to username). These values travel only over the selected local provisioning
transport and are excluded from cloud API bodies and retained diagnostics.
Firmware advertises the supported modes so older devices cannot appear to
accept unsupported settings. Long enterprise payloads can exceed BLE's 496-byte
plaintext limit; use USB or the device-hosted page in that case.

At the user's explicit request, enterprise authentication clears the RADIUS CA
and disables the EAP default certificate bundle and certificate time checking.
This setting is confined to the EAP client. The independent HTTPS upload client
still validates its CA chain, hostname and certificate dates. See the
[Espressif EAP API](https://docs.espressif.com/projects/esp-idf/en/v5.3.1/esp32/api-reference/network/esp_wifi.html).
Captive-portal browser login, EAP-TLS client certificates and TTLS are not
implemented by this selection.

Settings format v2 appends the authentication mode and EAP fields. The exact
376-byte v1 settings layout loads as personal WPA2 in RAM without a Flash
rewrite. Only a successfully validated explicit candidate is saved in v2 via
the existing two-slot path. No migration erases NVS, the capture queue or cardid.

### Failure progress

The former firmware has one SNTP source, a 45-second overall validation window,
30-second cloud contact retries, and a final generic `network_or_auth_failed`.
These are confirmed diagnostic/flow limitations, not proof of the reported
network's particular failure. Candidate network authentication and capture
policy compatibility also need separate outcomes.

The revision adds bounded stages and fixed safe error codes for association,
DHCP, clock, DNS, TLS, cloud authentication, settings save and recovery. TLS chain,
hostname and certificate-date validation stay enabled. Failure/history fields
must survive transport teardown and identify a new boot instead of presenting
new `waiting` as proof that the old attempt did not fail. Only bounded numeric
errors, stages and attempt/boot correlation belong in retained diagnostics;
never SSIDs, MACs, passwords, nonces or device/admin credentials. Polling must
not write Flash. Persistence failure must not erase old settings or silently
convert a successful network/settings operation into success/failure elsewhere.

Final acceptance must distinguish native/module tests, simulated browser tests,
C3 builds, physical USB inspection, and the user's actual network retry. A new
browser handshake may retry bounded `begin`/`info` on the same connection;
a configure timeout must retain its credential/attempt and inspect status,
not automatically resend or rotate. Physical network attribution remains pending
until the diagnostic firmware observes another real attempt.

Verified locally on 2026-10-25:

- The full firmware chain passes ASan/UBSan, including 26 runtime scenarios,
  actual provisioning-module open/PEAP validation and credential-generation
  binding, safe diagnostic history encoding and corrupt/write-failure recovery.
  Pinned Security2 SDK interoperability and firmware-produced uploads against
  ephemeral workerd/D1/R2 also pass.
- Normal and headless ESP32-C3 builds pass. Separate-image validation preserves
  the existing 3 MiB app, cardid and queue layout. A build proves neither network
  authentication nor radio completeness.
- Web unit tests pass (505 tests in 50 files, excluding the unrelated untracked
  ingestion-audit test) and the production build passes. Chromium provisioning
  covers open/enterprise credentials, optional outer identity, old-firmware
  capability gates and local-only secret handling. WebKit also exercises the
  embedded setup page's open/enterprise branches. Configuration editing passes desktop
  and 390 px Chromium tests using synthetic API fixtures. These tests do not
  establish production authentication or successful physical PEAP association.

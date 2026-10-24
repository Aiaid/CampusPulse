# Device-local provisioning

This component is an exclusive radio boot mode for the AI Passport baseline.
The application supervisor owns mode selection, displayed setup proof, candidate
validation, durable settings and reboot. The BLE scanner must not run concurrently.
No hardware was flashed or exercised as part of the implementation tests.

## BLE

- ESP-IDF 5.5.3 `protocomm_ble` uses the configured NimBLE host. The component
  does not register another NimBLE host, release Bluetooth memory, or enable SMP.
- `protocomm_security1` authenticates possession of a random 32-hex setup proof
  before application exchanges. It uses the official X25519/SHA-256/AES-CTR
  protocol; there is no Security 0 fallback. This protocol is stream encryption,
  not AES-GCM. Do not describe it as authenticated encryption of each message.
- Service: `f0c00000-7b3a-4f1d-a848-8baf42c67a01`; session characteristic:
  `f0c0ff51-7b3a-4f1d-a848-8baf42c67a01`; protected application characteristic:
  `f0c0ff52-7b3a-4f1d-a848-8baf42c67a01`. Each request is a write-with-response,
  then a read; one request is outstanding at a time. The browser rejects payloads
  over 512 bytes and closes the session after a transport/protocol error.
- Inside the encrypted application endpoint, JSON has `v:1` and `op:info`,
  `op:status` or `op:configure`. Info identifies the factory-derived `cp_` node,
  never the browser's opaque `BluetoothDevice.id`.
- Configure fields: `node_id`, `attempt_id` (UUID), `ssid`, `password`,
  `device_token`. Attempt IDs must be lowercase UUIDv4. An accepted attempt
  retains a SHA-256 digest of explicit length-prefixed settings fields; an exact
  retry returns its existing status while changed settings under the same ID
  are rejected. The only accepted cloud credential is the independent `cpd_`
  device credential. API origin is fixed by `cp_settings`; clients cannot set it.

## Safari / iOS fallback

The device creates a temporary WPA2 personal hotspot with a 32-hex password,
one client, and an HTTP page at `http://192.168.4.1`. This fallback relies
on the WPA2 link, not HTTP TLS or WebCrypto on an insecure origin. It is a distinct
local form, not a plaintext protocomm Security 0 endpoint.

The exact embedded ASCII page has no external assets or cloud requests. Users
copy the node-bound enrollment handoff from the HTTPS administrator page, then
enter the target network password locally. It checks the local node before
submitting. Device requests require a fixed Host, same origin when supplied,
JSON content type, per-session nonce, and device setup proof. The AP password and nonce are
separately domain-labeled HMAC-SHA256 outputs keyed by the persistent setup
proof, truncated to 128 bits. Random bytes, monotonic time and a per-boot session
counter form the context. RF-off random bytes are treated only as variation,
not as an independent source of true entropy; secrecy depends on the proof
generated with an actual entropy source. Eight failed
proofs lock the session; all requests expire after ten minutes. Bodies are limited
to 1024 bytes and JSON nesting is bounded before recursive parsing. Responses
never contain Wi-Fi passwords, cloud credentials, or setup proof. The page clears
sensitive form fields on acceptance and page exit. No cloud CSP exception exists.

Only WPA2 personal target networks are supported by this settings/network slice.
Enterprise/PEAP and open networks are explicitly unsupported in the UI.

## Supervisor contract

`cp_provision_start(mode,node_id,proof,submit,ctx)` requires a factory-random
per-device setup proof supplied by the application, shown locally. Never derive
it from a MAC or compile a global password. The submission callback copies the
candidate and attempt ID to its worker queue and returns promptly. It must not
perform Wi-Fi, TLS or NVS operations in the transport task.

The `received` response confirms only that the supervisor accepted the candidate
in RAM. Allow time for the final write/read or HTTP response (at least one second)
before stopping provisioning. `cp_provision_stop()` stops HTTP/BLE/AP and destroys
its Wi-Fi resources without freeing Bluetooth memory. Check its returned error
before starting another radio owner. A failed BLE teardown is latched until
reboot because IDF can free its transport bookkeeping despite a stop failure;
controller IDLE is also verified to catch an ignored deinit failure. The supervisor then tests
Wi-Fi/time/TLS/cloud authentication, saves settings only on success, and reboots
into normal mode. On failure it retains existing settings and reports the reason
on the board. A disconnected BLE link or vanished hotspot is not success.

The administrator wizard distinguishes registration, desired policy, fresh cloud
contact, and an applied ACK for that policy. Lost registration responses trigger
read-only reconciliation and require a saved credential or an explicit user
credential rotation; neither retries nor polling silently rotate credentials.

## Verification and provenance

The code is a new CampusPulse implementation using the installed ESP-IDF APIs.
Protocol field definitions and session behavior are based on ESP-IDF v5.5.3
`components/protocomm/proto/session.proto`, `sec1.proto`, and the Apache-2.0
reference client `tools/esp_prov/security/security1.py`. No SDK implementation is
vendored here. See the [official protocomm documentation](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32c3/api-reference/provisioning/protocomm.html).

- `npx vitest run tests/provisioning/security1.test.js`: eight tests, including
  exact handshake vectors generated by the official Python client, continuous
  CTR partial-block interoperability, rejection paths, synthetic GATT, published
  config validation and fresh-applied state boundaries.
- `node scripts/provisioning-browser-smoke.mjs`: a temporary local Vite server
  (port 18879, fails rather than taking an occupied port), synthetic cloud and
  GATT only. Chromium drives the actual administrator UI, checks synchronous
  chooser activation, encrypted settings, credential/body/storage boundaries,
  publication, ACK and lost-response recovery. WebKit drives the exact embedded
  device page when its test runtime is installed.
- `bash tests/provisioning/host/run.sh`: native C guard tests check UUIDv4
  rejection, independent HMAC vectors, key/context/domain separation and
  complete settings digest binding (including length framing and padding
  independence). The host crypto adapter uses OpenSSL; firmware uses mbedTLS.
- Component compilation was checked against actual ESP-IDF 5.5.3 RISC-V headers
  and compiler. Integrated firmware build is the supervisor's acceptance gate.
- These checks do not validate physical Bluetooth, ATT behavior on particular
  phones, hotspot connectivity, flash persistence, real network credentials,
  RF completeness, battery use, or hardware acceptance.

Regenerate the public synthetic fixture with an installed IDF checkout:

```sh
IDF_PATH=/path/to/esp-idf-v5.5.3 uv run --no-project --with protobuf --with cryptography \
  tests/provisioning/idf-security1-fixture.py > tests/provisioning/idf-security1-fixture.json
```

The fixture's deterministic keys and proof are test inputs, not device secrets.

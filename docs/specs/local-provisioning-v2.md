# Local provisioning: short PIN and physical USB

Status: implemented and locally verified, 2026-10-25; physical USB/enrollment
acceptance remains separate. This replaces manual entry of the
32-hex setup proof in the normal local onboarding flow. Cloud ingestion remains
`campuspulse/2`; this document changes local transport/authentication only.

## Display-equipped nodes

- Display eight ASCII digits, preserving leading zeros; grouping is presentation
  only. The PIN lasts five minutes and is regenerated on an explicit new setup
  session. Five authentication failures across connections lock that session.
- BLE uses the installed ESP-IDF 5.5.3 protocomm Security 2 (SRP6a/AES-GCM), with
  public username `campuspulse`. There is no downgrade from a numeric PIN to
  Security 1 or Security 0. The two existing GATT characteristic UUIDs remain.
- The persistent 128-bit setup secret remains internal. It seeds domain-separated
  session material; it is neither the displayed PIN nor a public MAC-derived key.
- Device-hotspot setup retains a separate strong password, presented as twelve
  unambiguous base32 characters. The local HTTP page checks the short PIN,
  per-session nonce, Host/origin and bounded attempts; it remains local to WPA2.

## USB, including headless nodes

The physical USB console is a local trusted provisioning channel. Selecting USB
in the administrator wizard needs no screen or manually typed PIN. It still
uses factory node identity and an independently issued cloud device credential.
Connecting a cable alone does not grant cloud identity or start collection.

Framing on the existing console is:

```text
<RS>CPSETUP/1 <lowercase UUIDv4 request id> <one JSON object>\n
```

`RS` is byte `0x1e`. Both directions echo the request id, use UTF-8, limit JSON
payloads to 1024 bytes and discard unrelated console logs. One request is pending
per browser connection. The USB task bounds its input buffer and never logs or
reflects received credentials.

- `{"v":1,"op":"begin"}` queues entry into exclusive USB setup; it returns an
  acknowledgement of queuing, not successful enrollment.
- `info` returns factory `node_id`, board/firmware identity, transport `usb` and a
  fresh local-session nonce only once USB setup is ready.
- `status` returns bounded current validation state; it contains no PIN, password,
  internal setup secret or device credential.
- `configure` carries the existing flat v1 candidate fields (`node_id`,
  `attempt_id`, `ssid`, `password`, `device_token`) plus the USB session nonce.
  It copies into the controller queue; Wi-Fi/TLS/NVS stay outside transport tasks.

The framing adapter handles `begin` through `cp_runtime_request_setup`. The
public provisioning boundary gains mode `CP_PROVISION_USB = 2` and
`cp_provision_usb_exchange(request, length, response, response_length)`; response
ownership transfers to the caller. The existing start argument remains the
internal 32-hex master secret. Snapshot `proof` now represents only the displayed
eight-digit PIN; a `setup_usb` view flag labels USB setup without showing a PIN.

The USB console remains available while candidate validation stops the setup
radio owner. Successful validation is saved atomically before reboot; failures
retain the previous enrollment and expose a retryable local status. Attempt IDs
remain bound to the complete candidate digest. USB command handling never erases
NVS, `cardid`, pending journal records or the whole Flash.

The info response uses `firmware_version` for the running ESP application
version and `security: "physical-usb"` for USB. BLE reports
`security: "security2"`. The nonce is returned only by USB `info`, and is
required by USB `configure`; `status` never returns it. A session's factory
identity is checked before the wizard reuses its one-time cloud credential.

An unenrolled profile without display capability waits for explicit USB setup.
The USB worker still starts on enrolled nodes for local recovery. Entering setup
stops collection/network through the same ownership controller; it does not
automatically clear saved enrollment or authorize new cloud identity.

Web Serial support is detected at runtime. Unsupported phone/browser contexts
must explain the supported display/hotspot or desktop USB route. Driver/profile
support for other boards remains separate from this transport abstraction.
The desktop Chromium route follows the
[Chrome Web Serial documentation](https://developer.chrome.com/docs/capabilities/serial).
[WebKit's published position](https://webkit.org/standards-positions/)
opposes Web Serial; that position itself is not an implementation-status test,
so the UI checks actual APIs rather than inferring support from a browser name.

## Verification gates

Use official pinned Security 2 client/server fixtures for both proofs and
encrypted application data; include wrong PIN, stale/expired sessions and lockout.
Check real controller save/failure/reboot ordering, bounded USB parsing and
credential separation. Browser mock transports do not establish physical BLE,
USB chooser behavior or real Wi-Fi acceptance. Rebuild and separately verify
the Passport images; preserve existing setup/enrollment and protected partitions
when updating the connected device.

The implementation checks original SDK fingerprints and applies a generated
build-only correction aligning Security 2's private IV array. Compile-time
assertions keep the wire nonce at 12 bytes. Fixed-width salt/verifier generation
avoids a separate SDK helper's leading-zero conversion. The installed SDK and
the SRP/GCM wire algorithms remain unchanged. See the
[component verification notes](../../firmware/components/cp_provision/README.md).

The physical smoke tool can exercise entry, identity/status and malformed-frame
recovery without sending a Wi-Fi password or device credential:

```sh
uv run firmware/tools/check-usb-device.py --port <explicit-port> --begin --exercise-parser
```

This changes the current local setup mode; omit `--begin` for a status-only
check. It neither registers a production node nor proves Wi-Fi/cloud acceptance.

# Device-local provisioning

The controller owns setup mode, candidate validation, durable settings and
reboot. Collection and the setup radio never own NimBLE concurrently. The
[local provisioning contract](../../../docs/specs/local-provisioning-v2.md)
defines short numeric PINs and physical USB, separate from cloud protocol v2.

## Display PIN and BLE

The screen shows eight ASCII digits, including leading zeros. A session expires
after five minutes; five failed authentication attempts across connections lock
it. Explicitly starting a new setup session resets that budget. The persistent
128-bit factory setup secret stays internal and is never displayed or returned
by an endpoint. Domain-separated HMAC derives the PIN, nonce, SRP salt and the
independent hotspot password from that secret and boot/session context. RF-off
randomness supplies variation, not the claim of true entropy.

BLE uses the pinned ESP-IDF 5.5.3 Security 2 protocol: SRP6a, SHA-512 and
patch-1 AES-256-GCM counters, with public username `campuspulse`. Security 0/1
are disabled; numeric codes are never sent through the former Security 1 flow.
The service UUID is `f0c00000-7b3a-4f1d-a848-8baf42c67a01`; the session and
protected application characteristics end in `ff51` and `ff52` respectively.
Each request is a write-with-response then a read, with one request outstanding.
Encrypted messages are at most 512 bytes, including the 16-byte GCM tag.

The wrapper validates protobuf shape, bounds, public values and session phase
before calling SDK handlers. Authentication and expiry checks share a
nonblocking session gate. Transport establishment uses its own short guard so
a concurrent status snapshot cannot lose a valid BLE connection. Security and
application endpoints are registered before advertising. Storage/network work
never runs in the application transport callback; the SDK's synchronous SRP
handshake remains a separate timing/stack measurement boundary.

Pinned SDK compatibility guards include:

- Build-time INFO logging ceiling: SDK DEBUG logs contain PIN/key material.
- Fixed 16-byte salt and standard mbedTLS verifier generation, avoiding the SDK
  helper's minimal-integer salt conversion when the salt begins with zero.
- A pinned build-time IV alignment correction, applied to a generated SDK
  translation unit. The installed SDK is unchanged; its original source hash
  must match before patching. SRP, GCM, counters and the wire schema are unchanged.
- Malformed/short ciphertext is rejected before SDK length arithmetic. A fatal
  SDK command-0 allocation/state failure quarantines that single context until
  reboot, avoiding reuse/double-free of an SDK dangling pointer. It cannot
  allocate repeated poisoned contexts in one boot.

The browser uses WebCrypto SHA-512/AES-GCM and JavaScript BigInt SRP arithmetic;
it makes no constant-time execution guarantee. Synthetic interoperability and
host timings do not establish actual phone ATT behavior or C3 timing/stack use.

## Physical USB and headless nodes

`CP_PROVISION_USB` uses the independent `cp_usb` framing/console adapter. Cable
connection starts no setup session. An explicit framed `begin` queues USB mode
through the controller. An unenrolled profile without a display waits for this
path instead of advertising a PIN it cannot show. Enrolled nodes retain USB for
local recovery.

USB `info` identifies the factory node and current application version, with
`transport: "usb"`, `security: "physical-usb"` and a local session nonce.
`configure` requires that nonce and the node identity, without a manually typed
PIN. The browser refreshes identity/nonce before transmission, including after
a failed network test. A changed factory identity closes the connection before
any candidate credential is sent.

`cp_provision_usb_exchange()` returns an allocated response to its caller, which
must clear/free it. Payloads are bounded to 1024 bytes. Status remains available
while radio setup has stopped for network validation; it returns no PIN, nonce,
hotspot password, internal secret or cloud device credential. USB RX and TX have
one owner and bounded buffers. The native driver is USB Serial/JTAG, never UART0
(which conflicts with the Passport backlight pin). Other-board backends require
independent driver/profile acceptance.

## Hotspot fallback

The device hosts a WPA2-personal hotspot with a separate 12-character
unambiguous base32 password, one client and a page at `http://192.168.4.1`.
The local form uses the eight-digit PIN and nonce, fixed Host/origin and JSON
content type, bounded scalar parsing and duplicate/NUL rejection. It relies on
the WPA2 link, not HTTP TLS. It is not a plaintext protocomm endpoint.

Users copy the node-bound cloud handoff while online, join the device hotspot,
and enter the target Wi-Fi credentials only in the device page. The page has no
external assets or cloud requests and clears its form on acceptance/page exit.
The cloud admin page never fetches arbitrary HTTP LAN endpoints or weakens CSP.
Browser API availability is detected at runtime; desktop Web Serial and the
local hotspot remain distinct routes. A PWA does not itself add a missing API.

## Shared submission and recovery

`cp_provision_start(mode,node_id,master_secret,submit,ctx)` accepts the existing
internal 32-hex master. The callback copies candidate settings and a lowercase
UUIDv4 attempt ID to the controller queue and returns promptly. It performs no
Wi-Fi, TLS or NVS work. Only independent `cpd_` device credentials are accepted;
API origin is fixed. Target networks currently support WPA2 personal, not
Enterprise/PEAP or open networks.

An accepted attempt freezes the complete length-framed settings digest. Exact
retries return the current known state; changing the body under the same ID is
rejected. `received`/`testing`/`saved` are local states, never proof of cloud
activation. The controller allows reply completion, stops setup ownership,
tests network/time/TLS/cloud authentication, atomically saves on success and
reboots. Failure keeps prior enrollment and opens a retryable setup session.
The browser retains its unique cloud credential after an uncertain response;
retrying never silently rotates it.

Check every stop error before starting another radio owner. Failed BLE teardown
is latched until reboot and controller IDLE is verified. Neither cable setup nor
these helpers erase NVS, `cardid`, journal records or the whole Flash. The wizard
requires fresh cloud contact and an applied ACK for its published configuration;
a disappeared link or saved settings alone cannot complete it.

## Verification and provenance

Run `firmware/tools/check-chain.sh` with the pinned SDK. It includes native
collector/storage/runtime/USB tests, HMAC guard tests, actual provisioning-module
concurrency/expiry tests, the SDK C interoperability peer and isolated real
workerd/D1/R2 ingestion. The peer compiles the installed SDK Security 2/SRP and
mbedTLS sources with host platform shims; it checks source fingerprints and
explicit leading-zero salt/A/hash/B cases, wrong PINs across reconnects,
malformed frames, expiry, and bidirectional GCM.

`npx vitest run tests/provisioning` covers the official Python fixture, browser
crypto, enrollment guards and bounded USB transport. The synthetic fixture's
recipe/hashes live alongside it. The former Security 1 implementation remains
in Git history. `node scripts/provisioning-browser-smoke.mjs` drives Chromium's
actual UI/WebCrypto/WebStreams with synthetic cloud/BLE/USB peers, plus the
embedded page in WebKit when installed. It owns localhost port 18879 and closes
its own processes. It does not register a production device or exercise radio.

The SDK remains Apache-2.0, with its copyright retained in generated patched
sources. No SDK algorithm is vendored into the repository. See the
[reuse record](../../../docs/notes/reuse.md) and
[firmware acceptance](../../../docs/notes/firmware-chain.md) for exact evidence.
Actual BLE, browser USB chooser, phone hotspot, Wi-Fi/cloud acceptance, sustained
capture/upload, power and memory margins require their own physical tests.

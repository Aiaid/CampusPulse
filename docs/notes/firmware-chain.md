# Passport provisioning, policy and durable upload chain

> Hardware update, 2026-10-25: one connected Passport now passes application-only
> flashing, protected-region verification and a 60-second BLE-setup startup test
> after the supervisor stack fix. See the final hardware section below. Earlier
> software-only evidence remains historical; Wi-Fi/enrollment/field-radio
> acceptance is still separate.

> Local provisioning revision: the long displayed proof and Security 1 details
> below describe the initial software snapshot. The
> [short PIN / USB contract](../specs/local-provisioning-v2.md) specifies the
> replacement; its verification is recorded separately from these earlier tests.

> The 158-file source fingerprint and four-image table below are the historical
> pre-font-replacement acceptance snapshot. Current font arrays were replaced
> on 2026-10-25 with licensed OFL derivatives. Fresh open-font release builds
> passed below; use those artifacts for publication/flashing, not the historical
> private-font binaries. See [font provenance](../../firmware/fonts/README.md).

Dates: 2026-10-24–2026-10-25. Historical snapshot status: **local software chain implemented and
verified against the frozen source; physical-device acceptance and deployment
have not been performed**.

The current Passport source connects administrator onboarding, protected local
provisioning, durable enrollment, authenticated policy control, canonical BLE
aggregation, a Flash journal and identity-checked upload receipts. This replaces
the stage-A normal-boot stub. It does not establish that a physical Passport has
joined Wi-Fi, captured all radio traffic or delivered a production observation.

The import is historical local commit `82549b0`; stage A is historical local
commit `8018d17` on `codex/passport-firmware`. During this integration the shared
working copy is on `main` at `c0bd3f6`, with firmware and related changes present
locally and not part of that commit. Do not infer branch, commit or publication
state from an older build note. On 2026-10-25 the user separately authorized
commit/push and subsequent hardware flashing. Current font data were replaced
with licensed OFL derivatives; upstream private history/captures remain excluded.
This earlier software-only acceptance does not claim those later actions occurred.

Related: [device v2 contract](../specs/device-v2.md),
[platform design](../design/firmware-platform.md),
[historical stage A](firmware-runtime.md),
[import provenance](firmware-baseline.md), [reuse record](reuse.md).

## Implemented path and ownership

| Component | Current responsibility |
| --- | --- |
| `src/admin/Provisioning.jsx` and `src/admin/provisioning/` | User-gesture device selection, protected local connection, factory identity, existing admin registration/placement/config operations, recovery and cloud-state checks |
| `cp_provision` | Exclusive BLE or SoftAP provisioning transport, possession proof, bounded local requests and RAM candidate submission |
| `cp_settings` | Per-device setup proof and validated enrollment in ordinary application NVS; two settings slots plus committed active selector |
| `cp_runtime` | Supervisor commands, single radio-owner handoff, candidate test/save/reboot, policy/lease decisions and visible state |
| `cp_network` | STA lifecycle, time bootstrap, certificate-verified HTTPS, contact, desired policy, activation retries and exact upload-response validation |
| `cp_collect` | Portable canonical `(MAC, address_type)` aggregation, bins and explicit raw-selection/loss accounting |
| `cp_pipeline` | Bounded report ingress, collector worker, JSON codecs, pressure gates and background journal uploader |
| `cp_journal` | Immutable batch bytes, commit-last Flash records, reopen validation, quarantine and reclamation after matched ACK |
| `cp_board`, `cp_esp`, `cp_ui_passport` | Factory identity, board peripherals, queued buttons, startup and optional status rendering |
| `cp_radar` | Explicit inherited diagnostic mode; its heuristic/fingerprint table is separate from canonical collection |

Normal early boot derives `cp_` plus twelve lowercase hex digits from the factory
base MAC. Before ADC/RF initialization it creates the boot UUID and, if missing,
a persistent setup proof using the ESP bootloader entropy source. It never uses a
MAC or a global firmware password as the setup secret. Optional display/input
failure is distinct from the essential network, policy and storage gates. The
normal headless image is a build target, not a complete human onboarding path:
it requires previously validated enrollment settings or an independently secured
setup-proof delivery channel. No USB provisioning workflow is implemented.

A node without saved enrollment enters BLE setup. Passport controls can select
BLE or device-hotspot setup. A configured boot starts the network/control path;
new collection requires accepted policy and successful application. The runtime
stops the previous collector/network/provisioning owner before a mode change.
Stop failures prevent the next owner from starting. BLE teardown failure is
latched until reboot because the pinned protocomm transport can discard private
state even when stopping fails; controller IDLE is checked after teardown.

The old `wifi_time.c` compile-time Wi-Fi path is not the normal platform network
owner. Diagnostics remain explicit and do not represent field collection or
cloud verification.

## Browser and device provisioning

The HTTPS admin wizard invokes `requestDevice()` synchronously from the Connect
button before awaiting cloud operations. It filters the CampusPulse service and
reads factory node identity after proof verification, rather than using the
browser's opaque `BluetoothDevice.id`.

The BLE service uses ESP-IDF 5.5.3 `protocomm_security1` and its NimBLE transport:
X25519 key exchange, proof-of-possession SHA-256 mixing and continuous AES-CTR.
WebCrypto supplies the browser cryptography; an explicit protobuf codec follows
the pinned official protocol. There is no Security 0 fallback. Security 1 is
stream encryption and possession verification, not AES-GCM or per-message AEAD.
The custom protected application endpoint carries version 1 info/status/configure
messages, separate from the cloud's `campuspulse/2` protocol.

The independent `cpd_` device bearer is obtained through the existing sensitive
admin action. Administrator, shared operator and research credentials are never
copied to the device. Wi-Fi passwords only travel from the browser to the local
device; registration/configuration cloud requests do not contain them. Secrets
stay in transient browser memory, are not put in Web Storage or analytics, and
are cleared on exit. Lost registration responses trigger read-only reconciliation
and an existing credential or an explicit user-confirmed rotation, never a blind
registration/rotation retry.

A configure request uses a lowercase UUIDv4 attempt ID. Once accepted, its
canonical length-prefixed settings digest is frozen: exact retry returns the
existing state; changed settings with the same ID are rejected. BLE requests are
bounded to 512 bytes. Target settings currently support WPA2 personal networks;
Enterprise/PEAP and open networks are explicitly unsupported.

### Safari / iOS local page

The wizard detects missing Web Bluetooth and explains the device-hotspot path.
A PWA does not supply the missing browser API. Users prepare a node-bound cloud
credential handoff while online, join the device's password-protected hotspot,
and open `http://192.168.4.1`. Wi-Fi credentials and the screen's setup proof are
entered on that device-hosted page. The cloud HTTPS page does not fetch local
HTTP and its CSP is not broadened.

This local fallback relies on its WPA2 link, not HTTP TLS. AP password and nonce
are separate HMAC-SHA256 outputs keyed by the persistent true-entropy setup
proof. Random context, monotonic time and a session counter provide variation;
RF-off random bytes are not claimed as independent true entropy. The page uses
no external assets or cloud requests. Fixed Host/Origin checks, JSON content type,
proof plus nonce, a 1024-byte body limit, bounded parser nesting, eight-failure
lockout and a ten-minute session limit constrain local requests. Responses never
return submitted secrets.

### Acceptance, validation and durable save

The transport's `received` reply means only that the supervisor queued a candidate
in RAM. After a 1.2-second response grace period, the runtime stops provisioning
and tests STA/time/TLS/device authentication. Only a successful candidate is saved
to the inactive NVS slot and then made active by a separate committed selector;
the device then reboots. A failed candidate preserves previous enrollment and
reopens the same setup transport, including AP for an iOS user.

The settings store is ordinary NVS, not encrypted storage at rest. It does not
perform whole-NVS erasure on an initialization or recovery error. Wi-Fi driver
storage is RAM, keeping its implicit credential persistence separate from the
application's validated settings commit.

Registration, desired configuration, fresh authenticated cloud contact and a
current-boot applied ACK remain distinct states. A vanished hotspot or BLE
disconnect is not confirmation. The default wizard policy is controlled-test
address metrics: 30-second windows, 5-second bins, 64 address keys, raw disabled,
16 records / 8192 bytes maximum per batch and a 120-second collection lease.
The chosen placement/dataset and seven-day upload acceptance cutoff are explicit.
Private address summaries use 24-hour retention; overall windows/status use
30-day retention in this wizard. Retention and collection authorization are
separate controls.

## Network, time and policy boundaries

The device origin is fixed to `https://pulse.anend.net`. Requests use the ESP
certificate bundle, hostname/certificate validation and certificate-date checks;
redirects are disabled and incompatible TLS build options fail compilation.
SNTP supplies a plausible initial clock; it is not a measured accuracy guarantee.
An authenticated HTTPS exchange is required before the clock is considered
usable for this client. The server-time midpoint/half-RTT estimate is labeled as
an estimate and excludes unknown absolute server-clock error. Monotonic time and
clock epochs remain the basis for durations and policy deadlines.

The v2 contact route works before a capture configuration is assigned. Desired
config fetch validates protocol, node/placement/config identity, firmware
adapter `cp-nimble-v2`, supported capabilities, bounds, upload cutoff and control
lease. Actual application is reported separately with boot/application sequence
identity. Retried control bodies remain stable so an older activation cannot be
mistaken for a newer application.

Only a newly received valid desired response renews the monotonic collection
lease. A cached config, upload success, historical config fetch or old activation
receipt cannot renew it. Transient network failures preserve only the remaining
same-boot lease. Definitive authentication failure, rejected/expired/unassigned
policy, local setup/pause, storage pressure or lease expiry stops new collection.
Reboot does not restore an indefinite grant. Disconnected hardware cannot receive
instant revocation; the remaining lease is the explicit upper authorization
window. The server can accept bounds larger than this board supports; firmware
must still reject incompatible settings.

## Observation semantics and bounded evidence

The primary detailed stream is an address summary keyed by the exact six observed
address bytes **and address type**. It does not merge rotating addresses using the
old Radar fingerprint heuristic. Each key retains report/advertisement/scan-response
counts, first/last offsets, RSSI samples and configured time bins. Windows and
health state remain separate streams. The callback copies a bounded report and
queues it without TLS, Flash writes or per-packet formatting; the worker advances
windows even with no packets and no UI reads.

The current adapter handles the legacy advertisement report path and preserves
up to 31 payload bytes. It does not establish extended-advertising coverage or
radio completeness. A visible MAC/address-type pair is neither permanent device
identity nor an exact person count. MAC rotation, multiple devices per person,
missed packets and scan gaps remain material limitations. Elevator wait inference
and vehicle classifications are separate research/validation work.

Raw is off by default. When explicitly enabled by compatible v2 policy, selection
uses the configured sequence sampling rule and at most the configured per-window
budget, within the firmware's four-report bound. Canonical aggregation happens
independently of raw selection. Intentional sampling, pressure skips, ingress
loss, address-table overflow, raw loss and storage loss have separate counters;
missing reports are not relabeled as intentional sampling. Status distinguishes
`address_summaries_dropped` (summary items) from `address_table_overflow_reports`
(reports), `accounting_overrun_reports` (reports lost when finite window-loss
buckets collide, forcing a scan stop), and `unpersisted_window_reports` (reports
whose overall window could not be stored, including suppressed sub-second
windows; raw evidence may already have persisted). Pressure can pause raw
or scanning; recovery follows the configured lower watermark. These budgets are
compiled limits, not measured throughput or retention duration.

## Journal, ACK and protected Flash

The C3 layout preserves the 3 MiB factory app at `0x10000` and the protected NVS
`cardid` partition at `0x356000` / `0x4000`. The local queue declaration is a
separate 4 MiB `cpqueue` partition at `0x360000`, subtype `0x40`. The pipeline also
recognizes an existing `blelog` label only with the same type, offset and size.
The actual board layout and existing bytes still require inspection before any
future partition-table write. Never erase the whole chip or use a padded merged
image spanning protected data. Deliver separate bootloader, partition and app
images; do not transplant this layout onto an S3 board.

The journal stores one frozen batch per 12 KiB erase-aligned slot with a maximum
8192-byte body. It writes body first, then a committed header, and validates
header/body checksums when reopening. Unknown, foreign, corrupt or partial slots
are quarantined without automatic formatting. Eight slots are reserved from
ordinary data allocation for control/status traffic. Persisted batches retain
original node, boot, placement, config, dataset, sequence and bytes across retry
and reboot; a new placement does not rewrite queued history.

The declared partition fits 341 complete slots, rather than the 384-slot code
ceiling. The worst-case codec fixture (64 keys, 15 bins and long IDs) packs four
summaries per 4096-byte batch or nine per 8192-byte batch: 16 or eight summary
slots per 30-second window, plus an overall-window slot and status slot. Ignoring
watermarks/reserves, an empty 341-slot queue would hold approximately 9.5 or 17
minutes of that particular raw-off fixture. These are arithmetic storage budgets,
not observed retention times; real message sizes differ, pressure pauses happen
earlier, and raw/other retained records reduce the budget. This baseline must not
be described as supporting hours of disconnected collection without measurement.

The uploader shares HTTP serialization with control traffic and schedules across
streams with bounded retry/backoff. It validates HTTP success plus the matching
node, boot, batch, stream, accepted count, body SHA-256 and durable receipt before
marking a slot ACKed. Only ACKed slots may be erased for reuse. Authentication
failure, an uncertain/mismatched response or a rejected/expired batch does not
reclaim the original record. Rejected batches remain retained/blocked for review;
this is not a silent drop policy. A successful build does not demonstrate Flash
power-loss behavior, wear, sustained queue capacity or measured ACK throughput.

## Verification record and reproducible commands

| Evidence | Verified scope | Boundary |
| --- | --- | --- |
| Official ESP-IDF Security 1 fixture and eight JS tests | Actual pinned Python client's handshake bytes, continuous partial-block CTR, proof/protocol rejection, synthetic GATT, v2 policy validation and fresh applied-state gating | Synthetic keys/peer; no radio |
| Native provisioning guard tests | Strict UUIDv4, independent HMAC vectors/domain/key/context separation and all-field settings digest with padding-independent length framing | Host OpenSSL adapter; firmware uses mbedTLS |
| Chromium provisioning browser smoke | Actual React wizard with mocked cloud and GATT; synchronous user activation, registration/config publication, encrypted local payload, no cloud Wi-Fi secret, no persistent browser secret and lost-response recovery | No physical Bluetooth chooser/ATT/phone validation |
| WebKit embedded-page smoke | Exact device-embedded HTML executes the AP form and acceptance path | Browser engine test, not iPhone hotspot hardware acceptance |
| TypeScript/Vite build | Current admin/provisioning source builds | Browser/device/network acceptance remains separate |
| Native full-chain and real local workerd check | Final-source pass: app startup/status eight groups per normal/diagnostic mode; scheduler six groups; 485 window/raw/summary allocation-failure sites, 137 status sites and 80 control-JSON failure sites; 15 runtime cases, actual callback stop/read checks and journal/collection/settings/protocol tests | Native/sanitizer/fault tests exercise production C with host adapters, not ESP32 scheduling or RF |
| Literal firmware-byte storage acceptance | C-produced window/summary/status files sent unchanged to real isolated workerd/D1/R2: four committed receipts, six items and six concurrent-retry checks; contact/activation, sequence conflict, private scope, raw budget, R2 integrity, demo isolation and retired-boot rejection pass | Synthetic observations and isolated local cloud runtime; no production endpoint |
| Final ESP-IDF 5.5.3 C3 images | Normal, diagnostic, normal headless and diagnostic headless each built in a fresh directory and passed separate-image/protected-layout checks; TLS date verification enabled | Compilation/image acceptance only; no physical board operation |
| Final repository test snapshot | 444 tests across 43 files and TypeScript/Vite build passed | Includes concurrent frontend/backend work; this is not a firmware-only test count |

### Open-font publication acceptance — 2026-10-25

The current source uses the OFL font replacement and passed all four fresh
ESP-IDF 5.5.3 builds with protected-image and TLS date checks. The native chain
also passed again, including four font tests, nine image guards, sanitizer/fault
checks and literal firmware-byte workerd/D1/R2 acceptance. The selected release
web/API source passed 443 tests across 43 files, excluding the unrelated pending
ingestion-audit test. The full shared working-copy snapshot passed 453 tests
across 44 files; Vite and both new CI smoke commands passed.

The 164-file non-Markdown firmware manifest is
`97f99eded0031cf04c1c6d27e0f13aea874bcbb43223936b5ed3d0e30bd809fa`.
The ignored local package is `firmware/build/publication-20261025/`; it includes
separate images, verification reports, test logs and the required OFL/copyright
notices. These are pre-commit build artifacts from the selected source; image
metadata must not be confused with evidence of a physical flash or online deploy.

| Open-font variant | Application bytes | Application SHA-256 |
| --- | ---: | --- |
| Normal, LCD/buttons | 1,452,240 | `d4d5997c0faafd648aaf993e7da371622c6dc2513b6b4132c4db83b333ccfb24` |
| Diagnostic, LCD/buttons | 592,864 | `2c57ca5ebf4eeb3c06f7724fae08100ceb95a7d2c36f5af79e488ed5952d68ac` |
| Normal, headless | 1,360,016 | `f8cd7a5295f9aa7854aa8a69a650c8ce15580c0657e3c25a84a7b942b5586c59` |
| Diagnostic, headless | 481,072 | `e760f54507e72b5793a233055f2e46c7f761e788aa97076795a76c8b66d94f92` |

### Historical pre-font-replacement source and image artifacts

All four final builds used the same 158 non-Markdown firmware files. The source
manifest SHA-256 is:

`0e7fe4c35cc140e34a6d52f72354f9bf72b093fa560706faa75230c548a8aba9`

The manifest was checked against each source file and verified unchanged after
all four builds. Documentation edits are excluded from this firmware fingerprint;
web-source verification is recorded separately above.

| Final variant | Application bytes | Application SHA-256 |
| --- | ---: | --- |
| Normal, LCD/buttons | 1,452,240 | `cda3db2d16ddbb024e847b8cecf62a557b3f661195479d1316a8874e7c0b3bd0` |
| Diagnostic, LCD/buttons | 592,720 | `c52977bc65e2d4f54279158a517dbeb820f66a0e5b99860f1d2cbd3f39217e25` |
| Normal, headless | 1,360,016 | `8912cca7487231968360736c6e129a72ba76caaa901041b8803a92315ebaedbd` |
| Diagnostic, headless | 481,072 | `33d1e6ded00676461b3df956fb1f5bb197f5c3d64a41ea946d9bea5ed3046ca7` |

All applications are below the preserved `0x300000` partition limit. Each
variant has its own bootloader at `0x0`, partition image at `0x8000` and app
at `0x10000`; no padded merged image was produced. The local artifact root is
`firmware/build/acceptance-20261025/`, with variant directories `normal`,
`diagnostic`, `headless` and `diagnostic-headless`. Each contains the three
separate images, `sdkconfig`, `verified-images.json` and `build.log`.
`acceptance.json` collects offsets, lengths, hashes, TLS flags and source-manifest
identity; `source-files.sha256` records the 158 source fingerprints. These are
ignored local artifacts, not tracked or published downloads.

Commands from the repository root (Python helpers use `uv`):

```bash
firmware/tools/check-chain.sh
# The chain helper includes check-passport, settings/network/runtime and codecs.
bash firmware/components/cp_settings/tests/run-host.sh
IDF_PATH=/path/to/esp-idf-v5.5.3 bash firmware/components/cp_network/tests/run-host.sh
bash tests/provisioning/host/run.sh
npx vitest run tests/provisioning
node scripts/provisioning-browser-smoke.mjs
npm run build
firmware/tools/build-passport.sh
firmware/tools/build-passport.sh --diagnostic
firmware/tools/build-passport.sh --headless
firmware/tools/build-passport.sh --diagnostic --headless
```

The provisioning browser runner starts its own local server on port 18879 and
fails if that port is occupied. It mocks cloud and GATT and does not contact the
production API. The local v2 runtime smoke uses synthetic enrollment and batches
against an isolated local Worker; it must not target the production origin.
The chain helper consolidates native checks and literal firmware-byte storage
acceptance. Final local logs are `/tmp/campuspulse-check-chain-final.log`,
`/tmp/campuspulse-chain-browser-final.log`, and the four
`/tmp/campuspulse-final-<variant>.log` files. Temporary logs are ephemeral;
the ignored acceptance package retains per-variant build logs and image records.
Earlier intermediate sizes, such as the 1,449,536-byte strict-TLS normal image,
are superseded by the final table above. Historical v1 cloud-demo acceptance is
a separate evidence cohort and was not reused as proof for this v2 chain.

## Remaining acceptance

Historical local-only boundary: the subsequent 2026-10-25 flashing section
supersedes the publication, flashing and startup statements in this section.
Radio, Wi-Fi enrollment and upload acceptance remain separate.

No physical Passport has been flashed by this work. Still required: verify its
revision and existing Flash layout; test wrong proof, permission cancellation,
BLE/AP disconnect, bad network, interrupted settings commit, setup recovery,
Wi-Fi/time/TLS failures, policy revocation/expiry, boot reapplication, placement
changes, exact ACK retries, reset during Flash writes and storage pressure on a
real board. Measure heap/stack margins, sustained radio/Wi-Fi coexistence, losses,
ACK throughput and power use before claiming field readiness.

T-Energy-S3 and the exact Waveshare panel/board remain unsupported until separate
profiles, layouts, builds and hardware checks exist. Durable Passport manual
wait/parking markers, terminal authorization, USB provisioning and ePaper cards
remain planned. No v2 cloud deployment, production registration, production
capture or private-source publication is included in this local acceptance.

## One-Passport flashing and startup — 2026-10-25

The user explicitly authorized flashing and separately approved resetting only
the backed-up legacy queue. The connected chip reported ESP32-C3 QFN32 revision
1.1, embedded 8 MiB Flash, 40 MHz crystal and native USB Serial/JTAG. Its existing
ESP-IDF 5.5.3 bootloader and partition table passed structural/checksum checks.
The actual table retains `factory` at `0x10000` / `0x300000`, NVS at
`0x9000` / `0x6000`, protected `cardid` at `0x356000` / `0x4000`, and the compatible
`blelog` queue alias at `0x360000` / `0x400000` (data subtype `0x40`).

An 8,388,608-byte backup was read and compared with the device before writing.
The old queue was foreign to the new journal: all 341 slots would be quarantined,
with zero usable slots. After the user's approval, only that 4 MiB region was
erased. No whole-chip erase occurred. The bootloader/table stayed in place;
only the application was written at `0x10000`.

The initial application exposed a real `cp_supervisor` stack-protection reset.
Commit `5ea501a13831e1081592fe671086826199f003f9` reuses one caller-owned runtime
snapshot, raises its stack from 4096 to 8192 bytes and records its high-water
mark. Native normal/diagnostic tests and both C3 builds passed. The final normal
image identifies itself as `cp-5ea501a13831`, is 1,452,400 bytes and has SHA-256
`cf315420d2b5299a91ba3e1af8c7de5c37b881349c6819936790e3ffd95990aa`.

Before each normal boot, the complete 8 MiB device digest matched a private
verification-only expected Flash copy. Unwritten regions, including `cardid`,
were retained. First boot legitimately created setup state in NVS; that new state
was saved before the corrective application update, and `cardid` was also read
back directly and matched the original backup. No padded full-Flash image was
written: the full expected copy was used only by the comparison command.

The corrected image was observed for 60 seconds: zero panics, zero software
resets, journal pending/quarantined counts both zero, BLE host started and
advertising requested. Display/input/battery drivers reported ready. The
supervisor reported a minimum 5032 free stack bytes during this setup scene;
this is not a measured bound for Wi-Fi/TLS/collection workloads. The user
confirmed the display normally shows Bluetooth setup, Node and Setup proof.
Phone BLE transactions, Wi-Fi enrollment, assigned-policy capture
and actual upload/reclamation still require their own acceptance.

The protected original backup and raw serial logs remain private and ignored
under `captures/passport-flash.*`; this note omits device identifiers, setup
proofs, credentials and observation bytes. The corrected local image package is
`firmware/build/publication-20261025/normal-stack-fixed/`, with separate images
and font copyright/OFL notices. The v2 server/docs deployment at commit
`1912d48` passed hosted CI and deployment; public read-only checks confirmed its
five v2 operations, protected unauthenticated configuration response and
database-backed place summary.

## Short PIN / USB revision — local acceptance, 2026-10-25

This revision replaces the original displayed long proof and Security 1 flow.
Display-equipped nodes use an eight-digit numeric PIN, five-minute expiry and
five failed authentication attempts across reconnects. The internal factory
secret remains in its existing NVS record. Security 2 uses the pinned SDK SRP6a
and patch-1 AES-GCM protocol; no Security 0/1 downgrade exists. Hotspot passwords
are independent twelve-character base32 strings. The screen presents the short
PIN on one line and labels physical USB setup without displaying a PIN.

The new `cp_usb` module separates bounded framing/controller logic from native
USB Serial/JTAG. An unenrolled headless profile waits for explicit USB `begin`.
Status stays available during network validation; failures retain previous
settings and reopen USB. The browser refreshes and checks factory identity and
nonce before sending, retains the same unique cloud credential after uncertain
responses, and accepts matching local `received`/`testing`/`saved` replies while
still requiring fresh cloud contact and applied ACK for completion. This fixes
both failure-session nonce rotation and duplicate replies during validation.

Two SDK compatibility repairs are explicit: fixed sixteen-byte salt plus standard
mbedTLS verifier generation avoid the helper's leading-zero conversion; a
fingerprint-limited generated copy aligns the SDK's private IV to `uint32_t`.
The original source SHA-256 is
`d6dedb2b759c4ae45c1c88ff251de4ba1f830e5b896c0193ef01ce69c2a862bc`;
the patched source is
`ef2cc20030a39c7870a0b741db136000d8659f907004fbb61412d45846ec18e2`.
Only the IV member's alignment changes; compile-time assertions retain the
12-byte nonce/counter layout. Installed SDK files, algorithms and wire schema
are unchanged. Original Apache notices remain in generated code. See the
[component contract](../../firmware/components/cp_provision/README.md).

Final local verification:

- 479 tests in 47 release-scope frontend/API test files and production web build
  pass. The separate uncommitted research analysis suite is excluded from this
  release count and remains outside this change.
- Chromium drives the actual wizard/WebCrypto/WebStreams with synthetic BLE,
  USB and cloud peers: wrong PIN, synchronous chooser activation, lost configure
  reply, duplicate `testing` ACK, failed Wi-Fi/new nonce/corrected candidate,
  credential retention and fresh cloud applied-state gating. WebKit drives the
  embedded eight-digit local form. These are not physical transport tests.
- `check-chain.sh` passes native sanitizer/fault checks, twenty actual-runtime
  scenarios, app startup/status tests in normal and diagnostic modes, bounded
  USB/console tests, actual provisioning-module pthread concurrency/expiry/
  idempotence tests, and literal C-codec fixtures against isolated workerd/D1/R2.
- The SDK C peer executes actual Security 2/SRP with mbedTLS, with the declared
  alignment repair. ASan/UBSan cover the peer, SDK protocol/SRP and module under
  host shims; the linked mbedTLS dependency is a separate native library build.
  Explicit assertions exercise leading-zero salt, SHA-512 identity hash, padded
  client A and minimal server B, busy connection establishment, wrong PIN across
  reconnects, expiry, malformed protobuf and ciphertext bounds. Host timings are
  not C3 measurements.

Four fresh C3 builds were reconfigured/rebuilt with the final repairs. Their
compile-command records contain exactly one generated checked Security 2 unit
and no original SDK Security 2 translation unit. All require Security 2, compile
logging no higher than INFO, retain TLS date/certificate validation and pass
separate-image/partition guards:

| Configuration | Application bytes |
| --- | ---: |
| Normal, LCD/buttons | 1,476,416 |
| Headless | 1,384,064 |
| Diagnostics, LCD/buttons | 593,248 |
| Diagnostics, headless | 481,248 |

The ignored local package is `firmware/build/shortpin-usb-20261025/`, with separate
images, SDK patch manifests, application/SDK licenses and OFL/font notices. Its
227-file local source manifest SHA-256 is
`5db5923a2b3d5fe584b3fb90e9e2d68585735797a3851c1c73136856edc81074`.
This records the tested software snapshot; a committed-version normal image and
any subsequent physical USB/startup results require their own record. No device
has been updated to this revision at this checkpoint. Physical BLE, browser USB
chooser, target-phone hotspot, real Wi-Fi/cloud enrollment and sustained capture/
upload acceptance remain separate.

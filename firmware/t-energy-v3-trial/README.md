# T-Energy-S3 V3 startup and small-statistics runtime

The compiled entry remains `main/small_runtime.c`, version `0.3.8-te-budget-recovery`.
USB Serial/JTAG uses the installed driver before nonblocking stdin; this avoids
the SDK's no-driver path reporting no readable bytes despite a connected host.
Wi-Fi/DHCP admission has a 180-second deadline and up to three owner-task
reconnects after disconnect events, also during saved-boot signed-clock setup.
Startup failures report a fixed stage plus return code and elapsed time without
network credentials. TLS and request deadlines remain unchanged.
The default USB flow still runs **one to three 30/60-second windows**. A separate
explicit production save option stores a startup profile only after a real
applied ACK, then supports authenticated-time recovery and fresh real-boot
capability/policy/ACK acquisition without USB. This is a local source/host/build
implementation; **this change has not been flashed or accepted on hardware**.
It adds no TF, screen, raw upload or per-address upload. The older
[bounded runtime and physical acceptance](BOUNDED_RUNTIME.md) retains its original
scope and does not establish the new untethered startup behavior.

An independent, default-off [single-key maintenance image](MAINTENANCE.md) was
explicitly authorized on2026-10-31 to clear only the existing `scanstats/devs`
legacy MAC cache. It replaces the application entry at build time and links no
V3/radio/network code. Normal and checkpoint images never invoke that deletion.

Target: LILYGO T-Energy-S3 V1.0 / ESP32-S3-R8, 16 MB Flash and 8 MB octal PSRAM,
as specified by the [manufacturer](https://github.com/Xinyuan-LilyGO/T-Energy-S3).
Confirm actual revision and installed partition bytes before device work.
The existing `cpqueue` at `0x360000`/4 MiB is neither read nor written; the old
v2 backlog is preserved. The partition table is unchanged. Never erase Flash or
NVS. NVS initialization has no erase-on-error fallback and may complete SDK
interrupted updates, so private preflight backups remain necessary.

Only independent `cpv3stats1`, `te_v3_storage`, `te_v3_uplink` and the new
`cpv3start` NVS namespaces are used. The last uses the shared strict versioned
startup codec and explicit selector/readback provider; legacy `cp_settings` is
not loaded or migrated. Three queue slots are shared: one window, one status, one control,
each at most 1024 body bytes/2048 encoded bytes. Actual NVS entries, unknown
keys/types, corrupt records and current space are checked. Every mutation first
reserves a persistent daily logical allowance; every new body is committed,
reopened through a fresh queue and compared byte for byte before POST or
collector release. Uncertain/full/foreign state stops admission without erasure.
Valid expiry tombstones remain and are reused only with increasing ordinals.
GC amplification and physical wear are not measured by these logical allowances.
Startup profile slots consume additional entries in the existing 24 KiB NVS.
The original 128-entry spare floor and three-slot admission guards are not
relaxed; real saved/reconfigured profiles can therefore be rejected under space
pressure. Actual post-provisioning entry headroom remains a hardware acceptance
item, rather than a capacity guarantee inferred from a successful build.
The ceilings are 192 MiB of logical storage authorization and 8 MiB of logical
POST-body authorization per UTC day; an applied policy may tighten them. The
user requested a sustainable allowance after the former 1 MiB / 128 KiB limits
blocked historical lease reclamation. These are conservative logical charges,
not measured flash writes or wire bytes. The sizing model covers a 60-second
window, 40-second lease renewal and bounded restart overhead; it does not prove
continuous device operation, physical wear or flash endurance. Previously
reserved budget is retained when the allowance is raised.
The autonomous path does not reset reservations at a reboot. Budget denial
stops automatic restart; quota sufficiency and deployment-scale operation still
require actual measurement.

Reboot recovery preserves original node/boot/policy/body/UUID/sequence/TTL.
Old control requests use receipt-only mode and cannot create a new ACK or lease.
Statistics require conservative frozen-time validation and server checks of the
original lease/policy. Exact committed receipts are required before reclamation.
Missing receipts or rejected historical bodies are retained and block this trial.
Cryptographic random UUIDs plus the server namespace provide idempotency;
whole-medium rollback protection is not claimed.

The capability's `power_loss_recovery=true` describes implemented committed
record reopen/CRC/SHA/strict-receipt recovery support. It does **not** claim
arbitrary physical power loss, brownout, NVS GC or endurance has been measured.
Old `main.c`, strict capability builder and coordinator remain separate, unused
experiments with their qualification gate off. No CPU/scanner/power-loss
verified flag from those experiments is manufactured.

Production uses **native MQTT/TLS to the fixed Hangzhou EMQX broker, then the
Cloudflare service**. The host must use `--allow-production`, logical endpoint
`https://pulse.anend.net`, `uplink_transport="mqtt_tls"`, `tls="public_ca_bundle"`
and flat `mqtt_uri`, `mqtt_username`, `mqtt_password`, `mqtt_namespace` fields.
The URI must equal `CP_MQTT_PRODUCTION_URI`; no custom broker/HTTPS
`server_ca_pem` is accepted. A separate manual PEAP authentication CA cannot
replace the MQTT public CA bundle. Missing
broker credentials fail closed. Production HTTPS and proxy fallback are rejected.
Nonproduction HTTPS diagnostics remain available with explicit host permission.

V3 uses the existing `req/ingest/<rpc>` topic and an8-byte CPV3 frame. Frozen
body bytes, hashes, old boot identity and receipt-only recovery remain exact.
A broker PUBACK is not Cloudflare custody: a full correlated reply, matching
PUBACK and empty SDK outbox only make the transport response complete; the
existing strict application receipt is still mandatory before queue reclamation.
Timeout/disconnect/unsettled outbox forces confirmed SDK stop. Unknown stop
retains callback/client/body storage and attempts to stop this owner's radio.
Borrowed EAP CA storage also remains alive until confirmed network stop; wiping
owned credential buffers after teardown does not prove the SDK heap is zeroed.
There is no auto-reconnect or hidden application retry; every application retry
first charges its unchanged logical body against the persistent uplink budget.

Registration preserves one capability/body/sequence/uptime for at most three
attempts, with1s/2s backoff. Logical request deadlines remain30 seconds on the
production profile and15 seconds for diagnostics; SDK calls can overrun those
bounds. MQTT uses the trusted host clock seed and typed server receipts, never
a fabricated HTTP Date. No MQTT failure changes the configured DNS server,
chooses a new IP or disables hostname/CA/time verification.

## Explicit saved startup and recovery

USB accepts the optional flat fields `save_startup:true`,
`startup_reconfigure:false|true`, `clock_key_id` and canonical 122-character
base64url `clock_public_spki` (P-256 SPKI DER, 91 bytes). All four remain absent
in the original ephemeral flow. Startup options require the canonical production
origin, complete native MQTT credentials and the existing public CA bundle;
diagnostic endpoints and their custom HTTPS CAs cannot be persisted. `max_windows:0` is
allowed only with explicit save. Values 1–3 can also save a profile while keeping
this boot bounded; the saved profile never contains that test limit. Both open
and personal Wi-Fi, plus explicitly unverified PEAP, can be provisioned and saved.
Profile v2 stores the explicit NONE choice; v1 disabled PEAP remains read-only
for credential reuse and cannot become automatic by inference. CA-verified PEAP
retains the temporary manual USB flow and full date checks, requiring trusted
time before RADIUS authentication. The administrator wizard defaults saving on
and completes initial policy delivery plus the seven-day renewal grant only
within a newly submitted setup flow and after real ACK/SAVED evidence.

USB Wi-Fi selects `security:"open"`, `"personal"` or `"enterprise_peap"`.
Open requires an empty `password`; personal requires an 8–63 printable-ASCII
passphrase or exactly 64 hex digits. PEAP requires an empty personal `password`,
`eap_username`, `eap_identity`, `eap_password` and explicit
`eap_server_verification:"none"|"ca"`. UI-default `none` omits CA/domain and
leaves the server unverified, with a visible warning that a fake server may obtain
enterprise account credentials. `ca` requires one real CA in `eap_ca_pem` and
one expected DNS hostname in `eap_domain`. SSID/credential text shares the
printable-ASCII browser/CLI/firmware contract; arbitrary UTF-8 SSIDs are not
supported by this path. Host and firmware parse the X.509 CA; browser PEM shape
checks alone are not certificate authentication. Fresh trusted physical-USB time
is installed before Wi-Fi starts; the transport selects PEAP only and, in `ca`
mode, supplies CA/hostname and enables certificate-date checks. Invalid trust
never silently falls back to `none`. EAP trust material is temporary
and cannot change MQTT/HTTPS server trust or the existing NVS profile format.
See [authentication contract and local verification](../../docs/notes/v3-usb-wifi-auth-2026-11-03.md).
This repair has no new flash or real PEAP wireless-handshake acceptance.

HELLO reports independent `credential_state`/`mqtt_state` (`ready`, `missing`,
`unavailable`), never token/hash/password values. A registered same-node device
defaults to local reuse when ready; START explicitly requests
`reuse_saved_credential:true` without `device_token` and/or
`reuse_saved_mqtt:true` without all four MQTT fields. The host exposes
`--reuse-saved-credential` and `--reuse-saved-mqtt`. Fresh identity/readiness is
rechecked, and reuse is restricted to canonical production API/native MQTT,
never isolated HTTPS. A valid selected V3 profile wins; only genuine absence
permits read-only legacy fallback. Corrupt/foreign/I/O data stays unavailable,
with no inactive-slot promotion, format migration or writes. Only bearer/MQTT
fields are reused, not prior network fields. Missing/unknown states retain manual
backup/recovery actions without automatic rotation. Readiness does not establish
network/cloud success or saving, and a fresh registration uses its new secrets.

`V3 START ACCEPTED` confirms only receipt of the physical USB material. After the
actual cloud applied-ACK receipt is committed and reclaimed, the runtime charges
8192 logical storage bytes (16384 for deliberate recovery), holds the common
NVS-owner lock, and saves/reads back the new profile. Only success prints
`V3 STARTUP SAVED`; failure prints `V3 STARTUP SAVE FAILED` and stops before
collection. An uncertain selector commit can leave the complete old or new
profile; the runtime does not guess, roll back or claim which survived.
Neither marker establishes untethered or physical power-loss acceptance.

On a saved-profile boot, the node identity is checked before network use. A
3-second physical USB grace accepts fresh `HELLO <32 lowercase hex>` or `SETUP`
and then waits in USB setup. Otherwise the independent signed-clock bootstrap
temporarily owns Wi-Fi, obtains only a tentative SNTP hint, verifies a fresh
nonce response with the trusted USB-provisioned public pin under strict TLS,
and confirms cleanup before native MQTT can start. Saved UTC, old boot IDs and
unsigned network dates never grant time authority. Network/time failures retry
at low frequency: three attempts per round, short USB/backoff opportunities,
then 30–300 seconds between rounds. Every wait keeps USB setup available. An
unconfirmed clock cleanup blocks another network owner. Corrupt/unsupported
profiles stay in USB instead of being silently repaired.

Automatic operation uses `max_windows:0` at the application level. The scanner
closes complete 30/60-second windows and schedules a real new boot after about
20 minutes (40/20 full windows), with an absolute 20-minute run guard. The current
boot alone must obtain fresh capabilities, an explicitly approved renewable
startup policy, an actual applied ACK and lease. Historical recovery does not
increment current-window success. There is no fabricated ACK, boot UUID or
in-place scope swap. A planned restart requires quiescent capture with no
handoffs, all frozen bodies committed/reopened before release, no uncertain
profile/queue write, and confirmed transport stop. Pending committed bodies keep
their original identities/TTL. Failed writes or unresolved volatile handoffs
prevent restart. Known credential rejection and quota denial require attention
rather than repeated reboots. Restart alone never resets a daily allowance.

No unverified T-Energy button or power GPIO is used. During operation, physical
USB `STOP`, `SETUP`, or a fresh HELLO requests safe stopping. Remaining handoffs
are frozen without new upload attempts. Once safe, HELLO includes
`restart_required:true`; `RESTART` sets only a complementary RTC one-shot USB
hint and performs `esp_restart()`. The following software boot stays in USB;
this hint is never trusted clock or policy state. Unsafe state does not advertise
restart permission. Ordinary power cycling remains the saved automatic path.
The browser's explicit safe-restart action or host `--safe-restart` rechecks the
node and a new nonce first, sends at most one RESTART, reopens the same port and
uses a new HELLO/time exchange before sending credentials. A device still
stopping may need another explicit host invocation after its safe marker.

The host utility remains offline except for explicit USB `--send`. Obtain clock
metadata from the authenticated-by-TLS canonical
`https://pulse.anend.net/api/v3/clock/key` endpoint using a trusted browser, save
its exact public JSON as an owned mode-0600 file, and pass `--startup-key-file`
(`--clock-key-file` is an alias). Shape, audience, canonical DER and actual curve
point are checked; the file's original HTTPS provenance remains the operator's
responsibility. Example (all input paths are private operator-supplied files):

```sh
uv run --with cryptography --with pyserial firmware/t-energy-v3-trial/tools/host_bootstrap.py \
  --private-dir /path/to/private --wifi-file /path/to/wifi.json \
  --allow-production --save-startup --startup-key-file /path/to/clock-key.json \
  --windows 0
```

Without `--send` this validates only and opens no device. Add an explicitly
selected `--port` and `--send` for an authorized physical attempt; save mode waits
for the independent exact SAVED marker after first policy publication/ACK. Use
`--startup-reconfigure` only for deliberate trusted USB recovery. Saved local
configuration and administrator startup-grant approval remain independent steps.

MQTT state,8192-byte reply and8200-byte frame are explicitly in PSRAM. The S3
profile enables external TLS/outbox data. Actual cold/hot phases are measured;
the owner-only memory lease serializes hot TLS IO with collector allocation.
Cold internal admission remains57344/20480 bytes; a verified connected/subscribed,
empty-outbox hot state uses28936/17058 bytes. PSRAM free/largest remain512 KiB/
128 KiB. These are conservative admission guards, not measured endurance or
radio-capacity qualification. Callback stack watermark0 means unknown.

Build with activated ESP-IDF 5.5.3 and `./build.sh`; temporary separate images
and partition-boundary checks run without opening a device. From the repository
root run `IDF_PATH=/path/to/esp-idf-v5.5.3 bash firmware/t-energy-v3-trial/tests/run_host_tests.sh`
and `uv run --with cryptography python -m unittest discover -s firmware/t-energy-v3-trial/tests -p test_host_bootstrap.py`.
Host tests use mocks/synthetic fixtures and do not qualify hardware.

`CONFIG_TE_SMALL_TEST_HOLD_FIRST_COMMIT=y` is an explicit one-window normal
reboot checkpoint image, default off. After commit/readback/reopen and exact
collector release, it stops scanning and holds without statistics POST until
physical reset. A fresh boot must recover the old exact record before new
registration. This is separate from physical power-loss acceptance.
Checkpoint images always require explicit USB and do not restore or enter
automatic continuous startup. Maintenance entry selection remains separate and
does not link or invoke these runtime paths.

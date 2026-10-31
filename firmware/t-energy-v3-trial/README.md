# T-Energy-S3 bounded V3 small-statistics runtime

The compiled entry is `main/small_runtime.c`, version `0.3.2-te-native-mqtt`.
It runs **one to three 30/60-second windows** after a fresh physical USB bootstrap.
It uses shared capture/statistics/temporal/control/receipt code, with no TF,
screen, raw upload, per-address upload, saved network secret or automatic reboot.
This is a bounded acceptance image, not an unattended production collector.
See [runtime and physical acceptance](BOUNDED_RUNTIME.md).

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

Only independent `cpv3stats1`, `te_v3_storage` and `te_v3_uplink` NVS namespaces
are used. Three queue slots are shared: one window, one status, one control,
each at most 1024 body bytes/2048 encoded bytes. Actual NVS entries, unknown
keys/types, corrupt records and current space are checked. Every mutation first
reserves a persistent daily logical allowance; every new body is committed,
reopened through a fresh queue and compared byte for byte before POST or
collector release. Uncertain/full/foreign state stops admission without erasure.
Valid expiry tombstones remain and are reused only with increasing ordinals.
GC amplification and physical wear are not measured by these logical allowances.
The bounded ceiling is 1 MiB storage and 128 KiB POST-body authorization per
UTC day; an applied policy may tighten them. This cannot sustain an all-day
60-second profile.

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
The URI must equal `CP_MQTT_PRODUCTION_URI`; no custom CA is accepted. Missing
broker credentials fail closed. Production HTTPS and proxy fallback are rejected.
Nonproduction HTTPS diagnostics remain available with explicit host permission.

V3 uses the existing `req/ingest/<rpc>` topic and an8-byte CPV3 frame. Frozen
body bytes, hashes, old boot identity and receipt-only recovery remain exact.
A broker PUBACK is not Cloudflare custody: a full correlated reply, matching
PUBACK and empty SDK outbox only make the transport response complete; the
existing strict application receipt is still mandatory before queue reclamation.
Timeout/disconnect/unsettled outbox forces confirmed SDK stop. Unknown stop
retains callback/client/body storage and attempts to stop this owner's radio.
There is no auto-reconnect or hidden application retry; every application retry
first charges its unchanged logical body against the persistent uplink budget.

Registration preserves one capability/body/sequence/uptime for at most three
attempts, with1s/2s backoff. Logical request deadlines remain30 seconds on the
production profile and15 seconds for diagnostics; SDK calls can overrun those
bounds. MQTT uses the trusted host clock seed and typed server receipts, never
a fabricated HTTP Date. No MQTT failure changes the configured DNS server,
chooses a new IP or disables hostname/CA/time verification.

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
and `uv run python -m unittest discover -s firmware/t-energy-v3-trial/tests -p test_host_bootstrap.py`.
Host tests use mocks/synthetic fixtures and do not qualify hardware.

`CONFIG_TE_SMALL_TEST_HOLD_FIRST_COMMIT=y` is an explicit one-window normal
reboot checkpoint image, default off. After commit/readback/reopen and exact
collector release, it stops scanning and holds without statistics POST until
physical reset. A fresh boot must recover the old exact record before new
registration. This is separate from physical power-loss acceptance.

# V3 startup profile store

This component stores one explicitly approved production startup profile in the
dedicated `cpv3start` NVS namespace. It never reads, migrates, writes or erases
legacy `cp_settings`, queues, captures or another namespace. Initialization only
calls the SDK's non-erasing `nvs_flash_init()`; SDK initialization errors remain
errors. The caller serializes access and charges
`CP_V3_STARTUP_LOGICAL_WRITE_BYTES` (8192 bytes) before an approved save. That
logical accounting is not measured physical Flash traffic, GC or endurance.
The separate explicit USB recovery API conservatively charges
`CP_V3_STARTUP_RECONFIGURE_LOGICAL_WRITE_BYTES` (16384 bytes), covering up to
four commits if both candidate and selector keys need individual type repair.

Save is an explicit caller operation **after** the candidate passed actual Wi-Fi,
authenticated production service and configuration-ACK validation. Structural
validation alone cannot prove those events. Production API/MQTT endpoints are
fixed, MQTT credentials must be complete, and an exact P-256 SPKI DER public key
and a key ID are required. The provider additionally parses the key and checks
its public point using ESP-IDF mbedTLS. A trusted USB provisioning flow supplies
the public pin. Public keys are not secrets, but NVS contains network/device
credentials under the existing ordinary NVS security model; this component makes
no encryption-at-rest, secure-boot, hardware anti-rollback or physical-tamper claim.

`auto_start=true` admits personal PSK/open Wi-Fi only. PEAP requires trusted time
before sending RADIUS credentials, so its structurally valid profile can only be
saved with `auto_start=false` for an explicit USB flow with independently trusted
time. A saved profile contains no wall-clock seed, boot UUID, raw capture, batch
ID, policy/lease authority or bounded-test window limit. Each boot must acquire
authenticated time and fresh cloud policy authority before collection.

The codec is independent of C padding. Schema 1 uses `CPS3`, a little-endian
16-bit version, 16-bit flags (only bit 0 `auto_start`), 32-bit total length and
32-bit CRC32 in a 16-byte header. CRC32 covers the complete frame with its own
field zeroed. The payload starts with 32-bit Wi-Fi security, then 16-bit lengths
and bytes for node ID, SSID, PSK, device token, PEAP username/identity/password,
MQTT username/password/namespace and time-key ID, followed by 16-bit SPKI length
and SPKI bytes. Production endpoints and settings version are reconstructed by
this schema. All strings exclude NUL terminators; embedded NULs, trailing bytes,
unknown flags, lengths, settings and identities are rejected. CRC detects damage;
it provides no authentication or rollback resistance. The frame is bounded at
1280 bytes; the synthetic personal profile uses less than 420 bytes, with empty
PEAP fields costing only their length prefixes.

The provider writes inactive slot `a` or `b`, commits, closes/reopens and compares
the complete readback before writing and committing the `active` selector. It
then closes/reopens and verifies the selector. Failures before the selector
preserve the previous selection; an uncertain selector commit may durably select
either the old or already verified new profile. The caller must fail closed for
that boot on every error. The next load trusts only the selector and validates
the selected blob, identity and public point. It never guesses a newer inactive
slot, rolls back a selector or silently repairs a corrupt store. A missing
selector in a nonempty store (including a first-save interruption) is a recovery
error. The inactive slot's corruption does not invalidate a healthy selected
profile. The spare-entry guard uses SDK `available_entries`, with floor 128 plus
`ceil(frame_bytes / 32) + 7` conservatively reserved entries.

After a fresh trusted USB candidate has passed the same actual network/cloud ACK
admission, `cp_v3_startup_reconfigure()` can deliberately replace an orphaned or
corrupt store. Autonomous boot must never call it. Healthy selected profiles
follow ordinary save. The recovery path writes only the new approved profile;
it never promotes an inactive stored candidate. It preserves a readable valid
selector's chosen slot while replacing the opposite candidate. If a candidate
or selector write reports an NVS type mismatch, only that individual key is
removed and committed before retrying the write. No namespace or partition is
erased. Read/commit errors still fail closed, with no selector rollback. This
software fault-injection model does not establish arbitrary-power-loss hardware
acceptance.

Run the synthetic ASan/UBSan codec and storage-fault tests with:

```sh
uv run firmware/components/cp_v3_startup/tests/test_startup.py
```

The host provider's mbedTLS API adapter uses OpenSSL's actual EC parsing and
public-point checks, located through `pkg-config`; `CP_TEST_OPENSSL` can select
its installation prefix instead. ESP-IDF
builds use the actual SDK mbedTLS headers/library. Host fault tests and S3 builds
do not establish NVS hardware power-loss, credential security or untethered
device acceptance.

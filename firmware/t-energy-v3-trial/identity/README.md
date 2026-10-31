# Bounded T-Energy identity reservation core

This is an independent, host-tested core. **No physical NVS backend is supplied,
no board gate is connected, and no device acceptance is claimed.** The code does
not call NVS, create a namespace, change a partition, initialize/format storage,
or access `cpqueue`. Only this directory is needed to build its tests.

The backend confirmed an alternative under review: fresh hardware-random boot
UUIDs, per-boot monotonic sequence numbers and exact frozen-body replay, with
server-side conflict checks. That is probabilistic uniqueness, not strict proof
against a complete local rollback; a byte-identical old registration can look
like a network retry. This experimental ledger is not connected to that path.

The board target remains T-Energy-S3 V1.0, for which the
[manufacturer documents ESP32-S3-R8, 16 MB flash and 8 MB octal PSRAM](https://github.com/Xinyuan-LilyGO/T-Energy-S3).
No board pin, driver, flash or battery operation is performed here. The storage
contract was checked against the
[ESP-IDF 5.5.3 ESP32-S3 NVS documentation](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32s3/api-reference/storage/nvs_flash.html).
Actual board revision, partition capacity, entropy, trusted clock, shared lock
discipline and physical power-loss behavior still require separate acceptance.

## Contract and bounded scope

`te_identity_open` is read-only. It verifies the exact node, canonical record
format, real SHA-256 and CRC32, and the supplied shared budget's node-derived
storage owner. It rejects an unconfigured, unopened or latched budget, unknown
NVS capacity, corrupt/partial/foreign state, unknown time, midnight-straddling
UTC uncertainty and rollback. It does not accept a boolean saying identity or
budget safety has already been established.

`te_identity_begin_boot` gets entropy from the configured cryptographic provider,
creates a UUIDv4 candidate, reserves it durably and only then returns the boot
UUID. `te_identity_generate` likewise returns a batch UUID only after reservation.
`te_identity_reserve` accepts an already generated UUID candidate, but the caller
must not freeze or publish a body with it before `TE_IDENTITY_OK`.

Every mutation uses the same injected outer lock across audit, capacity query,
the **real `cp_v3_budget_charge`**, a second capacity query, backend commit and
exact byte readback. The second capacity check follows the budget's own possible
checkpoint write. A failed write is not refunded. Ambiguous commit/readback,
duplicate UUID, zero/old/repeated sequence, capacity exhaustion, clock failure
or any other denial latches this owner closed. Do not reset the object to retry.

The canonical 5,288-byte record retains the node, up to 128 random boot UUIDs,
all up to 128 batch UUIDs with original boot index and strictly increasing
per-boot sequence, and conservative UTC bounds. All prior batches and boots
remain present across modeled reboot. A fresh owner always reserves a new boot;
it cannot resume or impersonate a historical boot. No ring eviction, clearing,
acknowledgement, queue deletion, migration or capacity-reset API exists.

`TE_IDENTITY_IDS_MAX == 128`, matching `TE_RT_WINDOW_IDS_MAX`. This bound applies
to the entire retained ledger, including previous boots; it is deliberately more
conservative than resetting the table each boot. At 128 batches or 128 boots,
new work stops. A separate monotonic and UTC-upper-bound check stops each boot
at **two hours**, even with fewer than 128 batches. At 30-second windows the table
can fill in about 64 minutes. Neither bound is a long-running identity solution.

Each mutation charges 16,384 logical storage bytes before backend mutation.
Capacity requires at least 302 currently available NVS entries: a 128-entry spare
floor, rounded blob bytes and eight entries of provider allowance. These are
conservative **logical admission values**, not measured physical flash writes,
GC amplification, endurance, or proof that this blob fits the existing partition
alongside old queues and budget journals. The core will not be board-ready until
a dedicated backend validates the actual representation and available capacity.

SHA-256 and CRC32 detect accidental damage; they are not authentication. This
core cannot detect malicious rewrite of all storage, external erasure, or a
backend that lies about persistence/readback. The backend must preserve every
successfully committed state across reboot and report torn/foreign/ambiguous
nonempty state instead of inventing absence. Other writers must actually share
the same lock and node storage budget; C callback types alone cannot prove that.

## API integration boundary

1. Open/configure the real same-node shared storage budget, retaining its stable
   `SHA256("campuspulse/3\\0t-energy-budget/1\\0storage\\0" + node)` owner.
2. Construct one boot-lifetime `te_identity_t` and `te_identity_config_t` with
   the durable backend, budget, common outer NVS lock, trusted UTC/monotonic
   clock, SHA-256 and cryptographic entropy functions. `open` itself is read-only.
3. Call `te_identity_begin_boot` before exposing the boot UUID to registration.
   Do not overwrite the previously registered boot UUID in place mid-session.
4. `te_identity_reserve_callback` has the signature required by
   `board_runtime_adapters.reserve_identity`. A future composite I/O context must
   forward this callback to its identity owner. The existing adapter's `io`
   serves other callbacks too; assigning it directly to this ledger is generally
   insufficient. This directory does not change or connect that adapter.
5. Once reserved, retries use the original frozen bytes and identity; reserving
   the same UUID again fails. Recover historical queued records through their
   existing verified path without creating new reservations or changing scope.

The backend is injected because neither generic successful callbacks nor a host
RAM model prove physical NVS durability. Physical integration needs a dedicated
stable namespace and a demonstrated conservative interrupted-write protocol,
full medium audit, exact readback, shared arbitration and actual entry usage.
There is intentionally no unsafe fallback or automatic storage reset.

## Verification

Run from the repository root:

```sh
bash firmware/t-energy-v3-trial/identity/tests/run.sh
```

The runner compiles C11 with warnings as errors, AddressSanitizer and
UndefinedBehaviorSanitizer, linking the real shared budget core, OpenSSL SHA-256
and independent zlib CRC32 verification. Test entropy is explicitly deterministic
synthetic input. The injected backend keeps only its modeled committed image
across resets; it is neither an NVS emulator nor a physical power-cut test.

Coverage includes exact lock/charge/commit order; budget checkpoint failures;
unknown/insufficient space; node and budget-owner mismatch; repeated/old/zero
sequence and UUID reuse across boots; generated identities withheld on failure;
partial records and malformed/checksum-repaired records; commit-before-error,
stale success and readback errors; rollback and unknown/uncertain time; both
capacity limits; the independent two-hour cutoff; and 12 interruptions before
or after backend operations followed by discarded RAM state and re-open.
Prior published UUIDs remain consumed after every modeled restart, and a new
reservation whose commit landed is consumed even if its caller never saw success.

The standalone `identity.c` translation unit also passed ESP32-S3 Xtensa GCC
14.2.0 with `-std=c11 -Wall -Wextra -Werror` on 2026-10-30. This is an object
compilation check, not a linked firmware, physical NVS test or device acceptance.

This implementation introduces no third-party copied code; it calls the existing
CampusPulse budget component and host OpenSSL/zlib dependencies. It does not
modify shared components, main sources, build manifests, partitions or firmware
runners outside this directory.

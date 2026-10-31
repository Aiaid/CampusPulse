# Explicit legacy-cache maintenance image

Status (2026-10-31): implemented and host tested; separate SDK images must be
reviewed and physically executed by the authorized operator. A passing host
test or build does not establish that the board key was deleted.

The user authorized clearing the older cache. The selected minimum scope is
**only default NVS namespace `scanstats`, key `devs`, BLOB length12300 bytes**.
Private full-Flash and NVS backups remain preserved. No other existing key,
namespace, v2 `cpqueue` record, Flash partition or partition table is selected.

`CONFIG_TE_SMALL_CLEAR_LEGACY_SCANSTATS=y` selects a separate application entry.
It defaults off and is mutually exclusive with the normal-reboot checkpoint.
CMake compiles only `maintenance_main.c` and `legacy_scanstats_maintenance.c`,
requiring `nvs_flash` and `esp_partition`; the normal V3/radio/network sources
are excluded. Normal and checkpoint images do not link this maintenance core.

The entry verifies the installed default NVS metadata (`0x9000`,24 KiB), then:

1. Call `nvs_flash_init()` once, with no erase or reinitialization fallback.
2. Obtain numeric before statistics. Open only `scanstats` read-only and inspect
   `devs` type and length. No cache bytes, identifiers or payloads are read/logged.
   Wrong type or length denies writing. Positive absence reports already absent.
3. Reopen that same namespace for writing and repeat the exact type/length
   check. Call `nvs_erase_key(handle,"devs")` at most once, then `nvs_commit()`
   at most once. No namespace-wide or partition-wide erasure API is present.
4. Close and reopen read-only. Both key lookup and blob-size lookup must return
   `ESP_ERR_NVS_NOT_FOUND`. Only a successful commit and this verification can
   report a new successful deletion. Commit/erase/readback failures remain
   uncertain; there is no automatic retry or fallback. Already absent is never
   represented as a deletion performed during this boot.
5. Print numeric before/after NVS statistics and the sanitized result/stage.
   Remain in USB standby without starting Wi-Fi, BLE, observation upload or
   automatic restart. The operator subsequently installs the reviewed checkpoint
   or normal application using an application-only write.

The previous read-only backup analysis counted390 live entries for this cache.
Starting from available34, deleting exactly that cache is expected to yield
available424 while retaining its namespace entry; this is an expectation to
verify physically. SDK GC can move preserved records, so physical NVS-sector
identity is not the preservation criterion. Compare all other live key/type/
length/value hashes privately and preserve the old `cpqueue` byte-for-byte.
Do not print retained values or hashes which could disclose identifiers.

Neither the356-entry runtime admission floor nor the128-entry adapter spare
floor is lowered. Storage layout and the existing partition table stay unchanged.

Run the isolated, device-free test from the repository root:

```sh
bash firmware/t-energy-v3-trial/tests/run_maintenance_host_test.sh
```

The ASan/UBSan test compiles the actual core against SDK substitutes which
reject every other namespace/key, expose no queue/partition/erase-all API, and
never return cache contents. It covers exact successful scope, idempotent
absence, wrong/changed type or length, failed initialization, erase ambiguity,
failed commit, conflicting absence lookups, failed verification and statistics.
Protected namespace/queue sentinels remain unchanged. This is host fault evidence,
not physical power-loss or SDK GC/endurance acceptance.

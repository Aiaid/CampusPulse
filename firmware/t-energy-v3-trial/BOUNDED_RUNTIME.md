# Bounded T-Energy runtime and acceptance

Status (2026-10-31): standalone runtime implemented; host/build evidence is
separate from actual device acceptance. No physical operation is implied here.

The official [LILYGO T-Energy-S3 repository](https://github.com/Xinyuan-LilyGO/T-Energy-S3)
lists V1.0, ESP32-S3-R8, 16 MB Flash and 8 MB octal PSRAM. Only pin/model facts
are referenced; no vendor application code was imported. Existing NVS `0x9000`/
24 KiB, factory app `0x10000`/3 MiB and `cpqueue` `0x360000`/4 MiB geometry stays
unchanged. Do not apply another board's partition layout.

## Runtime order and limits

1. Wait for physical USB with cryptographic boot UUID and a fresh host clock.
   One boot owns transport and queue; the collector owns only BLE aggregation.
2. Check installed geometry, initialize NVS without erase fallback, open the
   node-scoped persisted storage/uplink budgets, then the three-slot statistics
   namespace. Reject unknown keys/types and corrupt/foreign occupied records.
3. Connect strict TLS and recover original exact old-boot records. Historical
   ACK/lease use `X-Receipt-Only: 1`; missing committed receipts stop the trial.
   Statistics frozen body/time is checked and the server validates original
   policy/lease/scope. Nothing is rewritten under this boot's identity.
4. Recheck NVS entries, register supported capability, get the real policy and
   allocate aligned PSRAM through shared capture. Freeze/commit/reopen/readback
   the applied ACK before POST; require stateful plus stateless receipt checks
   and durable reclamation. Do the same for a separate lease. Wait through the
   conservative server-time activation guard before starting the scanner.
5. Serialize one unknown-only result per window. Assign UUID/sequence once,
   commit exact body, reopen/compare, then release the exact handoff. Uncertain
   writes retain the same in-memory identity and stop. POST frozen bytes only
   after their conservative end time; reclaim only after a strict durable
   receipt. Repeat the first exact POST and require the same receipt.
6. Renew leases; shared capture independently enforces a guarded monotonic
   deadline. After the explicit bound, pause/drain, upload final status and stop
   transport. Logs distinguish volatile handoffs, loss, retry and failure state.

Policy: 30/60 s, 5 s bins, at most512 keys; one1024-byte window, one1024-byte
status and one1024-byte control reserve; flash journal3072 bytes/3 records.
Candidate reports, raw and address detail are off. Optional rolling history is
at most600 s/2 s/512tracks/64open states, reporting off. Working budget at most
4 MiB; storage logical authorization at most1 MiB/day, POST bodies128 KiB/day.
A policy may tighten limits; unsupported admission commits an honest failed ACK.

The profile requires a conservative356 currently available NVS entries, then
rechecks each actual mutation. This is a snapshot, not physically reserved
space or a GC/write-amplification guarantee. All application NVS and budget
mutations share one lock; Wi-Fi uses RAM settings and NimBLE persistence is off.
Reboot burns unused persisted budget credit. Unknown time, midnight uncertainty,
corrupt state and uncertain commit stop admission. Valid expiry tombstones are
retained and can be reused only by the adapter's increasing-ordinal transition.

## Physical acceptance

The parent/operator owns all serial and flashing actions. Reidentify board/port,
privately back up/hash-check the table, NVS and full3 MiB app before an app-only
write. Preserve the separate old v2 `pending=13, quarantined=0` baseline. Do not
write the table, `cpqueue`, bootloader or a padded merged image for this install.

Private input files are the existing owned0600 `backend-bootstrap-tenergy.json`
and an explicitly selected Wi-Fi JSON. Production uses canonical
`https://pulse.anend.net`, `tls: public_ca_bundle` and no CA fields. First
validate without opening a device, from this project directory:

```sh
uv run tools/host_bootstrap.py --private-dir PRIVATE --wifi-file WIFI \
  --allow-production --windows 3
```

Only add `--send --port PORT` for the authorized board. Retain private serial
and server evidence: NVS admission, actual arena sizes/alignment, applied ACK/
lease, three real windows, loss counters, first-window exact duplicate, status,
pending0 and safe transport cleanup. Public isolation needs a separate read test.

For normal-reboot custody, build the explicit checkpoint config
`CONFIG_TE_SMALL_TEST_HOLD_FIRST_COMMIT=y`, request one window, and wait for
`normal_reboot_checkpoint` with durable1/noPOST/volatile0. Reset normally or
install only the normal app; never erase/format. A fresh USB bootstrap must log
`historical_exact_recovered`, with the same server body hash/UUID/sequence and
original old-boot scope before any new collection. The checkpoint app can also
recover the old record before holding its next window. This is a normal-reboot
experiment, not arbitrary power-loss acceptance.

## Remaining acceptance

Host sanitizers/builds do not prove NVS GC, arbitrary cut-power behavior,
whole-medium rollback protection, saturated512-key RF, long offline operation,
sustained throughput/CPU, power draw, battery duration or unattended collection.
RAM reports not yet committed can be lost on reset; their exact count after
power loss is unavailable. A bounded three-window run does not remove these
limits. BLE-visible keys are not people counts or proof of RF completeness.

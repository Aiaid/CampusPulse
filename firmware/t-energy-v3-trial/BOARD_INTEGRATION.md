# T-Energy-S3 V3 small-statistics integration checklist

**Historical strict-coordinator experiment.** This checklist describes the
unadmitted `main.c`/`board_coordinator` experiment, not the compiled application.
The 2026-10-31 build selects the separate `small_runtime.c` bounded entry; see
[bounded runtime and acceptance](BOUNDED_RUNTIME.md). Runtime measurements and
short acceptance do not set this experiment's CPU/scanner/power-loss verified
flags or establish unattended use.

Status: **integration and acceptance pending**, 2026-10-30. This is a plan for
T-Energy-S3 V1.0/R8, not evidence of device execution or permission to flash.
The protocol authority is [`v3-small-statistics.md`](../../docs/specs/v3-small-statistics.md).
That specification can describe behavior whose server or device implementation
is still in progress; verify the actual versions before enabling the board.

The current board entry is deliberately closed: `te_v3_runtime_ready()` returns
false before NVS, USB setup, BLE and network start, and `run()` returns false. The
old per-address feature upload loop was removed. The existing scanner and queue
code are scaffolding, not an implementation of the new statistics contract.
The settings wrapper and PSRAM admission helpers have host tests but are not a
running provisioning or statistics service. Do not enable the gate to make a
build or a demo pass.

## Memory and window admission

- [ ] Obtain actual sizes and alignment from the finalized shared statistics and
  temporal APIs at the negotiated capacity; do not derive allocation from a
  guessed C structure size. The board ceiling is 512 retained address/type keys
  per window; lower policy capacities must be honored. `cp_v3_stats` currently
  declares a maximum of 12 bins, while the wire specification allows up to 60;
  reject unsupported layouts instead of advertising the wire maximum.
- [ ] Allocate the report pool, statistics workspace and, when enabled, temporal
  workspace separately in PSRAM, verify every returned region and required
  alignment, and roll back all allocations if any fails. The existing three-pool
  admission helper is preparatory; connect it to the actual shared core APIs and
  prove lifetime/ownership. Check fragmentation and largest free external block,
  not just total free bytes. Its reserve calculation is a snapshot, not a
  guarantee against allocator overhead or concurrent work; remeasure after all
  allocations and TLS/radio startup and reject insufficient headroom.
- [ ] Budget rolling history separately from the current upload window and queue.
  Ten minutes at 2 s means 300 slices; 512 × 300 × 12–16 bytes is roughly
  1.8–2.4 MB before track state, events, alignment and all other allocations.
  This is an estimate, not the shared implementation's measured size. Budget 1 s
  slices separately and reject any unsupported or unaffordable configuration.
  Verify open state survives history rollover; uploading a window must not reset
  temporal history. Set and test bounded track and open-event limits.
- [ ] For a normal completed window, emit **one window-statistics item**, not one
  item per retained key. Cover fixed/mobile profiles 60000/5000 and 30000/5000 ms
  if supported, boundary and partial closures, empty/overfull windows, and a
  512-key full table plus overflow. Preserve actual scan coverage, missing RSSI,
  callback/aggregation drops and their quality bits. Verify category and bin
  invariants against the specification; `unclassified-v1` puts retained keys in
  unknown and is not a people or vehicle count. No addresses or payloads enter
  the default body.

## BLE ownership and handoff

- [ ] Keep the NimBLE callback bounded and nonblocking: timestamp and copy only
  SDK-delivered metadata/payload into an owned bounded slot; do not allocate,
  encode JSON, touch NVS or perform network operations there. The current
  128-slot callback pool is only a starting point, not an acceptance measurement.
  The old trial report structure and its old evidence consumer must be replaced
  or adapted to every field required by the finalized statistics API, including
  RSSI and report/fragment type; do not invent values for missing fields.
- [ ] Define one worker as owner of the statistics/temporal contexts and slot
  return. Ensure reports copied before callback return, no use after slot return,
  and correct exclusive window boundaries with in-flight callbacks drained before
  sealing. Test close/stop races, queued reports crossing a boundary, overflow,
  oversize/invalid input, sequence gaps, BLE reset and scan stop/start. Expose
  loss counters without logging identifiers or payloads. Snapshot and serialization
  must not mutate or race with the worker's active state.
- [ ] Test the actual local report stream, scan-state transitions and resulting
  closed-window invariants on the host before board testing. SDK-delivered reports
  are a subset of radio traffic; even a zero drop counter cannot prove full radio
  coverage or accuracy.

## NVS, old records and leases

- [ ] The experimental NVS adapter supports **at most three occupied encoded records
  total**, shared across kinds, each at most 2048 bytes including its envelope;
  with the developing 518-byte small-results envelope this leaves at most 1530 body bytes.
  The small-statistics adapter passes host integration with mock NVS, but is not
  wired into a running board service. Measure the actual frozen
  window/status/event envelopes, encoding and queue overhead against this limit;
  reject oversize or insufficient capacity and report the reason. Do not advertise
  twelve physical records, 4096-byte bodies, or independent stream reserves merely
  because the generic queue exposes them. Establish a tested policy for all slots
  occupied and for status/control pressure without overwriting unacknowledged data.
  The backend's synthetic 30 s and 60 s examples were 585 and 678 body bytes;
  with the then-current 518-byte queue overhead these would be 1103 and 1196
  encoded bytes. This arithmetic is not a measured real-device batch, maximum
  bound, or evidence that the shared NVS has three records' space.
  A later backend synthetic dense 512-key/20,000-report example measured 798
  body bytes, or 878 with longest test node/policy IDs. A schema-valid wide
  12-bin example measured 1442 bytes and exceeds the proposed 1024-byte body
  policy. Oversize is an explicit rejection/backpressure condition, not truncation.
- [ ] NVS is the existing shared 24 KiB partition. Three keys do not reserve space:
  measure available entries and realistic credential/settings/diagnostic usage,
  concurrent writers, GC and write amplification; serialize capacity checks and
  mutations with all other NVS users. Host fault tests do not prove physical power
  loss behavior or endurance. Do not erase/reinitialize NVS on error, silently
  format it, or modify existing `cpqueue`; NVS GC can move/erase physical pages.
  The capability builder requires separate actual power-loss-recovery evidence;
  a capacity snapshot or host mock alone cannot satisfy that field.
  Define and test a durable cross-restart write budget and trusted-time rollback
  behavior, including its own metadata and NVS amplification, before claiming a
  per-day write limit. A dual-domain board budget now passes mock-NVS restart,
  partial-commit and clock-boundary tests; it is not wired to the live runtime or
  validated against actual NVS space, garbage collection or physical power loss.
- [ ] Implement new statistics receipts and queue recovery under the final backend
  contract: retain exact frozen body, original node/boot, per-stream sequence,
  batch, hash, policy/generation and observation time through `accept_until`.
  Validate the complete committed small-statistics receipt before reclamation;
  HTTP success or broker ACK alone is insufficient. Do not rewrite old-boot data
  under a new boot. The small queue supports explicit same-node historical replay;
  the board runtime has a receipt-only control adapter but has not validated its
  full board integration or connected a verified local resource ledger. Test exact
  retry, duplicate receipt, changed body/scope,
  timeout after server commit, reboot, expired/revoked policy and corrupt records.
- [ ] Implement explicit lease renewal and recovery under the current server
  contract. The backend verifies the original observation's applied policy,
  placement, lease span and cloud quota; the board keeps the exact frozen body,
  checks its local resource ledger and never invents new old-boot observations.
  Unknown or unprovable local time fails closed. A late renewal starts a
  new span and cannot cover the gap; new observations never borrow an old boot's
  authority. Test renew-before-expiry, gap, clock step/uncertainty, config/place
  change, reboot and server rejection. GET, status or replayed ACK do not renew.

## Provisioning, measurements and gate

- [ ] Integrate physical USB setup with a single reader and explicit ownership of
  radio/network transitions. Existing `board_settings` matches node identity and
  saves only after an injected validator succeeds; it is not yet wired to the USB
  session or a real authenticated validator. Verify existing settings survive an
  invalid candidate, disconnect, validation failure, failed save and reboot; never
  log credentials or replace active configuration before verified acceptance.
- [ ] Measure real encoded bytes per normal window, plus separate status, lease,
  retry, TLS and control traffic. The 1 KB/minute figure is a design target, not
  an established result. Measure callback drops, 512-key pressure, processing
  latency, queue occupancy, upload latency and balance, PSRAM free/minimum/largest
  block, internal heap free/minimum/largest block, and task stack high-water under
  BLE + Wi-Fi/TLS, disconnect/reconnect and saturation. Record board/firmware and
  policy versions and distinguish host replay from physical measurements.
- [ ] Keep the gate closed until shared core and server contract are integrated,
  supported capabilities and policy bounds match actual resources, collection and
  upload have explicit applied ACK and lease, three-record custody and historical
  retry are implemented, and host integration/fault tests plus reviewed board
  acceptance pass. Check the actual installed partition table and data before
  device work. Use separate verified images and preserve existing device data;
  a passing build or host test is not physical acceptance.

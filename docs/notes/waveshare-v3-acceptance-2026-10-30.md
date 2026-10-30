# Waveshare direct v3 physical acceptance — 2026-10-30

Status: **bounded controlled-test device/server loop passed**. These are real
SDK-delivered BLE observations from the Waveshare V2; the host performed physical
USB bootstrap/time delivery and evidence inspection, not observation upload.
The backend used a private isolated Miniflare/workerd D1/R2 environment behind
an HTTPS quick tunnel with public CA validation. This is not a production D1
deployment or production activation.

## Accepted chain

Board capability registration → server assignment → full policy/capability hash
validation → actual resource preparation → board `applied` ACK → committed ACK
receipt → BLE worker extraction → whole-window TF frozen queue → board HTTPS
feature/status upload → exact committed receipt → durable queue reclamation.

The independent backend session verified the database after each run. It never
sent a device ACK or uploaded observations on the board's behalf. Private
configuration, identity, serial logs and database snapshots remain ignored;
no passwords, device identities, raw addresses, tokens or endpoint appear here.

| Image / run | Live reports / worker | Callback drops | Identifier keys | Address-overflow reports | Accepted feature / status batches |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.2.2, window 1 | 1198 / 1198 | 0 | 8 | 664 | 8 / 1 |
| 0.2.2, window 2 | 1248 / 1248 | 0 | 8 | 768 | 8 / 1 |
| 0.2.4, clean reboot, window 1 | 1227 / 1227 | 0 | 8 | 908 | 8 / 1 |

Windows were ten seconds with one-second configuration bins. Company IDs and
Appearance are bounded protocol evidence, not device categories or people
counts. Address capacity is deliberately eight for the initial whole-window
queue; the overflow report counts are real and must not be hidden. This trial
does not prove all visible addresses or all over-the-air reports were retained.

The two-window run produced 18 unique committed batches, 36,801 body bytes,
feature sequence 1–16 and status sequence 1–2. Canonical whole-window evidence
sizes were 13,261 and 13,275 bytes. The clean-reboot run produced 9 unique
committed batches, 18,384 body bytes and 13,256 evidence bytes. Both runs repeated
the first feature with identical frozen bytes and obtained the same receipt.
The backend independently matched receipt metadata to stored body hash, boot,
stream and sequence; exact retries did not create duplicate items.

The final run also experienced one real 15-second response-header timeout.
The original TF batch remained pending, was retried unchanged and completed;
the later deliberate duplicate again returned its original receipt. This
exercises a bounded request timeout/retry, not a physical Wi-Fi outage or a
power cut while writing.

## Storage, memory and cleanup

The final boot reopened the prior run's TF queue with feature/status pending=0,
retired=0 and corrupt=0. At final completion it reported feature/status pending=0
and queue I/O failures=0. Network stop and TF unmount both returned success
before final PASS. Historical raw files were not read, uploaded, formatted or
deleted by this trial. Only the existing app partition was written; the
bootloader, partition table and NVS were preserved and privately backed up.

The queue has eight feature, two status and two control reserves, each with a
4,096-byte maximum body. Normal slot bytes are 73,728; a 262,144-byte pool is
reserved for temporary/record/ACK intent artifacts and metadata. File fsync,
checked rename/unlink and record CRC/SHA support recovery; ESP-IDF SDMMC
`CTRL_SYNC` is a no-op, so this does not prove physical card-cache power-loss
safety.

The first image failed an ACK TLS attempt; a second correctly committed a
`resource_exhausted` failed ACK after observing insufficient internal RAM. These
histories were preserved. TLS, NimBLE host buffers and CPU-only display buffers
were moved to verified PSRAM, with internal SPI/DMA buffers retained and the
resource gate unchanged. Successful internal free memory was about 101 KiB
during operation; observed minimum was 90,035 bytes in 0.2.2 and 88,343 bytes
in 0.2.4. Minimum trial-task stack was 6,436 / 6,356 bytes. Final queue write
budget charges were 331,776 / 165,888 bytes. These are bounded-run measurements,
not endurance or sustained-throughput claims.

In 0.2.4 bootstrap UTC comes from a nonce-correlated physical-host/device monotonic
exchange with measured RTT and a declared 250 ms trusted-host clock allowance;
500 ppm drift and observation uncertainty are propagated. Full TLS date,
hostname and CA checks remain enabled. Clock correctness against an external
time reference was not established. The earlier 0.2.2 run used a declared
500 ms host seed without measuring USB delivery latency; its successful
receipts do not independently establish that absolute uncertainty bound.

## Boundaries and next work

- No production v3/CPRAW gate or deployment was enabled. The temporary public
  test entry is closed after final backend verification; private source TTL
  cleanup and minimal receipt retention are owned by the backend test service.
- Current board image is 0.2.4-v3-trial. It has completed the bounded run and
  stopped network/storage; another boot waits for a fresh USB bootstrap. It is
  not a saved-configuration, unattended collector.
- Continuous BLE/Wi-Fi coexistence, real network interruption, pending-batch
  power-loss/reboot recovery, source-retention cleanup on the device, lease
  renewal, ordinary USB onboarding and larger-capacity throughput need separate
  acceptance. T-Energy still needs its actual Flash journal adapter and board
  validation; it does not inherit TF durability from this result.
- Full binary raw upload and R2-first detailed storage remain a separate
  architectural direction. This small feature-JSON trial proves the v3 control,
  custody and receipt interfaces; it is not a long-term storage-format decision.

Implementation: [trial firmware](../../firmware/waveshare-v3-trial/README.md).
Backend evidence: [integration note](v3-backend-integration-2026-10-30.md).

# T-Energy V3 memory probe

Independent diagnostic image for the T-Energy-S3 V1.0 profile: 16 MB flash,
8 MB octal PSRAM in the [vendor repository](https://github.com/Xinyuan-LilyGO/T-Energy-S3).
The running firmware identified the connected board as T-Energy-S3 V1.0; the
probe verified ESP32-S3, 16 MB flash and 8 MB PSRAM, but did not visually inspect
the board silkscreen. This does not
run collection, network, provisioning or NVS initialization. It reports the NVS
partition size only; real free entries are **unavailable**. Initializing NVS may
complete interrupted updates, so even a read-only NVS handle is not sufficient
proof of non-writing behavior. No NVS data are read or printed. The old cpqueue
partition is not accessed. The CSV is identical to the existing T-Energy table.

At startup it reports physical flash/PSRAM size and capability-specific total,
free, minimum and largest heap block before, during and after allocating the
actual shared statistics and temporal arenas in external RAM. Layout is the
current component ABI: 512 tracks, 600 s history, 2 s slices, 64 open and 64
terminal events, plus a 512-key 60 s statistics window. Both arenas coexist;
initialization is checked, no observations are inserted, then they are cleared
and freed. Minimum is the allocator's lifetime low-water mark, not reset per
phase. Startup heap in this image does not account for future BLE, Wi-Fi, TLS,
queues or application allocations, and success does not prove operational
capacity or stability. Values and identifiers from the device are never output.

Build only with activated ESP-IDF 5.5.3: `./build.sh`. Builds are external and
no device is opened. A flash overwrites the existing application; preserve the
existing firmware and data first.
Do not use erase-flash, merged images, or write the partition table casually.

## Bounded board result, 2026-10-30

The identified T-Energy was temporarily run with this probe after the complete
3 MiB application partition was privately backed up. Only the app region was
written; afterwards the original app was restored and esptool verified its
write. The original runtime booted and reported 13 pending, zero quarantined
queue items. The probe itself did not access the queue or initialize NVS.

| Measurement | Before allocation | Both arenas allocated |
| --- | ---: | ---: |
| External free | 8,386,192 B | 6,476,264 B |
| Largest external block | 8,257,536 B | 6,422,528 B |
| Internal free | 383,003 B | 383,003 B |
| Largest internal block | 286,720 B | 286,720 B |

The 512-key statistics arena was 11,504 B and the 512-track/300-slice temporal
arena was 1,898,416 B; both allocated and initialized successfully. External
free returned to 8,386,192 B after release. This diagnostic did not initialize
BLE, Wi-Fi, TLS or the upload queue and did not determine NVS free space,
runtime CPU use, long-run behavior or power-loss recovery. It does not validate
full V3 operation or establish a live capture.

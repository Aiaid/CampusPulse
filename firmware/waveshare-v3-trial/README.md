# Waveshare direct v3 acceptance image

Status: `0.2.4-v3-trial`, 2026-10-30. This is a bounded controlled-test image
for the verified ESP32-S3-ePaper-1.54 V2, with direct board-owned v3 HTTPS.
The [physical acceptance note](../../docs/notes/waveshare-v3-acceptance-2026-10-30.md)
records the successful board and independent database checks. It is not an
unattended production collector or the offline raw recorder image.

The board registers its actual boot/capabilities, validates the complete policy
and canonical hash, checks/reserves resources with scanning paused, sends its
own applied ACK, and waits for the committed receipt before scanning. A BLE
callback copies reports into 128 preallocated PSRAM slots without disk/network
work. A worker extracts bounded company/Appearance evidence with window-only
random tokens. Eight feature records and a status record are frozen and synced
to TF before any upload. Reclamation requires exact committed receipt matching.
An intentional exact retry must return the same receipt.

The shared components have no display/TF requirement: `cp_v3_control`,
`cp_v3_evidence`, `cp_v3_queue` and `cp_v3_transport`. This board uses a TF adapter;
the future T-Energy collector needs its actual Flash adapter and its own memory,
write-endurance and coexistence acceptance. The current trial advertises eight
identifiers to match eight durable feature slots, not the component's sixteen
identifier ceiling or a proposed production capacity.

## Safety and custody

- Existing 8 MiB Flash geometry is retained; flash only the app at `0x10000`
  after checking the live partition table. No TF format or raw-file deletion.
- `/sdcard/cpv3queue` is separate from historical `/sdcard/cpraw`. Fixed reserves
  are 8 feature + 2 status + 2 control, 4,096 body bytes each. Reserve 262,144
  filesystem bytes for records, temporary/ACK intent files and metadata. The
  policy body capacity is 49,152 bytes. Interrupted/old-boot records quarantine
  and block this fresh-boot trial rather than being reidentified or overwritten.
- TLS uses CA/hostname/date validation. TLS allocations, NimBLE host data and
  CPU-only display render/history use PSRAM. SPI/DMA buffers remain internal.
  Resource failure sends a real failed ACK and cannot enable scanning.
- Every boot waits for a physical USB bootstrap. Credentials stay in RAM and
  are cleared after stop; no v2/MQTT runtime or automatic reconnect is started.
  USB HELLO is nonce-correlated and supplies device monotonic time. Host RTT
  bounds the UTC anchor plus an explicitly assumed 250 ms trusted-host clock
  allowance; later drift is conservatively propagated at 500 ppm. This is not
  independent validation of the host's absolute clock.
- PWR long press cancels bounded I/O and waits for safe network/storage/display
  closure. Final PASS is emitted only after successful network stop and TF
  unmount. The image stops after one to three requested windows; restart waits
  for a fresh bootstrap. It does not resume ordinary raw recording automatically.

Physical power-cut survival, pending-batch reboot recovery, retention cleanup,
continuous scanning while uploading, larger address capacity and steady-state
throughput remain unaccepted. The test reports address-overflow reports; zero
callback drops is not proof of complete radio capture. The current server
subset requires `local_raw=off`; no full-raw uploader is implemented here.

## Reproduce in an isolated environment

This historical per-identifier feature runner remains isolated-only and rejects
the production host before opening serial. The user's later production release
authorization applies to the selected small-statistics collector documented in
[`firmware/waveshare-v3/`](../waveshare-v3/README.md), whose host runner requires
`--allow-production` and system CA verification. The shared USB parser and
transport retain strict origin validation; this historical record does not
establish acceptance against the production deployment.

Activate ESP-IDF 5.5.3 and its S3 toolchain, then run `bash build.sh` with pinned
LVGL 9.5.0 (`RAW_LVGL_PATH` can select the existing managed component). The build
and verifier produce separate images and never access a device.

After explicit app-only flashing, prepare an ignored mode-0700 private directory
with mode-0600 `backend-bootstrap.json` from the backend test owner and
`wifi.json` containing the user's Wi-Fi settings. No endpoint/token is a default.
Use the IDF Python environment containing pyserial through uv:

```sh
UV_CACHE_DIR=/tmp/campuspulse-v3-uv uv run --no-project \
  --python "$IDF_PYTHON_ENV_PATH/bin/python" python -u run_trial.py \
  --port /dev/cu.usbmodemYOUR_PORT --private-dir /private/test/config --windows 2
```

The host supplies configuration/time and records logs only. It does not register
capabilities, acknowledge configuration or translate/upload BLE observations.
The backend owner separately assigns a policy and independently verifies D1
items, receipts and absence of public projection. The temporary test endpoint
must be explicitly closed and its private source TTL maintained after the run.

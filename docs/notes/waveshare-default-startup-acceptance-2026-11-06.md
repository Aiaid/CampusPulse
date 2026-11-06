# Waveshare automatic setup and saved startup acceptance — 2026-11-06

Status: bounded production-device acceptance passed for automatic initial
policy delivery, saved PEAP without a CA, and normal restart recovery. This
does not establish arbitrary power-loss recovery, the full planned restart
cycle, all-day operation, or battery endurance. All times below are
Asia/Shanghai (UTC+8).

## Release and preservation

Source `884e715` was deployed directly to the existing production service for
the user-authorized rapid test; this record does not claim a new full hosted
CI run. The published Worker version was
`8e0ef609-a6b3-43db-9dfc-998053943370`.

The matched Waveshare ESP32-S3-ePaper-1.54 V2 received application
`0.4.1-autostart`: 1,711,840 bytes, SHA-256
`c976fa91569a3ebea2ad9d5a68268dc32b5fe32f61ec9f50e7cc9198197798b3`.
A fresh complete 8 MiB Flash backup was taken after safe USB confirmation.
The backup was verified against the device immediately before writing only
the application at `0x10000`. A full readback before boot matched the new app;
NVS, the bootloader prefix, partition table and protected tail from `0x310000`
were byte-for-byte unchanged. TF content was preserved. Subsequent explicit
startup saving legitimately updates its owned NVS records.

Strict C11 sanitizer tests covered the capability-bounded policy wait,
clock/expiry boundaries, cancellation and permanent denial. The unchanged
329-glyph font passed its pinned generator check/source scan. Actual LVGL
software rendering passed 85 frames, including waiting and expired states;
this is software layout evidence rather than a physical display measurement.

## Normal webpage setup

The operator confirmed enterprise PEAP/MSCHAPv2 with **no CA server
verification**. The operator entered the network credentials only in the
normal production webpage and clicked its default saved/continuous setup
button. No manual policy JSON preparation, assignment or renewal-grant
submission was used in this run.

- Fresh physical-device capabilities arrived at **15:43:53.962**.
- Generation **8** was generated and assigned automatically; the actual device
  committed its applied ACK at **15:44:05.076**.
- The automatic flow approved renewal revision **1**, using generation 8 as
  its source, with expiry **2026-11-13 15:44:11.110** and a 30-minute policy TTL.
- At **15:46:23**, the current boot had two committed window batches and two
  status batches. Its latest status reported zero window/event drops, upload
  failures and ACK failures. These are reported pipeline counters, not a claim
  of complete radio reception.

The frontend grant path requires the independent device `STARTUP SAVED`
notification and the matching committed ACK. Native Chrome accessibility
snapshots sometimes retained an older tree, so their stale "waiting" text was
not treated as current evidence. Successful later saved-profile boots provide
independent evidence of usable persistence; the post-save NVS format was not
separately dumped for this acceptance.

## Normal restart and diagnostic reconnect

The operator confirmed safe BOOT stop, USB disconnection, and normal PWR
shutdown/startup without entering new configuration. Host enumeration also
confirmed that the matched Waveshare USB device was absent.

| Boot event | First cloud registration | Assigned generation | Actual ACK | Windows at 15:57:38 |
| --- | --- | --- | --- | --- |
| Initial normal webpage setup | 15:43:53.962 | 8 | applied | 7 |
| Operator's normal restart without USB | 15:53:08.482 | 9 | applied | 0 |
| Subsequent USB diagnostic reconnect | 15:54:35.380 | 10 | applied | 2 |

These are distinct immutable boot identities, compared privately. The
USB-free boot already re-registered and obtained its new policy/ACK before the
diagnostic serial session began. USB was reconnected before that boot completed
a full statistics window; this record therefore does **not** claim a complete
battery-only window upload.

After the operator reported a persistent-looking startup screen, USB was
reconnected for passive diagnostics. The log recorded a
`USB_UART_CHIP_RESET`; the observer sent **no** setup, host-time, START or
RESTART commands. The resulting saved-profile boot recorded:

| Relative observation time | Event |
| --- | --- |
| 0.81 s | AUTO START |
| 3.81 s | AUTO CLOCK |
| 29.04 s | Pinned signed time verified; reported uncertainty 1,252 ms |
| 29.25 s | Normal Wi-Fi transport starts |
| 32.23 s | Capability registration starts |
| 44.33 s | Waiting for automatic policy |
| 47.73 s | Durable ACK exchange starts |
| 51.01 s | Actual statistics collection starts |

No clock retry, panic or assertion was observed in that capture. The backend
then confirmed generation 10 applied and accepted two new window and two
status batches. Latest upload/ACK failure and window/event drop counters were
zero. Renewal revision 1 retained its original generation-8 source and expiry;
no new operator grant or network configuration was supplied for these boots.
The reported clock uncertainty is a protocol bound, not a laboratory clock
calibration.

## Display follow-up and evidence limits

During signed-clock bootstrap, a temporary network owner can be connected while
the normal upload transport's displayed Wi-Fi flag still says off. The operator
later confirmed that the device recovered. The UI should identify this phase
as automatic network/time bootstrap rather than presenting the normal
transport's off state without context. This is a display-observability follow-up;
the recorded restart did obtain a new policy and the diagnostic boot continued
to upload.

The test used unverified-server PEAP only. It does not establish CA-verified
PEAP automatic startup or RADIUS certificate interoperability. Production
MQTT/TLS and signed-clock checks remained enabled. No credentials, network name,
account, device identifier or private capture is included here. Full backup,
readback, passive serial and read-only cloud snapshots remain in the ignored
`captures/waveshare-auto-delivery-20261106/` directory.

# Waveshare battery display acceptance, 2026-10-30

The V2 raw recorder battery test image `0.1.5-battery` was built with
ESP-IDF 5.5.3 and separately verified. Before flashing, the active TF writer
reported safe stop, the 8 MiB device Flash was privately backed up, and its
partition table matched the new image. Only the application at `0x10000` was
written; the flash tool reported hash verification. The TF card was not erased.

After reboot, serial logs showed `RECORDING` and screen rendering, with zero
software queue drops in the brief observed interval. The user saw approximately
4.03 V, estimated 85%, and `ETA --` while USB was connected. This confirms the
device displayed an ADC-derived value, not its accuracy against a meter. Serial
reconnection triggered new boot sessions during the check.

The ADC uses the V2 board's GPIO4/ADC1 channel 3 and 1:2 divider. The percentage
is a coarse linear voltage approximation, not a calibrated fuel gauge; source,
charging state and battery presence are unknown. USB charging and load can
change voltage. Capacity, voltage accuracy, power consumption, offline discharge
and meaningful remaining-time estimates still need physical validation.
USB provisioning and uploads were not part of this image's active behavior.

A later app-only experimental image `0.1.8-usb-v2-experiment` adds optional
USB setup. An earlier 0.1.6 test asserted in observer-only NimBLE teardown on
long BOOT; 0.1.7 retained an idle host and the user confirmed the USB setup
page after a safe stop. USB serial open then caused a reset, so 0.1.8 also
lets an explicit `begin` safely stop recording and enter setup. Its real USB
`begin` and `info` handshake succeeded without sending credentials. Full
browser, Wi-Fi/TLS, credential save/recovery and power-button acceptance remain
open; setup leaves raw stopped until restart. After this check, a USB reconnect
restarted the board and serial status again showed `RECORDING`. No upload or v3
producer is active.

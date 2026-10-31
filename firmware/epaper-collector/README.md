> **Historical target retired, 2026-10-31.** The V1/V2 application and protocol
> build entry have been removed. Retained board drivers, UI/fonts, algorithm
> sources, license/provenance and this historical documentation are reference
> assets only. Current firmware is [V3](../waveshare-v3/README.md). This does not establish a
> Passport C3 V3 migration or device acceptance.

# Waveshare ePaper collector (V2)

This project selects the ESP32-S3-ePaper-1.54 V2 adapter explicitly, separate
from T-Energy-S3 despite the shared ESP32-S3 target. Confirm the physical V2
marking before use: its ESP32-S3-PICO-1-N8R8 has 8 MB flash and 8 MB PSRAM.
The source profile uses the 200 x 200 SSD1681 panel, native USB setup, and the
current shared collection, persistent queue, and upload chain. Buttons and
battery measurement are not implemented. Display refresh is asynchronous and
rate limited; status is not a real-time display.

Raw BLE advertising reports are governed by the applied capture policy. The
current shared v2 firmware supports `sampled` with at most four reports per
window, not complete raw capture. A policy must allow `ble_reports` and enable
sampling before any raw reports can be collected. The default enrollment policy
turns raw capture off. A general upload ACK on the display does not prove that
a raw batch was stored, nor does it establish radio completeness.

Build with ESP-IDF 5.5.3, its ESP32-S3 toolchain and `uv` activated:
`./firmware/epaper-collector/build.sh`. This produces separate bootloader,
partition and app images in a fresh temporary directory and checks their flash
geometry. It does not flash or erase a device. The queue has a fixed 4 MiB
partition at 0x360000; inspect the physical board and preserve existing data
before any future device operation. No physical validation of this current
integration, raw upload throughput, display, or power use is implied by a build.

## Reuse and license

The board and SSD1681 card originate from the CampusPulse ePaper branch
`463269d`, adapted to the current board API and USB-only setup. The 5x7 ASCII
glyph table in `cp_ui_epaper/font5x7.c` comes from Adafruit GFX `glcdfont.c`,
copyright 2012 Adafruit Industries, BSD-2-Clause; the full license is retained
in that source and must accompany binary distributions. The panel driver and
card layout were authored for CampusPulse.

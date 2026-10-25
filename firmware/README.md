# CampusPulse firmware

The current local AI Passport implementation connects protected browser BLE or
device-hosted SoftAP setup, durable enrollment, v2 policy control, canonical
MAC/address-type summaries, a frozen Flash journal and exact upload receipts.
See the [firmware chain and evidence boundaries](../docs/notes/firmware-chain.md).
The initial chain's software acceptance passed on 2026-10-25, including four
fresh C3 image variants. Its server is deployed and one Passport application
update/startup was verified while retaining protected data. Physical enrollment
and capture/upload acceptance remain separate. The
[short PIN and USB revision](../docs/specs/local-provisioning-v2.md) passes local
native/SDK/browser checks and four C3 configurations; its physical acceptance
is recorded separately. The T-Energy-S3 boards and the Waveshare ePaper card
remain pending independently verified profiles and layouts; the headless
Waveshare collection target below has build-only acceptance.

The project entry is [ai-passport-radar](ai-passport-radar/README.md), imported at
the user's request on 2026-10-24. Shared components live under `components/`.
Normal boot waits for setup or starts the authenticated network/control path;
collection requires an accepted, applied and unexpired policy. Optional UI does
not own collection timing. The inherited Radar remains an explicit diagnostic
mode, separate from canonical collection and cloud observations.

A Waveshare ESP32-S3-ePaper-1.54 collection target with a status card builds
from [epaper-collector](epaper-collector/). It runs the same canonical collector
and v2 protocol with an S3 board adapter, keeps a 3 MB application plus the
shared 4 MB `cpqueue` at `0x360000`, and uses the native USB Serial/JTAG setup
path. One board has joined an enterprise PEAP network, applied a policy, scanned,
completed ACKed uploads and rendered the card with last-window identifiers,
reports, RSSI and the last ACK time. Power measurement and a fixed campus
placement remain pending. Build with
`idf.py --no-ccache -B build -D IDF_TARGET=esp32s3 build`, then check separate
images with `firmware/tools/verify_images.py build --layout epaper`.

Activate ESP-IDF 5.5.3 and its Python environment, then run:

```bash
firmware/tools/check-chain.sh
node scripts/provisioning-browser-smoke.mjs
npx vitest run tests/provisioning
firmware/tools/build-passport.sh
firmware/tools/build-passport.sh --diagnostic
firmware/tools/build-passport.sh --headless
firmware/tools/build-passport.sh --diagnostic --headless
```

The chain helper includes native sanitizer/fault tests and sends literal C-codec
fixtures to a real isolated local workerd/D1/R2 instance. The browser script uses
synthetic cloud/GATT and WebKit for the device page; it cannot validate physical
Bluetooth or iPhone hotspot connectivity. The two build flags select diagnostics
and no LCD/buttons; they do not select another board family. The USB revision
gives normal headless builds a physical setup path without a displayed code.
Connecting a cable alone does not enter setup; select USB in the administrator
wizard. It requires a desktop browser exposing Web Serial. iPhone/iPad browser
setup uses the local hotspot of a display-equipped device.

Builds use fresh directories and validate separate bootloader, partition and app
images. Python operations use `uv`. No helper deploys or flashes hardware.
Preserve the 3 MiB application and `cardid` at `0x356000` / `0x4000`; inspect the
actual device layout before writing a partition table. The declared 4 MiB queue
at `0x360000` is not evidence that an attached board's region is empty. Unknown
journal bytes are quarantined, never automatically formatted. Never erase the
whole chip or flash a padded merged image across protected data.

Target networks support explicit WPA2 personal, open Wi-Fi and WPA2 Enterprise
PEAP/MSCHAPv2 with optional outer identity. Enterprise server certificate checks
are disabled at the user's request; upload HTTPS retains CA/hostname/date checks.
Captive portal login is not automated. Legacy personal-network settings load
without an NVS rewrite. See [network diagnostics](../docs/notes/device-onboarding-diagnostics.md)
for the settings migration, failure history and verification boundaries.
Runtime secrets remain outside tracked files; application NVS is not encrypted
storage at rest. Physical revision, TLS/network behavior, Flash power-loss
recovery, radio losses, memory margins and sustained upload remain hardware gates.
The user authorized publication of the selected current firmware on 2026-10-25.
The inherited font arrays have been replaced with licensed OFL derivatives;
[font notices](fonts/README.md) must accompany redistribution. Original private
repository history, captures and credentials remain excluded. See [import notes](../docs/notes/firmware-baseline.md)
and [reuse record](../docs/notes/reuse.md).

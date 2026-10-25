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
is recorded separately. T-Energy-S3 and Waveshare support remain
pending independently verified profiles and layouts.

The project entry is [ai-passport-radar](ai-passport-radar/README.md), imported at
the user's request on 2026-10-24. Shared components live under `components/`.
Normal boot waits for setup or starts the authenticated network/control path;
collection requires an accepted, applied and unexpired policy. Optional UI does
not own collection timing. The inherited Radar remains an explicit diagnostic
mode, separate from canonical collection and cloud observations.

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

Only WPA2 personal target networks are supported by this provisioning slice.
Runtime secrets remain outside tracked files; application NVS is not encrypted
storage at rest. Physical revision, TLS/network behavior, Flash power-loss
recovery, radio losses, memory margins and sustained upload remain hardware gates.
The user authorized publication of the selected current firmware on 2026-10-25.
The inherited font arrays have been replaced with licensed OFL derivatives;
[font notices](fonts/README.md) must accompany redistribution. Original private
repository history, captures and credentials remain excluded. See [import notes](../docs/notes/firmware-baseline.md)
and [reuse record](../docs/notes/reuse.md).

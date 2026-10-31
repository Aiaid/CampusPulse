# CampusPulse V3 firmware

The active network applications are [Waveshare V3](waveshare-v3/README.md)
and [T-Energy-S3 V3](t-energy-v3-trial/README.md). They share the independent
`cp_v3_*` capture, statistics, temporal evidence, control, budget, queue and
transport components. Production transport is native MQTT/TLS through the
Hangzhou EMQX broker and authenticated Cloudflare gateway. Exact application
receipts govern reclamation; a broker PUBACK is not durable cloud custody.
Both applications retain their documented bounded acceptance limits.

V1/V2 ingestion, enrollment, policy, provisioning and network application code
was retired on 2026-10-31. The Passport C3, earlier T-Energy shared-chain and
ePaper collector build entries are removed. This is a software retirement,
not a Passport C3 V3 migration or five-board hardware acceptance. Board BSP,
fonts/UI, passive-BLE and vehicle algorithms, licenses and provenance remain
available. `cp_core` contains neutral board/display types only, with no policy
supervisor. `cp_usb` retains only framing used by the offline raw recorder.

[Waveshare offline raw](waveshare-raw/README.md), its CPRAW tools and the actual
V3 local-TF dependencies remain independent. The old optional USB-v2 network
setup adapter is removed; hardware revision V2, existing USB export formats and
CPRAW format versions are unrelated to the retired collection wire protocol.
The Waveshare V3 app still reuses board/TF/UI adapters from `waveshare-raw` and
bootstrap code from `waveshare-v3-trial`. Keep these source trees together.

Settings retain read-only decoding of older saved NVS credential layouts so
credential preservation does not require erasure. Retiring protocol code does
not delete or rewrite existing captures, TF files, old NVS, Flash `cpqueue`,
private backups or ignored build directories. A pending historical queue is
not treated as a V3 queue and is not automatically replayed or cleared.

Use ESP-IDF 5.5.3 and `uv` for Python commands. Activate its Python/toolchain
environment, then build the two separate applications:

```bash
firmware/waveshare-v3/build.sh
firmware/t-energy-v3-trial/build.sh
```

The build helpers produce separate images and never flash hardware. Verify the
actual board revision, installed partitions and protected contents before any
future device write. Never erase the chip or flash padded merged images across
protected data. Historical hardware measurements and captures keep their original
scope; passing host tests or builds establishes no new radio, battery, endurance
or power-loss acceptance. See [font notices](fonts/README.md) and
[reuse provenance](../docs/notes/reuse.md).

# CampusPulse

[简体中文](README.zh_CN.md) · [Documentation](docs/README.md) ·
[Roadmap](docs/design/ROADMAP.md)

CampusPulse explores how BLE observations can help describe activity across a
campus. This public repository begins the hackathon implementation from a fresh
baseline.

## Starting point

The initial commit contains project documentation and development rules only.
Firmware, the receiver, and the user interface have not been implemented in this
repository. There is no runnable demo yet.

The intended first milestone is one observation node sending data to a receiver,
with a simple view that distinguishes live observations from simulated data.
BLE-visible identifiers must not be presented as exact people counts.

## Prior work

Pre-hackathon prototypes inform the design and known hardware constraints. Their
application code, deployments, credentials, captures, and databases are not part
of this initial public baseline. Previous test results do not validate the new
implementation.

Implementation will be written incrementally. Any code actually reused must be
identified, attributed, and checked for license compatibility in the
[reuse record](docs/notes/reuse.md).

## Development

Start with the [roadmap](docs/design/ROADMAP.md) and [project rules](AGENTS.md).
The planned hardware target is the FoloToy AI Passport ESP32-C3 with 8 MB Flash,
no PSRAM, and ESP-IDF 5.5.3. Software architecture and data contracts remain to be
decided during the hackathon.

Keep secrets and raw observations out of Git. Use `uv` for Python tasks, and
report builds, automated tests, and physical device validation separately.

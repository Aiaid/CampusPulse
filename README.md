# CampusPulse

[简体中文](README.zh_CN.md) · [Documentation](docs/README.md) ·
[Roadmap](docs/design/ROADMAP.md) · [Hackathon plan (中文)](docs/design/hackathon-plan.md)

CampusPulse explores how BLE observations can help describe activity across a
campus. This public repository begins the hackathon implementation from a fresh
baseline.

## Starting point

The repository currently contains documentation, development rules, and a prior
visual concept reference.
Firmware, the receiver, and the user interface have not been implemented in this
repository. There is no runnable demo yet.

The proposed MVP combines two fixed BLE observation nodes, manual parking and
elevator-wait observations, a campus map, and an e-paper place display.
The interface distinguishes sensor observations, manual reports, and simulations.
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
Available hardware: two AI Passports, two LILYGO T-Energy-S3 boards, and one
Waveshare 1.54-inch ESP32-S3 ePaper board. The frontend, API, and database will all
run on Cloudflare; the proposed stack is Workers Static Assets, Workers, and D1.
Board revisions, data contracts, and acceptance criteria still need validation.

Keep secrets and raw observations out of Git. Use `uv` for Python tasks, and
report builds, automated tests, and physical device validation separately.

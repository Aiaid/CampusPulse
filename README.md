# CampusPulse

[简体中文](README.zh_CN.md) · [Documentation](docs/README.md) ·
[Roadmap](docs/design/ROADMAP.md) · [Hackathon plan (中文)](docs/design/hackathon-plan.md)

CampusPulse explores how BLE observations can help describe activity across a
campus. This public repository begins the hackathon implementation from a fresh
baseline.

## Starting point

The first runnable slice includes a React/Three.js frontend, official CCNU GIS
tile-base integration, and a Cloudflare Workers/D1 API for places and manual
observations. Sensor ingestion, firmware, raw R2 archival, and hardware validation
remain unimplemented. See [local setup](docs/notes/development.md).
The first web/API release is available at
[campuspulse.anend.workers.dev](https://campuspulse.anend.workers.dev);
[deployment and costs](docs/notes/ci-cd.md) describe its validation and limits.

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
Research raw uploads add private R2 storage; see the [upload protocol draft](docs/specs/ingest-v1.md).
Board revisions, data contracts, and acceptance criteria still need validation.

Keep secrets and raw observations out of Git. Use `uv` for Python tasks, and
report builds, automated tests, and physical device validation separately.

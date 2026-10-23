# Documentation

This index describes the new hackathon baseline. Historical prototypes and their
validation records are not evidence for this implementation.

## Start here / 合作者阅读顺序

1. Read the [project introduction](../README.md) ([简体中文](../README.zh_CN.md))
   for the motivation, CCNU scenarios, time-aware observations and current progress.
2. Use the [architecture overview](notes/architecture.md) for the stack, data flow
   and source layout, then the [development guide](notes/development.md) to run locally.
3. Choose work from the [roadmap](design/ROADMAP.md) and read the relevant API or
   device specification below. Implemented routes and protocol drafts have separate statuses.

## Document index

| Document | Purpose | Status |
| --- | --- | --- |
| [Architecture overview](notes/architecture.md) | Stack, current data flow, source layout and planned hardware roles | Current Canvas frontend/API; device path planned |
| [Frontend migration and lighting](design/frontend-lighting.md) | October 21 interaction migration, light comparison and rendering choices | Local visual/read-only QA passed; write-flow browser approval pending |
| [Frontend reuse manifest](notes/frontend-reuse-manifest.json) | Exact reused source/destination file fingerprints | Current source provenance |
| [Local development](notes/development.md) | Run, test and configure the web/API slice | Current |
| [CI/CD](notes/ci-cd.md) | GitHub checks, Cloudflare setup, online validation and costs | Hosted CI/CD and first cloud deployment verified |
| [Web API v0](specs/web-api-v0.md) | Public reads, shared-operator writes and `/docs` / OpenAPI usage | Interactive contract and local Swagger UI browser validation passed |
| [CCNU GIS](research/ccnu-gis.md) | Official tile source, image coordinates and integration limits | Current research |
| [Hackathon plan / 黑客松方案](design/hackathon-plan.md) | Product scope, all-five collection/upload baseline, later Passport interaction/ePaper display, architecture and acceptance | Current hardware design; web/API first release deployed, firmware and device acceptance pending |
| [Upload protocol v1 / 上传协议](specs/ingest-v1.md) | Window/raw/status streams, MAC and AD payload, private R2, durable ACK | Current draft; not implemented |
| [Roadmap](design/ROADMAP.md) | Priorities, planned milestones, completed work | Current |
| [Reuse record](notes/reuse.md) | Prior-work boundary and code attribution | Current |
| [T-Energy-S3 enclosure research](research/t-energy-s3-enclosure.md) | Author-published enclosure links and official mechanical drawing | Sources checked; fit/print unverified |
| [Pre-hackathon observations](upstream/pre-hackathon/observations.md) | Prior BLE/storage/network/GIS observations with source fingerprints | Historical reference; not rerun |
| [Pre-hackathon vehicle rules](upstream/pre-hackathon/vehicle-rules.md) | Earlier candidate logic and its evidence boundaries | Historical; not implemented in this repository |
| [Pre-hackathon wire protocol](upstream/pre-hackathon/wire-v0.md) | Earlier binary format and ACK/auth semantics | Historical; superseded for new design by v1 draft |

Add specifications under `specs/`, designs under `design/`, engineering notes
under `notes/`, and research logs under `research/`. Update this index when adding
documents; mark superseded documents rather than silently deleting their history.

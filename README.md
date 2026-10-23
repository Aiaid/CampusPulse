# CampusPulse

[简体中文](README.zh_CN.md) · [Documentation](docs/README.md) ·
[Roadmap](docs/design/ROADMAP.md) · [Online prototype](https://campuspulse.anend.workers.dev)

CampusPulse aims to bring place activity, e-bike parking observations, and recent
measured elevator waits onto one campus map. This hackathon project focuses on
Central China Normal University (CCNU). The first web application and manual
recording flow are implemented; device sensing is still planned.

## From related explorations to CCNU's needs

Related campus-sensing and map-visualization projects provide a starting point:
connect scattered observations to places so people can understand activity around
campus. CampusPulse builds on that idea by considering CCNU's specific settings:
what to collect, how to present it, and where field observations are needed.

Alongside changes in activity near a place, we want to include e-bike parking and
elevator waits. These three questions call for different kinds of observations:

| Setting | Question we want to answer | Intended source |
| --- | --- | --- |
| Place activity | Has activity near an observation point changed recently? | BLE observation windows from fixed nodes; collection is not implemented yet |
| E-bike parking | What vehicle-count range was most recently observed at a parking point? | Manual parking records; vehicle advertisement candidates are a later research direction |
| Elevator waits | Where and when was a wait measured, and how long did it take? | Manual records of completed waits |

BLE-visible identifiers are not people or vehicle counts. A measured elevator
wait is not a prediction of the current wait. Each kind of information keeps its
own source and unit.

## Why time matters

Activity, parking, and elevator conditions change. A place and a single value do
not tell a reader whether an observation is still useful. Each observation also
needs to say **when it was made, where it came from, and when it expires**, with
access to recent records.

We therefore want to show observations over time at each place: what happened
recently, how it compares with earlier observations, and which information is
stale. Places without observations show no coverage or no data. We do not infer
a campus-wide heatmap or fill gaps in field data with simulations.

## Adding observations to the existing campus GIS

CCNU already has an [official campus GIS](https://gis.ccnu.edu.cn/) that provides
the spatial context for campus places. CampusPulse connects observations with
their time and source to those places, gradually adding activity, parking, and
elevator-wait information.

The web application already uses the official GIS base map. Buildings on the map
do not imply installed sensors or campus-wide coverage. Parking and elevator
points are still logical demonstration places that need field confirmation. See
the [GIS investigation](docs/research/ccnu-gis.md) for integration and coordinate
boundaries.

## Current progress

As of 2026-10-23, this repository contains:

| Area | Current status |
| --- | --- |
| Campus web application | GIS base map, place selection, details, and a phone layout implemented |
| Manual records | Submission and cancellation of parking ranges and completed elevator-wait seconds implemented; writes require an operator credential |
| Time and source | Observation time, validity, history queries, and stale markers implemented for manual records |
| Simulation | Separate, explicitly labeled synthetic demonstration; does not write field records |
| Web delivery | First release deployed, with automated checks, cloud delivery, and browser verification recorded |
| BLE and hardware | Planned: all five devices collect, buffer and upload first; both AI Passports then add interaction, and ePaper adds a place card. Firmware and device acceptance remain pending |
| Research raw data | Upload protocol drafted; raw-batch archival and acknowledgement are not implemented |

Visit the [online prototype](https://campuspulse.anend.workers.dev) to explore the
current flow. It opens in the explicitly labeled “模拟演示” mode with synthetic
data. Switch to “现场观察” for field records; empty summaries are expected when
there are no manual records. Field submissions require a credential from
the project administrator; local development uses a locally chosen credential.

The recorded verification covers the web and manual-recording flow. It does not
establish BLE reception, hardware acceptance, or field validation on campus. The
next priorities are the data contracts, one sensing node and its upload path,
followed by adaptation and individual collection/upload acceptance on all five
devices, multi-point verification, then Passport interaction and ePaper display. See the
[roadmap](docs/design/ROADMAP.md) for the full scope and priorities.

## Where contributors should start

- **Product goals and device roles:** [overall plan (中文)](docs/design/hackathon-plan.md) and [roadmap](docs/design/ROADMAP.md).
- **Stack, data flow, and source layout:** [technical and architecture overview](docs/notes/architecture.md).
- **Run and verify locally:** [development guide](docs/notes/development.md).
- **Work on APIs or sensing:** [implemented web API](docs/specs/web-api-v0.md) and [upload protocol draft, not yet implemented](docs/specs/ingest-v1.md).
- **Delivery and collaboration rules:** [CI/CD](docs/notes/ci-cd.md) and [project instructions](AGENTS.md). With the current configuration, passing checks on `main` trigger automatic deployment.

This repository implements the hackathon application incrementally from a fresh
baseline. Pre-hackathon material informs design and hardware constraints;
historical validation does not validate this implementation. Sources, reuse
boundaries, and license records are in the [reuse notes](docs/notes/reuse.md).
See the [full documentation index](docs/README.md) for further reading.

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
| [Onboarding and network diagnostics](notes/device-onboarding-diagnostics.md) | Existing-device Wi-Fi reconfiguration, direct versioned edits, retained safe diagnostics and observed serial-open reset | Implementation/verification in progress; original network failure not yet attributable |
| [Lighting performance / 光照性能](notes/lighting-performance.md) | Background compilation, scoped caches, cropped high-DPI canvases and matched Chrome measurements | Locally optimized; hardware-accelerated Chrome comparison and renderer regression; production/Safari acceptance separate |
| [GIS location settings](notes/gis-location-settings.md) | Full official image grid and four tile levels, shared location registry and admin image CSP | Corrected locally 2026-10-25; native Safari with real tiles, HTTP CSP and desktop/phone fixture regressions; deployment separate |
| [Passport firmware chain](notes/firmware-chain.md) | Local provisioning, enrollment, strict TLS/control leases, canonical MAC summaries and durable ACK journal | Published 2026-10-25; one Passport app-only update, protected-data comparison, startup and native USB verified; real enrollment/capture acceptance remains separate |
| [Short PIN and USB provisioning](specs/local-provisioning-v2.md) | Expiring numeric PIN, Security 2 and physical USB setup for headless nodes | SDK/native/browser tests and four C3 configurations pass; one Passport startup/native USB verified; physical BLE/phone/Wi-Fi acceptance separate |
| [Firmware runtime stage A](notes/firmware-runtime.md) | FreeRTOS ownership, shared lifecycle, factory identity, Passport adapter and diagnostic/headless builds | Historical `8018d17` stage-A snapshot; its three builds/tests passed, current runtime superseded by firmware-chain note |
| [Admin browser compatibility](notes/admin-browser-compatibility.md) | Safari cosmetic-filter diagnosis, dedicated CSS namespace and optional Passkey extension reports | Local 350-test release snapshot, real-Worker CTAP2 and desktop/phone regressions passed; physical Safari enrollment separate |
| [Firmware platform and onboarding](design/firmware-platform.md) | Multi-board boundaries, administrator local setup, policy activation and Passport local markers | Passport chain and short PIN/USB revision locally verified; other boards and manual markers pending |
| [Firmware open raster fonts](../firmware/fonts/README.md) | Pinned official OFL source, license/copyright notices, reproducible generated tables and preserved UI coverage | Replaced and rebuilt 2026-10-25; 141 text / 11 digit coverage and native layout/API tests pass; included in the updated Passport |
| [AI Passport firmware baseline](notes/firmware-baseline.md) | User-selected Radar source import, protected partition layout, provenance and next integration slices | Historical import `82549b0`; current software chain has separate evidence; hardware acceptance pending; current arrays replaced with OFL fonts, historical snapshots retained |
| [Simulation scenarios](notes/simulation.md) | Teaching-day/weekend/rain profiles, full-day replay and separate parking intensity | Locally verified: 198 frontend tests, build, desktop/390px browser isolation; frontend-only synthetic data |
| [Administrator account and Passkeys / 账号与安全](specs/admin-auth-v1.md) | First-use bootstrap, password login, profile/password changes, Passkey management, reauthentication and session revocation | Locally verified:60 auth/management tests, real CTAP2 browser/workerd, nine deploy-origin cases; production/physical acceptance separate |
| [Admin v1 / 管理后台](specs/admin-v1.md) | Independent admin session, device health/credentials, deployments, editable capture drafts, runtime settings and audit | Locally verified: 14 admin integration tests, real workerd/browser workflows and phone layout; deployment/device activation separate |
| [Architecture overview](notes/architecture.md) | Stack, current data flow, source layout and planned hardware roles | Current frontend/API; v1 cloud-demo verified, Passport v2 chain implemented locally with separate hardware/deployment gates |
| [Frontend migration and lighting](design/frontend-lighting.md) | Shared materials, responsive framing and selected-library detail presentation | Library trial history plus full-campus extension link; current campus build/190 tests and browser checks; no DB/deploy |
| [Full-campus material lighting](design/campus-lighting.md) | Data-driven campus geometry, indexed shared light field and bounded viewport chunks | Implemented locally; all eight places, source-preserving materials and legacy comparisons; integration acceptance recorded in visual QA |
| [Library-entry lighting experiment](design/library-entry-lighting.md) | Source-preserving scene and physical-vs-display actor calibration | P1 resolved; representative static/motion style accepted at 16/13px; full-campus extension separate; no exhaustive-pose claim |
| [Generated scene material provenance](notes/library-tree-generation.md) | Generated asset hashes and no-GIS-input provenance, distinct from runtime official-source processing | Generated bytes unchanged; separate in-memory CORS source path is not a bundled GIS asset |
| [Frontend reuse manifest](notes/frontend-reuse-manifest.json) | Exact reused source/destination file fingerprints | Current source provenance |
| [Ingestion server](notes/backend-ingestion.md) | API, provisioning, field projection, retention and acceptance boundaries | Cloudflare deployed; three-stream demo/ACK/private archive/isolation checks passed |
| [Local development](notes/development.md) | Run, test and configure the web/API slice | Current |
| [CI/CD](notes/ci-cd.md) | GitHub checks, Cloudflare setup, online validation and costs | Hosted CI/CD and first cloud deployment verified |
| [Custom domain and mainland connectivity](notes/mainland-connectivity-2026-10-23.md) | `pulse.anend.net` binding and independent DNS/HTTP probe reports | Bound and tested on 2026-10-23; mainland reachability improved, some probe anomalies remain |
| [Web API v0](specs/web-api-v0.md) | Public reads, shared-operator writes and `/docs` / OpenAPI usage | Interactive contract and local Swagger UI browser validation passed |
| [CCNU GIS](research/ccnu-gis.md) | Official tile source, image coordinates and integration limits | Current research |
| [Hackathon plan / 黑客松方案](design/hackathon-plan.md) | Product scope, all-five collection/upload baseline, later Passport interaction/ePaper display, architecture and acceptance | Current hardware design; web/API first release deployed, firmware and device acceptance pending |
| [Device protocol v2](specs/device-v2.md) | Pre-config contact, current-boot activation, canonical address summaries, immutable receipts and private retention | Literal C-codec checks pass against isolated workerd/D1/R2; production server deployed 2026-10-25; physical enrollment/capture acceptance separate |
| [Upload protocol v1 / 上传协议](specs/ingest-v1.md) | Window/raw/status streams, MAC and AD payload, private R2, durable ACK | Server deployed and demo-verified; physical-node onboarding and firmware pending |
| [Roadmap](design/ROADMAP.md) | Priorities, planned milestones, completed work | Current |
| [Reuse record](notes/reuse.md) | Prior-work boundary and code attribution | Current |
| [T-Energy-S3 enclosure research](research/t-energy-s3-enclosure.md) | Author-published enclosure links and official mechanical drawing | Sources checked; fit/print unverified |
| [Pre-hackathon observations](upstream/pre-hackathon/observations.md) | Prior BLE/storage/network/GIS observations with source fingerprints | Historical reference; not rerun |
| [Pre-hackathon vehicle rules](upstream/pre-hackathon/vehicle-rules.md) | Earlier candidate logic and its evidence boundaries | Historical; not implemented in this repository |
| [Pre-hackathon wire protocol](upstream/pre-hackathon/wire-v0.md) | Earlier binary format and ACK/auth semantics | Historical; superseded for new design by v1 draft |

Add specifications under `specs/`, designs under `design/`, engineering notes
under `notes/`, and research logs under `research/`. Update this index when adding
documents; mark superseded documents rather than silently deleting their history.

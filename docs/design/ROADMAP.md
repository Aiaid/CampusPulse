# CampusPulse roadmap

Current planning baseline: [Hackathon plan](hackathon-plan.md), 2026-10-23.
The user selected all-Cloudflare hosting. All unchecked items are plans, not
implemented capabilities or measured results. The competition deadline and
mandatory track requirements remain unknown.

Hardware decision (2026-10-23): all five devices first implement BLE collection,
bounded durable buffering and direct HTTPS upload with one shared core and
board-specific adapters. AI Passport interaction and ePaper display follow that
baseline. This supersedes dedicated manual-only, beacon-only and display-only
assignments; firmware and device acceptance remain pending.

## P0 — Deliver the core MVP

- [ ] Provision the new ingestion server in production: reviewed D1 migration,
      real node/config/placement registries, private R2 binding and independent
      research secret; then deploy and verify synthetic cloud upload/retention.
      Local implementation acceptance is archived below; hardware remains separate.

- [ ] Confirm competition requirements, deadline, team capacity, and demo places.
- [ ] Inventory both T-Energy-S3 boards, both AI Passports, and the Waveshare
      1.54-inch ePaper variant; confirm protected data and board-specific layouts.
- [ ] Verify device/phone access to Cloudflare HTTPS on the actual demo network.
- [ ] Finalize observation, manual-report, privacy, retention, and freshness
      contracts; distinguish sensor/manual/demo data and live/replay modes.
- [ ] Review and freeze the [v1 ingestion draft](../specs/ingest-v1.md): window/raw/status
      streams, MAC/token/none identity policies, AD preservation, and batch ACKs.
- [ ] Freeze server/firmware compatibility against OpenAPI and strict validators;
      replay firmware-produced fixtures and verify ACK reclamation on device.
- [ ] Implement and verify the shared collection/upload core on one T-Energy:
      BLE windows, optional configured raw stream, status, durable buffering,
      independent ACKs, retries and safe reclamation.
- [ ] Adapt that core to T-Energy-S3, AI Passport and the confirmed Waveshare
      board; use board-specific drivers, flash layouts and memory budgets.
      Preserve Passport's protected app/cardid layout; do not initialize unused audio.
- [ ] Enable and individually verify collection and direct Cloudflare upload on
      both T-Energy boards, both Passports and the ePaper board; preserve
      unacknowledged data and report failures, losses, gaps and queue pressure.
- [ ] Register fixed placements and mobile placement changes; retain the old
      placement on queued data, split windows at changes and exclude unlocated
      transit records from fixed-place summaries without inventing GPS positions.
- [ ] After single-device acceptance, run at least two fixed placements together
      and reconcile each node separately; five devices do not imply five places
      or comparable people counts.
- [ ] Measure per-board local record size, ACK throughput and reclamation; add
      immediate size/age/watermark upload triggers, reserved control capacity,
      observable raw/scan pauses and recovery before storage exhaustion.
- [ ] Implement the map frontend on Workers Static Assets: place selection,
      local detail, recent trends, explicit coverage, freshness, and phone layout.
- [ ] Complete manual parking reports and elevator-wait timing, including
      cancellation/correction and visible cloud confirmation; phone entry first.
- [ ] Verify the end-to-end path on actual hardware and a real browser, including
      duplicate uploads, stale data, and a controlled network interruption.

## P1 — Add interaction and display after collection/upload acceptance

- [ ] Add ingestion rate limiting, operational alerts, capacity/orphan audits and
      a lease-safe orphan cleanup process; add research roles and versioned
      vehicle classification only after evaluation with independent evidence.

- [ ] On both AI Passports, add scan/network/queue/cloud-ACK status and explicit
      place selection, then manual parking reports and wait start/finish with
      cancel/correction and separate local-save/cloud-confirmed states.
- [ ] Provide a temporary, separately tagged controlled-beacon mode on a
      supported device; reserve no Passport permanently for testing. Track
      collection interruptions and keep test sessions out of public field metrics.
- [ ] Implement the Waveshare place card with source/time/valid-until text and
      a refresh strategy appropriate to the confirmed panel, after its upload
      path passes. Keep panel refresh independent of collection/upload tasks.
- [ ] Verify that Passport interaction and ePaper refresh preserve the measured
      collection/upload baseline; report scan pauses, backlog and memory pressure.
- [ ] Add clearly labeled simulation/replay without replacing failed live data.
- [ ] Record reproducible setup, builds, device checks, browser acceptance,
      limitations, and a demonstration script.

## P2 — Refine the product and presentation

- [ ] Complete explicitly approved browser submission/cancellation acceptance for
      the migrated field-record flow; the current local mutation check was blocked
      by automatic approval review.
- [ ] Evaluate registered depth/light masks or licensed baked night assets for
      greater fidelity beyond the fixed-raster warm-light treatment.
- [ ] Confirm map-asset display/redistribution rights before reusing the old GIS
      raster; otherwise use a self-authored schematic and manual place anchors.
- [ ] Compare BLE trends with manual reference observations; avoid inventing
      people/vehicle counts or predicted elevator waits.
- [ ] Evaluate the [T-Energy enclosure sources](../research/t-energy-s3-enclosure.md),
      measure the hardware, check model terms, and trial-print before fitting.
- [ ] If required by the competition, add source-grounded AI explanations after
      the core path works; validate model availability, cost, and missing-data behavior.
- [ ] Extend Passport with remote-place summaries and favorites after field
      entry works; optionally expose cloud AI answers with source/time and
      missing-data states. Validate resource impact before adding voice.

## P3 — Research and expansion

- [ ] Measure sustained BLE/Wi-Fi coexistence, power draw, and battery life.
- [ ] Study node-to-node comparability, identifier randomization, and sampling bias.
- [ ] Explore calibrated vehicle candidates, richer parking observations, and
      elevator reference models with separately acquired ground truth.
- [ ] Evaluate address-window summaries and candidate evidence from raw reports;
      keep association hypotheses separate from physical device identities.
- [ ] Evaluate map registration and broader coverage; retain unsupported states.

## P4 — Longer-term work

- [ ] Review deployment operations, maintenance, accessibility, and contribution.
- [ ] Decide on licensing before adding third-party implementation code or models.
- [ ] Audit documentation against the actual submitted implementation.

## Completed archive

- [x] Implement ingestion v1 server: scoped per-node credentials, immutable
      placement/config with append-only closures, strict three-stream validation,
      atomic D1 receipts and range exclusion, conditional private R2 archival,
      research-only AD parsing, field-only sensor projection, retention and secure
      provisioning helper. Local SQLite/workerd D1/R2 concurrency/failure tests,
      32-window transaction, build and nine-operation Swagger browser regression
      passed. See [acceptance and limits](../notes/backend-ingestion.md).
      Production provisioning/deployment and firmware/device validation pending.

- [x] Bind unused `pulse.anend.net` to the existing Worker without deploying
      local parallel work; independently probe mainland DNS, frontend, JS and
      read-only API. Reachability improved substantially, but download anomalies
      and actual demo-network/device acceptance remain open. See
      [connectivity evidence](../notes/mainland-connectivity-2026-10-23.md).

- [x] Publish same-origin `/docs` and `/openapi.json` for the six implemented
      operations with self-hosted Swagger UI, explicit shared-operator auth and
      errors. OpenAPI validation, 23 unit/contract tests, real local browser
      execution and hosted CI/CD run 39917142898 passed; online rendering,
      vendor hashes and token authentication were verified without production
      record writes. BLE ingestion and account-based authorization remain planned.

- [x] Migrate the user-selected October 21 UI: dual maps, shared replay, search,
      three independent layers, moving/parked sprites, occlusion, xray and phone
      sheet. Keep field records separate and load official tiles without bundling
      the old school raster. Add warm-light/original comparison; build, 18 tests,
      desktop/phone visual and read-only browser QA passed locally. Authenticated
      browser write acceptance remains separate and pending approval.

- [x] Update the hardware design to all-five collection/upload first, followed
      by Passport interaction and ePaper presentation; synchronize architecture,
      acceptance and implementation order. Design decision only, no new firmware
      or hardware validation.
- [x] Rewrite both READMEs around related work, CCNU activity/parking/elevator
      scenarios, time-aware observations and the existing GIS. Document current
      web progress separately from planned sensing; add a contributor architecture
      overview and reading order with stack and source-layout details in docs.
- [x] Verify production Cloudflare deployment after CF credentials and target
      resource IDs are configured: hosted run 39910663742 passed checks, D1
      migrations, Worker/Static Assets deployment and online smoke verification.
- [x] Complete the first production setup: provision APAC D1, configure scoped CI
      credentials, verify automatic deployment and real-browser/API behavior;
      keep local-reference tests outside the application test suite and replace
      the vulnerable Vitest 3 toolchain. Operator writes and cancellation passed
      with synthetic browser QA records; no BLE/hardware validation is claimed.

- [x] Add GitHub Actions PR/main tests, builds, local Worker browser checks and
      conditional Workers/D1 deployment; validate workflow with actionlint and
      generated config with Wrangler dry-run. First hosted CI run passed (39905700037);
      production deployment correctly skipped without Cloudflare configuration.

- [x] Build the first runnable React/Three.js frontend and Workers/D1 API slice:
      official CCNU GIS visible tiles, verified library image anchor, separate
      simulated scene, authenticated manual records and cancellation; local
      SQLite API tests/build/browser checks. No cloud or hardware validation.

- [x] Establish and publish a fresh documentation-only Git baseline, excluding
      local pre-hackathon source, deployments, captures, and databases.
- [x] Draft the overall product/MVP plan from prior design material and the
      five-device inventory; record the user's all-Cloudflare hosting choice.
- [x] Inspect and retain a metadata-checked prior concept image with provenance.
- [x] Find an author-published T-Energy-S3 enclosure reference and official DXF;
      document the unverified fit, printability, and external-model terms.
- [x] Commit and push the existing plan/design baseline as `b503243` before
      beginning the upload-protocol design.
- [x] Draft a new upload protocol and synthetic request/ACK examples; migrate
      selected pre-hackathon Markdown with provenance and historical boundaries.
- [x] Clone the invited Radar reference into ignored local storage and review
      its scan/parser/classification flow without publishing its private contents.

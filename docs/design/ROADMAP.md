# CampusPulse roadmap

Current planning baseline: [Hackathon plan](hackathon-plan.md), 2026-10-23.
The user selected all-Cloudflare hosting. All unchecked items are plans, not
implemented capabilities or measured results. The competition deadline and
mandatory track requirements remain unknown.

## P0 — Deliver the core MVP

- [ ] Verify production Cloudflare deployment after CF credentials and target
      resource IDs are configured.


- [ ] Confirm competition requirements, deadline, team capacity, and demo places.
- [ ] Inventory both T-Energy-S3 boards, both AI Passports, and the Waveshare
      1.54-inch ePaper variant; confirm protected data and board-specific layouts.
- [ ] Verify device/phone access to Cloudflare HTTPS on the actual demo network.
- [ ] Finalize observation, manual-report, privacy, retention, and freshness
      contracts; distinguish sensor/manual/demo data and live/replay modes.
- [ ] Review and freeze the [v1 ingestion draft](../specs/ingest-v1.md): window/raw/status
      streams, MAC/token/none identity policies, AD preservation, and batch ACKs.
- [ ] Generate machine schemas and meaningful contract fixtures after review;
      verify parser byte order, repeated AD elements, and malformed payload handling.
- [ ] Implement Workers ingestion + D1 persistence with authentication,
      validation, acknowledgement, and idempotent window/event handling.
- [ ] Add private R2 archival for research raw batches, D1 receipts, conflict
      handling, separate stream acknowledgement, and retention controls.
- [ ] Implement and verify one T-Energy BLE node before enabling the second.
- [ ] Run two fixed nodes with bounded durable buffering, failure counters,
      observable gaps, and offline recovery; preserve unacknowledged data.
- [ ] Measure per-board local record size, ACK throughput and reclamation; add
      immediate size/age/watermark upload triggers, reserved control capacity,
      observable raw/scan pauses and recovery before storage exhaustion.
- [ ] Implement the map frontend on Workers Static Assets: place selection,
      local detail, recent trends, explicit coverage, freshness, and phone layout.
- [ ] Complete manual parking reports and elevator-wait timing, including
      cancellation/correction and visible cloud confirmation; phone entry first.
- [ ] Verify the end-to-end path on actual hardware and a real browser, including
      duplicate uploads, stale data, and a controlled network interruption.

## P1 — Complete the hardware demonstration

- [ ] Add AI Passport field entry/status screens without copying the old app.
- [ ] Use the second Passport as a separately tagged controlled beacon and
      backup terminal; exclude test broadcasts from public activity metrics.
- [ ] Implement the Waveshare place card with source/time/valid-until text and
      a refresh strategy appropriate to the confirmed panel.
- [ ] Add clearly labeled simulation/replay without replacing failed live data.
- [ ] Record reproducible setup, builds, device checks, browser acceptance,
      limitations, and a demonstration script.

## P2 — Refine the product and presentation

- [ ] Adapt the earlier concept: light/night themes, overview/local detail,
      blue/orange scene layers, timeline, and phone bottom sheet.
- [ ] Confirm map-asset display/redistribution rights before reusing the old GIS
      raster; otherwise use a self-authored schematic and manual place anchors.
- [ ] Compare BLE trends with manual reference observations; avoid inventing
      people/vehicle counts or predicted elevator waits.
- [ ] Evaluate the [T-Energy enclosure sources](../research/t-energy-s3-enclosure.md),
      measure the hardware, check model terms, and trial-print before fitting.
- [ ] If required by the competition, add source-grounded AI explanations after
      the core path works; validate model availability, cost, and missing-data behavior.

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

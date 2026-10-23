# CampusPulse roadmap

Current planning baseline: [Hackathon plan](hackathon-plan.md), 2026-10-23.
The user selected all-Cloudflare hosting. All unchecked items are plans, not
implemented capabilities or measured results. The competition deadline and
mandatory track requirements remain unknown.

## P0 — Deliver the core MVP

- [ ] Confirm competition requirements, deadline, team capacity, and demo places.
- [ ] Inventory both T-Energy-S3 boards, both AI Passports, and the Waveshare
      1.54-inch ePaper variant; confirm protected data and board-specific layouts.
- [ ] Verify device/phone access to Cloudflare HTTPS on the actual demo network.
- [ ] Finalize observation, manual-report, privacy, retention, and freshness
      contracts; distinguish sensor/manual/demo data and live/replay modes.
- [ ] Implement Workers ingestion + D1 persistence with authentication,
      validation, acknowledgement, and idempotent window/event handling.
- [ ] Implement and verify one T-Energy BLE node before enabling the second.
- [ ] Run two fixed nodes with bounded durable buffering, failure counters,
      observable gaps, and offline recovery; preserve unacknowledged data.
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
- [ ] Evaluate map registration and broader coverage; retain unsupported states.

## P4 — Longer-term work

- [ ] Review deployment operations, maintenance, accessibility, and contribution.
- [ ] Decide on licensing before adding third-party implementation code or models.
- [ ] Audit documentation against the actual submitted implementation.

## Completed archive

- [x] Establish and publish a fresh documentation-only Git baseline, excluding
      local pre-hackathon source, deployments, captures, and databases.
- [x] Draft the overall product/MVP plan from prior design material and the
      five-device inventory; record the user's all-Cloudflare hosting choice.
- [x] Inspect and retain a metadata-checked prior concept image with provenance.
- [x] Find an author-published T-Energy-S3 enclosure reference and official DXF;
      document the unverified fit, printability, and external-model terms.

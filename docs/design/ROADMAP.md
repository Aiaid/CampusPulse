# CampusPulse roadmap

This roadmap starts the hackathon implementation. Unchecked items are plans,
not implemented capabilities or measured results.

## P0 — Define and demonstrate the first complete path

- [ ] Confirm hackathon requirements, demo scenario, and acceptance criteria.
- [ ] Define a minimal observation format and privacy/retention policy before
      collecting or publishing new data.
- [ ] Implement one BLE observation node, preserving protected Flash regions.
- [ ] Implement receiver ingestion with observable failures and sequence gaps.
- [ ] Show received observations in a simple interface with explicit data origin.
- [ ] Verify the complete path on hardware and record evidence and limitations.

## P1 — Make the demo dependable

- [ ] Add bounded offline buffering, acknowledgement, and reconnection handling.
- [ ] Expose queue losses, storage exhaustion, and upload failures.
- [ ] Separate device upload authentication from operator access.
- [ ] Add reproducible build/run instructions and focused automated checks.

## P2 — Make observations useful

- [ ] Compare observation windows with manual reference observations.
- [ ] Explore a location/time view without claiming exact people counts.
- [ ] Prepare a clearly labeled simulated-data demo and presentation narrative.

## P3 — Research and expansion

- [ ] Evaluate BLE/Wi-Fi coexistence, power use, and sustained operation.
- [ ] Study multi-node comparability and identifier randomization bias.
- [ ] Evaluate map integration and aggregate activity estimates.

## P4 — Longer-term work

- [ ] Review deployment, maintenance, accessibility, and contributor workflows.
- [ ] Decide on licensing before adding third-party implementation code.
- [ ] Audit documentation against the final submitted implementation.

## Completed archive

- [x] Establish a fresh documentation-only Git baseline and exclude local
      pre-hackathon reference material from version control.

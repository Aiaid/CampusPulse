# CampusPulse roadmap

Current planning baseline: [Hackathon plan](hackathon-plan.md), 2026-10-23.
The user selected all-Cloudflare hosting. Unchecked items mark remaining work
or acceptance; any partial local implementation is identified explicitly below.
Competition deadline: 2026-10-25 20:00 Asia/Shanghai (12:00 UTC), confirmed by
the user. Mandatory track requirements remain unknown.

Hardware decision (2026-10-23): all five devices first implement BLE collection,
bounded durable buffering and direct HTTPS upload with one shared core and
board-specific adapters. AI Passport interaction and ePaper display follow that
baseline. This supersedes dedicated manual-only, beacon-only and display-only
assignments; the Passport local software chain now connects setup, policy,
collection and durable upload. Final local software verification passed on
2026-10-25; physical-device acceptance remains separate in [firmware chain](../notes/firmware-chain.md).

## P0 — Deliver the core MVP

- [ ] 2026-10-29: Materialize the v2 public backend cache incrementally from
      committed source inserts/changes, retaining server receipt time and full
      record identity. Handle delayed/tied-time uploads, manual cancellation,
      placement closure and retention without rewriting source history or
      changing collection. Compare against authoritative full queries, verify
      atomic retries/rollback and measure the added writes versus saved reads
      on real D1 before coordinated deployment and production acceptance.

- [ ] 2026-10-29 follow-up: reproduce the Chrome existing-device Wi-Fi
      reconfiguration `storage_unavailable` failure, repair its actual cause and
      verify the production flow without rotating credentials. Replace the
      retained16-address policy with a measured larger policy, reduce bounded
      summary-encoding/RPC overhead, and accept native MQTT memory, queue balance
      and recovery on the connected board. Measure address count × received
      report frequency × window interval; keep radio acceptance, modeled fleet
      capacity and current broker/free-quota limits distinct. Preserve old
      immutable policies, frozen batches and protected Flash throughout.

- [ ] Deploy domestic durable custody after the passing EMQX Hangzhou native
      MQTT/TLS connectivity trial archived below. Keep account/price
      authorization separate from research. Design domestic durable custody and
      asynchronous CF forwarding with distinct receipts, and fix onboard
      persistence/network coupling; do not release original data on broker ACK.
      Prepare offline per-device credential/ACL bundles for batch provisioning;
      keep generated secrets private, avoid rotating existing identities, and
      distinguish generated CSV/JSON from actual broker registration/API access.
      See the [provider shortlist](../notes/mqtt-wss-transition.md).

- [ ] Separate durable BLE-window persistence from long MQTT/TLS/RPC ownership.
      The optimized direct30s-cold trial receives3244 reports but a50.409s seal
      wait exhausts the finite handoff:2windows/32summaries are not persisted,
      despite zero callback drops or allocation failures. Preserve the raw
      evidence and old frozen batches; add interruption/timeout stress acceptance
      before claiming lossless operation on an unstable path. Do not conceal the
      issue by reducing scanning or treating broker ACKs as durable storage.

- [ ] Finish direct-route/reconnect and longer-run acceptance of the optional
      [Cloudflare MQTT/WSS transport](../notes/mqtt-wss-transition.md), after the
      proxy C3 acceptance archived below. Preserve the original16-address/30s/5s
      default and frozen batches; validate larger policies separately. Direct
      routing still fails complete acceptance. Cloudflare Queues is not part of
      the implemented device gateway.

- [ ] Expand the per-window address capacity beyond the current16-address
      policy without increasing TLS memory pressure. Allocate active/sealed
      address and actual-bin banks, retain native64-address/16-bin semantics,
      publish a new immutable policy only after the compatible image is ready,
      and preserve old policies/queued bodies. Measure actual address overflow,
      report rate, heap/stack, producer bytes/batches, durable ACK throughput and
      journal growth. Model address count × received-report refresh frequency
      and10/30/60-second windows; distinguish logical addresses from physical
      devices and modeled saturation from real radio acceptance.
      The [capacity and path evidence](../notes/address-capacity-and-public-path.md)
      separates controlled static64 acceptance from direct public-path tests.

- [ ] Complete sustained-load and public-path recovery acceptance after the
      [bounded performance evaluation](../notes/performance-evaluation.md):
      the profiling-disabled image, protected Flash, saved boot, peripheral
      initialization, BLE and fresh cloud persistence are observed; resolve
      timeouts and verify current-boot ACK/reclamation, then repeat recovery checks
      over longer runs and interruptions. Full-application and matched protocol
      latency/CPU evidence are archived below, not a zero-loss field guarantee.

- [ ] Extend the [collector decoupling acceptance](../notes/ble-ingress-decoupling.md)
      with long-run interruptions, power-loss recovery and larger-policy board
      acceptance. Current 16-address/raw-off C3 tests pass ten-minute controlled
      and five-minute direct active collection without callback/window/storage
      loss or failed allocation. Keep 16-address omissions, finite handoff
      capacity, remaining direct HTTPS timeouts and the frozen historical422
      separate from that bounded result; the completed implementation is archived.

- [ ] Finish long-run low-memory/journal recovery acceptance after the
      measured fixes. Preserve the original historical 422 slot and its exact
      bytes; its unique candidate reproduces the half-open boundary rejection
      locally, without an original online response trace. Bounded profiling
      shows actual HTTPS reuse and pending 195→171 while collecting; validate
      complete backlog drain, reset/exhaustion/reconnect and explicit losses.
      See [recovery provenance](../notes/memory-queue-recovery.md).

- [ ] Validate an isolated domestic managed MQTT/TLS -> serverless relay ->
      existing Cloudflare proof of concept. Inspect available cloud access and
      existing resources first, preserve exact request bytes/batch identities,
      distinguish broker delivery from verified cloud receipts, and keep
      synthetic acceptance separate from field data. Protect device Flash and
      restore temporary firmware after any authorized hardware test.

- [ ] Restore bounded trustworthy timestamps and sustained collection/upload
      across the four field sites. Preserve authenticated same-boot time anchors
      across SNTP updates, investigate radio/HTTP recovery starvation, correct
      explicit physical placement assignments and verify real config ACK plus
      repeated fresh windows. Retain original queued data and distinguish local
      firmware fixes from actual field rollout.
      Firmware work was deferred by the user; provisional local firmware edits
      are not part of the existing-data display release below.

- [ ] Validate the live/replay/simulation delivery on the deployed build and the
      actual afternoon field session. Confirm radio/upload, source timestamps,
      per-source expiry, retained-history availability and phone operation using
      the [delivery checklist](../notes/hackathon-delivery.md). Local frontend
      implementation is archived below. Add bounded historical interval queries,
      pagination or a validated recording archive before promising complete
      afternoon-to-evening or offline replay; the current API returns only the
      latest 200 records per stream within at most 24 hours.

- [ ] Diagnose the reported Passport connection failure without clearing saved
      state. Add observable Wi-Fi/IP/time/TLS/cloud/save stages and retained safe
      failure diagnostics; distinguish first registration from existing-device
      Wi-Fi reconfiguration, reuse saved credentials only on the same node, and
      support direct versioned placement/capture edits with explicit desired vs
      applied state. Support explicit open Wi-Fi and PEAP/MSCHAPv2 enterprise
      credentials without RADIUS server certificate checks, preserving strict
      upload HTTPS validation and legacy settings. Verify failure correction
      and the real-device network path for each available authentication mode.

- [ ] Verify administrator Passkey registration, login and reauthentication in
      the production Safari/Touch ID workflow after the optional-extension fix;
      controlled local browser acceptance is archived below.

- [ ] Physically validate the implemented Passport ownership and provisioning
      design: real-browser BLE, iPhone device-hosted SoftAP, wrong proof, interrupted
      candidate validation/save, and failed transport teardown. Verify the board
      profile and keep registration, network contact and applied config distinct.
      Native USB exchange is verified on one Passport; other-board drivers remain planned.

- [ ] Validate implemented factory identity and v2 policy/activation on hardware:
      same-boot leases, auth rejection, stale retries, reboot reapplication,
      assignment removal and placement/config window boundaries.
- [ ] Validate implemented canonical MAC/address-type summaries, overall
      windows/health, bounded sampled raw and frozen journals under actual radio
      loss, reset, storage exhaustion and uncertain/duplicate ACKs. Measure
      capacity/retention rather than infer them from compiled limits.

- [ ] Register individually verified physical nodes, capture policies and fixed
      placements in production, then validate firmware ACK/reclamation and actual
      retention timing. Cloud backend/demo acceptance is archived below.

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

- [ ] Diagnose real collection loss, post-reboot backlog handling and sustained
      upload capacity observed in the [device debug acceptance](../notes/device-debug-ui.md).
      Separate aggregation loss from bounded address-table omission; preserve the
      historical 422 candidate and finish startup/control recovery acceptance. The original
      debug UI's functional acceptance missed its rendering CPU regression;
      subsequent glyph clipping/dirty stripes/0.5 FPS and bounded reuse profiles
      are recorded in the [performance evaluation](../notes/performance-evaluation.md).
      Remaining collector admission waits and long-run recovery stay open.

- [ ] Investigate the C3 reset observed during the diagnostic's original
      NimBLE stop/deinitialization completion. Capture a reset reason/backtrace
      and reproduce with the actual production lifecycle before assigning a
      cause or claiming a production fix. Cancellation-only retained-runtime
      completion is verified separately in the [coexistence record](../notes/https-ble-coexistence.md).

- [ ] Evaluate a measured domestic TLS ingress/relay path independently of a
      possible MQTT/TLS or WebSocket transport change. Preserve batch identity,
      idempotency and separate local/cloud durable receipts before changing
      device reclamation; validate both network legs and provider requirements.
      See [coexistence and transport discussion](../notes/https-ble-coexistence.md).

- [ ] Extend the bounded full-application HTTPS-reuse result with sustained
      BLE/display/journal coexistence, HTTP idle survival, actual sampling
      cadence and recovery under loss. Keep strict certificate checks and
      inspect pinned SDK partial-write/retry behavior before changing timeouts.
      Use the [integrated profile](../notes/performance-evaluation.md),
      [controlled LAN baseline](../notes/https-lan-benchmark.md) and
      [public CF comparison](../notes/cf-longlink-benchmark.md) within their
      separate receipt, network-path and instrumentation boundaries.

- [ ] Freeze elevator experiment inputs with the versioned address-summary
      contract: retain within-slice timing/RSSI evidence, explicitly scoped
      cross-window association, scan-gap/loss quality and two-node time alignment.
      See [backend-first elevator design](elevator-wait-estimation.md); existing
      v1 `none`/`window_token` and sparse raw sampling do not satisfy this input gate.

- [ ] Define and validate an explicitly versioned partial/compact upload contract
      using the [field audit](../research/ingestion-field-audit-2026-10-24.md):
      preserve receipt/provenance invariants, distinguish unknown from empty/zero,
      retain raw evidence where needed and keep incomplete metrics unpublished.

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

- [ ] Further calibrate night materials and unmodeled facades toward the concept;
      the full-campus chart is an approximate fixed-view 2.5D illustration,
      without surveyed depth or physical photometric calibration.

- [ ] Field-record browser write regression is deferred at the user's request
      (2026-10-23); resume only when that verification is requested.
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
- [ ] Explore calibrated vehicle candidates and richer parking observations
      with separately acquired ground truth.
- [ ] Run the [elevator pilot](elevator-wait-estimation.md) at one floor/group:
      label pass-through, waiting, boarding, abandonment and full-car misses;
      compare known beacons and consenting phone cohorts separately.
- [ ] Implement backend replay and versioned short-track/state/event inference
      only after the input contract is verified. Preserve ambiguous/censored
      cases and provenance; do not equate disappearance with boarding.
- [ ] Compare a time/floor/direction historical-wait baseline with BLE-assisted
      quantile prediction on held-out sessions/days. Measure event precision/
      recall, wait error, interval coverage and prediction availability; freeze
      acceptance thresholds before evaluation and retain the baseline if BLE
      adds no measured value.
- [ ] Publish elevator estimates only after field acceptance and a versioned
      output contract with evidence/time/validity, uncertainty and unavailable
      states. Keep manual waits, inferred samples and predictions separate;
      consider edge preprocessing only after replay equivalence is verified.
- [ ] Evaluate address-window summaries and candidate evidence from raw reports;
      keep association hypotheses separate from physical device identities.
- [ ] Evaluate map registration and broader coverage; retain unsupported states.

## P4 — Longer-term work

- [ ] Review deployment operations, maintenance, accessibility, and contribution.
- [ ] Decide on licensing before adding third-party implementation code or models.
- [ ] Audit documentation against the actual submitted implementation.

## Completed archive

- [x] 2026-10-29: Fix administrator browser regressions after contextual help
      made partial form-label locators ambiguous. Exact labels, scoped status
      text and a WebKit combobox role preserve existing assertions. An isolated
      committed-source snapshot passes provisioning, MQTT, diagnostics, places,
      account/Passkey and full admin workflows. Dedicated Chromium/WebKit and
      fallback help checks are included in CI; rollout is verified separately.

- [x] 2026-10-29: Add detailed contextual administrator help for capture policy,
      device/receipt diagnostics, deployment, MQTT enrollment and site/account
      settings. Mouse/focus/click/touch explanations support scrollable content,
      Escape, native modal popovers and fallback positioning. Chromium/WebKit
      desktop/390px interactions, synthetic config-editing workflow, 33 targeted
      tests and production build pass locally. Preview PNG metadata stripped and
      checked. Production rollout is tracked separately; no backend/default
      changes or hardware use.

- [x] 2026-10-29: Deploy indexed v2 public reads, bounded server-side snapshot
      caching and visibility-aware, independent frontend polling. Production
      windows/fallback reads fall 54729→1241 and 49033→5310 rows; four public
      route types verify MISS→HIT→HIT and forced BYPASS. Index-only migrations
      preserve frozen v2 history and constraints; matched synthetic D1 writes
      fall 28.30%, while short production windows show item writes 8.876→6.254
      per INSERT and batch writes 10→8. See [D1 acceptance](../notes/d1-usage-optimization.md)
      for timestamps, test evidence, workload boundaries and retained TTLs.

- [x] 2026-10-29: Clarify the Passport heap display with `Heap free` and a
      labeled used-percentage bar. Preserve free/total, Blk and BootMin within
      the 240x320 layout. Host UI bounds/endpoint checks, actual-font preview,
      raster and incremental/full pixel-identity checks pass; not flashed.

- [x] 2026-10-29: Promote independent runtime MQTT/TLS enrollment and the
      dynamic Hangzhou EMQX→CF gateway to production. All16 device accounts plus
      the reply-only server pass real broker ACL checks; official API verifies
      the pool and assigns one existing C3, leaving15 ready. Main/frontend/D1,
      six-field timestamped rule and dynamic named service binding are deployed;
      remove the old fixed token map and enable the gated automatic deployment.
      Preserve public CA provenance in Git and all private material outside it.
      Protected app-only `mqtt-b5e5e4e0b02f` migration saves settings-v3 through
      physical USB; fix the real USB nested-MQTT boundary and test the actual
      controller→provision path. Physical acceptance:303.735s active collection
      plus a separate121.630s same-boot recovery observation,114 reused RPCs,
      112 successes, one preserved old-boot422 and one20.019s timeout recovering
      queue6→1. No new software window/storage/summary loss or failed allocation;
      final heap52748B/largest32768B. The16-address policy still overflows and
      long disconnections/other boards remain separate acceptance. See
      [production evidence](../notes/mqtt-production.md).

- [x] 2026-10-28: Replace the Mac verification bridge with native MQTT/TLS→
      Hangzhou EMQX→HTTPS rule→isolated CF Worker→existing ingestion Service
      Binding, returning original CF receipts by scoped native MQTT publication.
      Explicit credential-storage authorization,90 local tests, type/dry-run
      checks and real Serverless SQL byte-preservation checks pass. Mac bridge
      exits normally and its process absence is verified. C3 passes303.747s
      active collection/6310 boot reports, one session/72RPCs/71reused/0errors,
      50 CF batches/124679B (46current-boot), stable queue4–6, final heap54240B/
      largest34816B, zero new software-loss/allocation/pause counters. Exclude
      buffered preboot records after USB access triggers reason11 restart;
      no subsequent reset/crash. Longer unstable-path/custody work remains open.

- [x] 2026-10-28: Validate Hangzhou EMQX Serverless native MQTT/TLS with
      consumption limit CNY0, independent device/relay accounts and tested
      per-user ACLs. Protected app-only C3 transition passes Flash comparison.
      Physical run passes303.560s continuous active BLE collection,6080 reports,
      one session,55 CF durable batches/135007B (50 current-boot), queue6→1,
      zero transport/allocation/software-loss/pause counters. Final free heap
      55180B/largest34816B; warm RPC median1236ms/p95 2100ms includes CF.
      Implement offline private batch-provisioning bundles with48 host tests;
      cloud API account creation remains unverified. The verification bridge
      runs on the Mac with an explicit CF proxy, not domestic durable custody.

- [x] 2026-10-28: Implement/deploy the isolated authenticated MQTT/WSS gateway
      with Service Binding to the existing ingestion Worker, and add optional
      firmware transport with exact durable ACK and bounded outbox ownership.
      Proxy-path C3 profiling run passes300.730s continuous active collection:
      one MQTT session,216RPCs/215reused,193verified batches/608620B whole span,
      boot queue144→1 (preserved historical422),0actual allocation failures,
      memory deferrals, callback/window/storage losses or pause. Resolve fixed
      RX residency with IO/encoder mutual exclusion, gate ingress after BLE
      initialization, use measured MQTT task-stack budgets and move only SDK
      non-ISR task functions to Flash. Earlier failed-trial losses and direct
      route limitations remain explicit in the linked record. The installed
      profiling-off proxy image also passes121.285s active collection and20
      fresh batches with zero software loss/allocation failure, and remains
      running with the original16-address policy. No Queues or paid MQ instance.

- [x] Decouple BLE ingress from HTTP memory admission, JSON and Flash work;
      persist bounded policy-sized handoffs with the existing uploader. Preserve
      stop/final/old-policy ownership, raw failure accounting, immutable retries
      and ACKs. Replace the failed full-snapshot design with a compact view:
      actual16-address net reservation is318B below the old synchronous baseline
      before allocator metadata, preserving native64-address support. Verify
      ASan/OOM/lifecycle tests,69 byte-identical server fixtures and C3 builds.
      Actual repeated sampling: controlled603.752s and direct304.137s active,
      callback/window/storage/seal loss0 and failed allocation0; final normal
      image installed, latest queue retained, temporary forwarding stopped.
      Preserve the failed first trial and its corrected full-journal short-start
      boundary in [workload and acceptance](../notes/ble-ingress-decoupling.md).

- [x] Install normal optimized image `fix-ccdcdd467c0b` with profiling disabled,
      verify the complete expected Flash image after app-only write, and retain
      saved settings, cardid and journal. Observe display/input/battery startup,
      real BLE, four verified older-boot upload ACKs and current-boot D1 storage
      for two windows/one status. Preserve the later public-path timeouts,
      uncertain current-boot ACKs and 615 callback drops as unresolved evidence;
      this is a bounded startup/recovery check, not stable field acceptance.

- [x] Evaluate one Passport's full application in two 606 s profiles with
      weighted task CPU, stack margins, failed-allocation callbacks, overlapping
      operation wall timers, real BLE/Flash/public HTTPS and verified ACKs.
      Observe bounded pending 195→171 and actual 73 socket reuses; retain 150 BLE
      callback losses and the historical 422 slot as unresolved limitations.
      Separate later normal-image checks and long-run acceptance above.

- [x] Isolate the original ten-second regression with UI A/B/A, then clip
      glyph work, reduce normal display to0.5 FPS and send only dirty four-row
      stripes. Preserve native pixels/buffers; real supervisor/UI CPU is about
      1.5% in subsequent profiles. [Evidence](../notes/performance-evaluation.md).

- [x] Compare same-host HTTPS and native MQTT/TLS with matched trust, TLS,
      payloads, power, BLE and verified RAM application receipts: 30/30 without
      CPU instrumentation and 46/46 in a separate paired task-CPU profile.
      Warm latency is comparable; this MQTT implementation uses more measured
      task CPU/heap. Preserve SDK enqueue/Nagle confounders, small sample and
      non-durable receipt boundaries; no production transport migration.

- [x] Add and flash the Passport debug dashboard with associated SSID/RSSI/PHY,
      internal heap/current largest/boot minimum, shared journal bars, verified
      upload goodput/result/age, HTTP/errors and separate BLE loss counters.
      Preserve setup screens and unknown Mbps. Actual-font native/sanitizer
      rendering and selected IDF5.5.3 build pass; protect current Flash data and
      retain the UI after246s physical boot/stack/new BLE/cloud receipt checks.
      The frozen build excludes earlier clock/yield WIP without resetting it.
      See [units, source and physical boundaries](../notes/device-debug-ui.md).

- [x] Observe the original full BLE/journal/HTTPS path for180s before the UI
      update: six adjacent fresh windows/3473reports and30verified upload
      completions, with narrow RAM margin,12aggregation drops and address-table
      omissions. Distinguish historical heap lows from request-local minima;
      do not infer all allocation success or RF completeness. New UI acceptance
      separately observed real current-boot receipts and16.5KiB historical heap
      minimum; rejection/backlog/long-run recovery remain open above.

- [x] Compare public Cloudflare HTTPS fresh/reused sockets and WSS on one
      isolated authenticated hostname (2026-10-28). C3 verified65/65 synthetic
      receipts, zero reconnects on22 already-connected HTTP requests,45second
      WSS heartbeat idle and controlled reconnect. HTTPS reuse reduced median
      1/8KiB latency84%/79%; WSS had no additional measured advantage. Restore
      full Flash equality and original boot/USB/credentials, remove temporary
      Worker/domain and verify production unchanged. Document Workers/DO/Queues
      roles and transport-vs-durable ACK boundaries in the
      [measurement record](../notes/cf-longlink-benchmark.md). Production/BLE,
      HTTP idle/cadence and prolonged network-loss acceptance remain separate.

- [x] Test real passive BLE scanning plus shared RAM aggregation during paced
      synthetic HTTPS uploads (2026-10-26). Main summaries and server receipts
      verified 80/80 POSTs; all 40 reuse POSTs retained their connections and
      four measured phases processed 4,451 reports without application drops.
      Preserve one missing individual UART metric and the original cleanup
      reset as limitations. Narrowed scanner/worker completion passed a separate
      8/8 regression with 499 reports; full SDK deinit is not validated. Fresh
      complete backup, app-only writes and original full-Flash restoration passed.
      Production UI/journal/field acceptance remains separate.

- [x] Isolate HTTPS on one connected Passport with a local TLS 1.2 server and
      embedded public test CA (2026-10-26). The matched-I/O baseline verified
      all 40 synthetic 1/8 KiB uploads, actual reuse and wrong-CA rejection;
      preserve earlier short-timeout failures separately. Complete verified
      8 MiB backup, application-only writes, non-application equality after the
      experiment, original-application restoration and full-Flash equality
      passed. Original `cp-aa1b3ec36d40` boot and USB status were confirmed;
      production concurrency and public-network performance remain separate.

- [x] Show retained field aggregates with unknown/unreliable timestamps as a
      separate receipt-labelled last-report display, without promoting receipt
      time to observation time, freshness, inference or replay. Retain original
      placement scope and privacy. Show quantity-driven people glyphs and the
      user-authorized, explicitly labelled illustrative vehicle fallback when
      actual vehicle evidence is unavailable; honor real zero values. Verify
      focused backend/frontend suites and desktop/390px browser behavior.

- [x] Retain the last observed live map/card values when updates stop, with
      concise measured quantity/unit badges, original timestamps, dimmed expiry
      and visible read failures. Preserve failures through pending retries,
      replace real zero values, honor source retractions/purpose removal and
      authoritative corrected elevator baselines, isolate place/replay state,
      and avoid interpreting capped BLE identifiers as physical headcounts.
      Verify unit regressions, production build and isolated desktop/390px
      browser controls, source/expiry/error retention and replay isolation.
      See [automatic observation references](../specs/automatic-observations.md).

- [x] Add observation-driven person/e-bike/car diagrams and elevator badges at
      the selected place in overview and local maps. Keep fixed drawing budgets,
      source labels, independent expiry/layers and historical time distinct from
      physical counts/positions; prefer completed manual waits over historical
      references and show waiting text for insufficient evidence. Verify focused
      unit tests, full local suite, production build and isolated desktop/390px
      browser controls, replay/gaps, stale/error handling and demo isolation.
      Include the browser acceptance in hosted CI. See
      [automatic observation references](../specs/automatic-observations.md).

- [x] Connect experimental versioned vehicle candidates and elevator historical
      references to compact raw-off firmware evidence, bounded private backend
      analysis and independent public cards. Keep car/ecosystem categories,
      confidence, source validity, missing/conflicting inputs and replay apart.
      Correct short-window server validation and collector stop/drain boundaries;
      verify original-boot queued receipts after normal device recovery. Local
      acceptance: 832 tests / 65 files, production build, normal/headless C3
      builds, sanitizer/OOM/C-to-server checks and real ephemeral D1 desktop/
      390px browser workflows. Field-calibrated vehicle totals and BLE-assisted
      waiting predictions remain pending. See
      [automatic observation references](../specs/automatic-observations.md).

- [x] Support concurrent activity, parking and elevator observations at one
      physical place, with independent result validity and backward-compatible
      migration. Existing devices directly change their place and selected work
      purposes through immutable deployment/configuration versions, retaining
      old attribution and explicit device ACK. Verify 669 tests / 60 files,
      build, real ephemeral D1 desktop/390px browser flows, correction/retry
      regression and v1/v2 D1/R2 ingestion. Automatic vehicle/elevator inference,
      hosted release and physical activation remain separate; see
      [place and device purposes](../specs/place-observation-purposes.md).

- [x] Clarify administrator device diagnostics and uploaded evidence: separate
      contact/capture/config/upload states, show age and boot context, explain
      losses and RAM pauses, and inspect bounded authenticated batch/payload
      records with exact-byte versus normalized-projection provenance.
      Verify 33 targeted tests, 629 tracked tests, build, isolated real D1/R2
      browser flows, hosted deployment and live device-panel/batch metadata;
      selected payload rendering is isolated-test evidence, not a production
      archive-content inspection. Add this browser workflow to CI.

- [x] Add automatic RAM-pressure collection protection: suspend optional raw
      work, pause/release BLE when idle free or contiguous heap is inadequate,
      resume with hysteresis and cooldown, and report actual pauses without
      rewriting the desired sampling policy or inventing missing observations.

- [x] Resolve the physical Passport TLS validation timeout: distinguish TCP/TLS,
      response parsing and memory pressure using bounded diagnostics, preserve
      strict HTTPS checks and all stored data, then verify on the user's newly
      selected Wi-Fi through USB and confirm saved settings and cloud contact.
      Physical check: `cp-0b77ccc58257` on one Passport/current PEAP network,
      300 seconds in one boot with saved settings, 49 successful HTTP requests,
      current-boot receipts for 2 windows / 128 address-summary items / 8 status
      items, two pressure pauses and recovery, 13,856-byte minimum heap. Six
      local RAM-admission deferrals retained their frozen batches. This is
      bounded sampling with gaps, not continuous radio-coverage acceptance;
      physical BLE setup, other boards and long-duration operation remain separate.

- [x] Rewrite both READMEs for hackathon visitors with product explanation,
      the unified live/history axis, demo links, local setup and focused docs.
      Add three actual-browser desktop/mobile screenshots with official GIS
      attribution and explicit synthetic-fixture captions, plus a reproducible
      capture script. Final PNG metadata, image readability, read-only capture
      behavior, Markdown links and whitespace checks pass. These screenshots
      establish no physical recording or deployment acceptance. See the
      [screenshot recipe](../notes/readme-screenshots.md).

- [x] Unify live observations and retained replay on one HomeKit-camera-like
      axis (user direction recorded before implementation, 2026-10-25). Follow
      the live edge; drag or choose a marker to pin historical time; show actual
      source intervals, independent manual validity, gaps and truncation; return
      live in one action. Share reads/cursor between map details and the axis,
      keep simulation separate and preserve legacy mode links. All 616 tests /
      54 files, production build and fixture-based desktop/390px Chromium checks
      pass, including pinned refresh, gaps, range changes, source isolation and
      mobile warning layout. Existing simulation browser regression also passes.
      No production or physical recording acceptance is implied; see the
      [delivery checklist](../notes/hackathon-delivery.md).

- [x] Implement the 2026-10-25 live-data delivery direction recorded in P0
      before code: public sensor/manual cards with independent expiry and quality,
      30-second/focus refresh, explicit field/replay/demo links, unlocated-place
      reads and retained real-record selection isolated from synthetic animation.
      Update bilingual entry docs, API/architecture notes and afternoon acquisition
      checklist. All 601 tests / 53 files, production build, fixture-based desktop
      and 390px Chromium source/error/history checks and the existing simulation
      browser regression pass. Browser acceptance performs zero API writes and
      establishes no hardware, afternoon recording or production deployment.
      See [delivery evidence](../notes/hackathon-delivery.md).

- [x] Replace the manual-key roadblock for verified, registered USB/BLE nodes
      with no saved credential: offer one explicit reauthorize-and-connect
      action, retain a returned replacement across local/network retry, recheck
      device/cloud readiness after reauthentication, preflight escaped transport
      size, and block uncertain issuance replay. Existing saved credentials
      continue to reuse without rotation. Verify 569 tests, build and synthetic
      Chromium/WebKit recovery flows; actual network authorization is user-owned.
      See [onboarding diagnostics](../notes/device-onboarding-diagnostics.md).

- [x] Keep prepared device settings editable after Save. Load current values,
      save edits as the current desired settings, preserve capture/retention
      choices, and allow configuration/Wi-Fi entry before device credentials.
      Explain send prerequisites and bound in-flight/uncertain writes to their
      attempt. Verify repeated saves, expiry, stale responses and post-success
      edits with 515 unit tests, production build and Chromium/WebKit synthetic
      peers. Physical-network acceptance remains separate. See
      [onboarding diagnostics](../notes/device-onboarding-diagnostics.md).

- [x] Publish the selected firmware integration with redistributable OFL fonts,
      inspect/back up the original 8 MiB Passport and preserve its protected
      layout while updating only the app. The original legacy queue reset was
      separately authorized; the short-PIN update erased no queue/settings data.
      Record the real supervisor fix, startup and private backup boundaries in
      [firmware acceptance](../notes/firmware-chain.md).

- [x] Implement expiring eight-digit PIN / Security 2 and physical USB setup for
      headless profiles. Verify native/SDK/browser software, four C3 builds and
      one Passport's actual USB begin/identity/status/framing recovery plus
      60-second startup. Publish code `3fc2ec9`; real BLE/phone/Wi-Fi/cloud
      enrollment and sustained collection remain the separate gates above.

- [x] Apply the selected app icon to the administrator login, initialization
      and workspace sidebar. Local mocked-session browser checks passed at
      desktop/mobile sizes for all three screens, along with the production build.

- [x] Correct GIS navigation to load actual official tiles across the complete
      image grid with all four levels, preserving authored overlays and accepting
      place coordinates beyond the old crop. Permit only the official image
      origin in admin CSP. Build, 476 local tests, actual-HTTP-CSP browser checks,
      desktop/390px flow and native Safari real-tile Nanhu editor/link checks
      passed. The October 24 crop-only boundary/dev-server acceptance was
      insufficient and is superseded by [this correction](../notes/gis-location-settings.md).
      Production records and physical placement verification remain separate.

- [x] Generate an original abstract campus-route C app icon and integrate the
      homepage brand, browser favicon, Apple touch icon and manifest variants.
      Final assets were metadata-stripped/rechecked; local build and desktop/
      mobile browser icon loading passed (2026-10-25). Deployment remains separate.
      Prompt and provenance are recorded in [reuse notes](../notes/reuse.md).

- [x] Default to lower-resolution lighting with a shared, locally remembered
      轻量/精细 control. Preserve official source sampling, text/actor DPR and
      full-resolution native canopy occlusion; lower only material/light color
      resolution. Matched visible Chromium improved full/efficient readiness
      6.9→4.1s and DOM canvas capacity157.2→86.1MiB, with265 frontend tests and
      production build passing. See [measurements and tradeoffs](../notes/lighting-performance.md).
      Local implementation; production deployment/Safari acceptance separate.

- [x] Complete the Passport local software chain and frozen-source acceptance
      (2026-10-24–25): protected browser BLE / device-hosted SoftAP provisioning,
      durable validated enrollment, strict TLS, boot-bound v2 control/leases,
      canonical MAC/type summaries, bounded raw evidence, frozen Flash batches
      and exact ACK reclamation. Native/sanitizer/fault tests, literal C-codec
      bytes against real isolated workerd/D1/R2, Chromium/WebKit fixture flows,
      444 repository tests / 43 files, Vite and four fresh ESP-IDF 5.5.3 C3 builds
      with protected separate-image checks pass. All 158 non-Markdown firmware
      source hashes remained unchanged across final builds. Local ignored image
      artifacts and full boundaries are in [chain evidence](../notes/firmware-chain.md).
      No flash, physical radio/phone/Flash acceptance, v2 deployment or private-source
      publication is included; hardware, S3 and manual/USB work remains open above.

- [x] Reduce lighting startup work with a bounded two-Worker compiler, scoped
      lamp/actor caches and cropped high-DPI library canvases. Matched warmed-tile
      visible Chromium at1920×1080/DPR2 improved readiness19.9→6.7s, longest
      main-thread task2126→139ms and DOM canvas capacity374.8→157.2MiB. Build,
      256 frontend tests and mobile/day/night/xray/field/no-Worker regression pass.
      Preserve lighting equations, source assets and frame-rate target. See
      [performance notes](../notes/lighting-performance.md); deployment and live
      Safari acceptance remain separate.

- [x] Connect administrator location editing to the shared official GIS picker,
      public field maps/search/details and record place IDs. Preserve full-image
      coordinate registration and separate demo places; allow all map corners
      to reach the viewport center. Build, 226 frontend tests and fixture-based
      desktop/390px browser regression passed, including refresh, service failure
      and phone edits/removal. See [scope and limits](../notes/gis-location-settings.md).
      No production registry writes, deployment or physical-location acceptance.

- [x] Accept omitted optional Passkey credential-property reports while rejecting
      negative/malformed reports and retaining all core WebAuthn/session guards.
      The exact release snapshot passes350 tests/34 suites (61 real-crypto
      Passkey cases), build, fresh local migrations and real Worker/browser
      registration with omitted extensions, signed login/reauth and management
      regressions. Physical Safari acceptance remains a separate step. See
      [browser compatibility](../notes/admin-browser-compatibility.md).

- [x] Implement firmware runtime stage A after baseline commit `82549b0`:
      factory-MAC node identity, portable lifecycle/policy decisions, Passport
      board boundary, optional peripherals, single-owner UI/input timestamps,
      and independent diagnostic maintenance/read-only snapshots. Default boot
      waits for setup/config rather than starting field scanning. C3 normal,
      diagnostic and headless builds, sanitizer suites and image guards pass;
      no hardware test, push or cloud integration. See
      [historical runtime notes](../notes/firmware-runtime.md). Provisioning,
      transport and durable collection were pending at that snapshot and now
      have local software implementations; S3/manual/hardware acceptance remains open.

- [x] Fix Safari administrator-page cosmetic-filter collisions by replacing
      generic `ad-` classes, custom properties and animations with `cp-admin-`.
      Preserve account/API behavior and browser protections. The release snapshot
      passes 324 tests across 34 suites, build, and real local Worker authentication/CTAP2
      and management browser regressions under controlled cosmetic filters,
      including desktop and 390px overview/account geometry. See
      [browser compatibility](../notes/admin-browser-compatibility.md).
      Controlled Chromium acceptance is separate from live Safari verification.

- [x] Review the imported firmware and record the shared-core/ESP/board/UI
      boundaries, administrator Web Bluetooth onboarding, policy application
      recovery and durable local-marker semantics in
      [firmware platform](firmware-platform.md). Browser/pinned IDF support and
      source behavior checked; independent read-only reviews and document-link
      checks passed. Runtime, API and hardware changes remain the P0/P1 work above.

- [x] Record the user-selected backend-first elevator-wait design and device
      input matrix, including current v1 limits, proposed address summaries,
      scoped association, manual labels, replay and field/prediction gates.
      Documentation only; no algorithm, wire change, deployment or device
      validation. See [elevator design](elevator-wait-estimation.md).

- [x] Import the user-selected AI Passport Radar runtime/BSP from verified
      upstream `5fb8ab5` on `codex/passport-firmware`. Preserve 3 MiB app/cardid
      layout, omit credentials/observations, gate calibration exports, correct
      Appearance endianness and record file fingerprints. C sanitizer checks,
      nine image guard tests and ESP-IDF 5.5.3/C3 build pass (583,680-byte app).
      No hardware test or push; local baseline commit authorized before refactoring.
      Resolve inherited raster-font rights
      before publication. See [firmware baseline](../notes/firmware-baseline.md).

- [x] Enrich frontend-only simulation with teaching-day, weekend and rainy-day
      profiles for all eight places, independent parking intensity and full-day
      variation. Share scene/time selection across maps, details and nine history
      rows. Build, 198 frontend tests and real Chromium desktop/390px checks
      passed with zero API writes/page errors; field mode clears synthetic
      indicators and pauses replay. See [simulation notes](../notes/simulation.md).
      Local implementation only; no deployment or device validation.

- [x] Upgrade `/admin` authentication to restricted first-use bootstrap, a managed
      account/password and up to20 WebAuthn Passkeys. Add native salted scrypt,
      fresh password/Passkey reauthentication, profile/key management, password
      change session/challenge revocation, explicit production RP trust, browser-
      bound one-use challenges, bounded rate admission and transactional guards.
      Local acceptance:326 tests/34 files (60 account/Passkey/management cases
      plus9 deploy-origin checks), build, four-migration local workerd ingestion,
      real Chromium CTAP2 registration/login/reauth/key/account changes and the
      original management browser regression passed;45-operation Swagger and
      desktop/390px security-page checks passed. No authentication commit/deploy,
      physical biometric/key/sync or production CPU/domain acceptance is implied.

- [x] Implement `/admin` with independent revocable administrator sessions,
      device registration/metadata/rotation/enable state and health, places and
      deployment history, editable capture drafts, validated version publication,
      desired/reported/applied state, runtime settings and atomic redacted audit.
      Preserve historical upload/configuration identity and reject inactive or
      concurrently closed placements at publication. Local additive migrations,
      261 tests/29 suites (including 14 admin integration/security tests), build,
      real workerd ingestion regression and real Chromium management workflows
      passed. Browser checks cover rejected/corrected login, rotation, disable/
      enable, draft edit/clone/publish with original-policy preservation, synthetic
      ACK UI, persistence, logout, readable phone tables and bounded scrolling.
      No production deploy or firmware/physical activation acceptance is implied.

- [x] Generalize the accepted library lighting to the full visible campus and
      all eight places:103 roofs/29 walls/44 grounds,309 foliage proxies,94
      point sources and77 pane-derived area emitters; share indexed light,
      visibility, bounded ground/window bounce and actor reception. Add shared
      viewport chunks with bounded64-entry caches and cooperative compilation,
      runtime-only official CORS source material, all-place frames and ten
      synthetic routes. Correct native GIS crown occlusion, remove duplicate broad
      warm glow, and keep crown tops above path lights with strict incidence.
      Preserve library calibration, fixed parking, comparison
      modes and zero synthetic actors in field mode. Build and190 frontend
      tests passed; desktop/390px and all-place runtime checks recorded in
      [campus lighting](campus-lighting.md) and root visual QA. No deployment,
      commit or database writes performed by this lighting task.

- [x] Dump and inspect 149 retained raw batches / 3,566 reports at the
      2026-10-24 16:57 CST cutoff; separate firmware-declared and fixture cohorts,
      verify research-response checksums/receipt identity and report one expired
      raw receipt outside the backup. Add read-only dump/analysis tools and 10
      passing synthetic analysis/integrity tests. Original frozen upload bytes
      were not backed up; wire/firmware/API changes remain proposed above.

- [x] Bring the bounded library-entry trial closer to the selected night concept:
      unified building/ground/tree/actor lighting, textured foliage, crisp tiles,
      source-preserving surfaces, focused warm entry and readable16/13px detail
      figures. Retain actual GIS geometry, routes/counts/anchors, fixed parking,
      independent layers and field isolation. Paired pass16 and representative
      motion/phone/xray views independently accepted;86.328s/2084 advancing
      frames preserve56 actors and four parking anchors. Final post-guard build
      and148 frontend tests passed; current in-app mode/search/zoom checks passed.
      This completes the requested local trial; full-campus extension remains
      separate above. No deployment or DB/hardware acceptance is implied.

- [x] Replace remaining library roof/canopy/door washes with runtime-only
      CORS-permitted official source textures, bounded approximate linear
      reflectance and shared normals/light/tone mapping. Preserve source seams,
      ordinary map loading and tested network/CORS fallback; bundle no raster.
      Add three discrete canopy downlights with shared downward cones and
      select common sky strength.65 via matched A/B without changing lamp/room
      power. Pass15 build and139 frontend tests passed; desktop/390x844 and source
      failure/recovery checked. Night cohesion improved; actor readability keeps
      the concept-fidelity goal open.

- [x] Fit the library roof/facade/entry responsively, recover campus background
      detail and declutter local labels; add bounded common dielectric reflection
      and ground-only contact AO. Refine base contrast and existing canopy lamp;
      denser synthetic pedestrians retain all existing paths/poses/parking.
      Build and123 frontend tests passed; pass11 desktop/phone reviewed without
      new static-frame regression. The broader night-fidelity goal remains open.

- [x] Share linear wall/paving/foliage/actor shading, normalized additive room
      emission and19 facade-area patches; add authored paving with planting-bed
      exclusions and preserve actual door details under shared-energy reflection.
      Build and107 frontend tests passed; pass7 desktop/390x844 inspected.
      This completes the material foundation, not the open concept-fidelity goal.

- [x] Add textured foliage/fixture assets with metadata/provenance records,
      shared single-bounce/leaf reception, clustered room exposure,13 wider
      campus paving masks/57 lights,32 facade planes/14 groups and adaptive
      official tile LOD. Build and75 frontend tests passed; current desktop and
      390x844 captures inspected. Concept-fidelity acceptance remains open.

- [x] Prototype unified library-entry lighting with 8 surface receivers,
      8 tree volumes and 8 shared illustrative fixtures; add normal/height/ray
      response, actor capsule shading, tree clipping and ground shadows. Keep
      entrance/enhanced/original comparison. Build, 48 frontend tests and
      desktop/390x844 browser checks passed; no database tests or writes.
      See [experiment and limits](library-entry-lighting.md). This is partial
      fixed-view relighting, not full-campus 3D or concept-image parity.

- [x] Deploy the ingestion server on Cloudflare from backend-only commit
      `6f7775a`; apply additive D1 migration, bind private APAC-hint R2, set an
      independent research secret and verify three real cloud demo streams, exact
      retry ACKs, conflicts, private parsing and public isolation. CI run
      `39921619389` passed; 9 extra permission-boundary checks passed. Disable the
      synthetic upload node after acceptance. This does not validate firmware,
      field coverage, long-run retention execution or mainland availability.

- [x] Replace detached facade dots with14 reviewed wall planes and polygonal
      panes, stable room variation, continuous reception and selective night
      grading. Fix asynchronous camera invalidation ownership and raster-only
      transform interpolation. Build,28 frontend tests and current desktop/phone
      browser checks passed; GIS/actors/interactions retained, no DB writes.

- [x] Share registered local illumination between ground and people/vehicle
      materials; add reviewed forecourt/entry spill and soft facade response.
      Preserve geometry, actor scale, paths and controls. Build,23 frontend tests
      and desktop/phone checks passed; fidelity remains partial, no DB writes.

- [x] Correct oversized/stretched actor sprites using per-direction alpha bounds,
      preserved aspect ratio, registered world sizes and foot/tyre anchoring.
      Overview/local zoom and phone checks passed; routes/counts stayed intact.
      Build and 17 frontend-only tests passed, without database tests or writes.


- [x] Implement ingestion v1 server: scoped per-node credentials, immutable
      placement/config with append-only closures, strict three-stream validation,
      atomic D1 receipts and range exclusion, conditional private R2 archival,
      research-only AD parsing, field-only sensor projection, retention and secure
      provisioning helper. Local SQLite/workerd D1/R2 concurrency/failure tests,
      32-window transaction, build and nine-operation Swagger browser regression
      passed. See [acceptance and limits](../notes/backend-ingestion.md).
      Cloud deployment/demo acceptance is recorded separately below; firmware
      and physical-device validation remain pending.

- [x] Bind unused `pulse.anend.net` to the existing Worker without deploying
      local parallel work; independently probe mainland DNS, frontend, JS and
      read-only API. Reachability improved substantially, but download anomalies
      and actual demo-network/device acceptance remain open. See
      [connectivity evidence](../notes/mainland-connectivity-2026-10-23.md).

- [x] Add PixiJS 8.22 / pixi-filters 6.1 lighting-only overlay, real bloom/blur,
      original/Canvas fallback, registered paving/facade masks and on-demand
      rendering. Build, 13 frontend tests and desktop/phone light-layer checks
      passed locally; no database tests or writes were performed for this pass.


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

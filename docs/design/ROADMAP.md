# CampusPulse roadmap

Current planning baseline: [Hackathon plan](hackathon-plan.md), 2026-10-23.
The user selected all-Cloudflare hosting. Unchecked items mark remaining work
or acceptance; any partial local implementation is identified explicitly below.
The competition deadline and mandatory track requirements remain unknown.

Hardware decision (2026-10-23): all five devices first implement BLE collection,
bounded durable buffering and direct HTTPS upload with one shared core and
board-specific adapters. AI Passport interaction and ePaper display follow that
baseline. This supersedes dedicated manual-only, beacon-only and display-only
assignments; the Passport local software chain now connects setup, policy,
collection and durable upload. Final local software verification passed on
2026-10-25; physical-device acceptance remains separate in [firmware chain](../notes/firmware-chain.md).

## P0 — Deliver the core MVP

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

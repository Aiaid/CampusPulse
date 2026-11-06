# Complete CPRAW replay on the production main frontend

Status: **published and imported; HTTP/data, React static rendering and actual
in-app-browser visual/interaction acceptance passed on 2026-11-06.**
This extends the earlier [local bounded replay](v3-data-replay-acceptance-2026-11-06.md)
to a separately authenticated source in the existing deployed main map.

Entry: <https://pulse.anend.net/?capture_replay=tf-cpraw-20261029-full>.
Log in at the same site's `/admin` first, then return to this link. Passwords and
session tokens are not embedded in links or browser storage. Anonymous reads of
the replay API return 401. Default public field and synthetic demo views keep
their own data sources.

## Complete source accounting

The three existing CPRAW segments were revalidated twice without modification.
`prepare-v3-cpraw-replay.py --window-ms 60000 --all` calls the unchanged firmware
`cp_v3_stats/stats.c` and retains **all 602,315 source reports**, rather than only
the previous selected windows. First report time is rounded down to a millisecond
and final recorded source extent up to a millisecond so neither edge is omitted.

- Source extent: 218,000–6,762,557,000 monotonic microseconds.
- Total duration: 6,762,339 ms, approximately 112.71 minutes.
- Windows: 112 complete 60-second windows plus one 42.339-second partial tail.
- Bins: 5 seconds; the tail retains its actual final-bin duration and partial flag.
- Sum of replayed worker reports: exactly 602,315, equal to the validated source count.

Original RTC anchors provide the historical time mapping and stated uncertainty;
they are not independently verified clocks. The replay does not receive a new
device identity, firmware producer claim, ACK, lease or current field authority.
Raw addresses, advertisement bytes, session identifiers, local paths and previous
classifier outputs are not uploaded. The imported body is 54,690 bytes of bounded
aggregates and whitelisted time/hash/count provenance. The source trip has no
verified per-window location, so `place_id` is null; the campus basemap is display
context, with no capture-location marker or synthetic actors.

## Online API and main frontend

Migration [`0020_controlled_replays.sql`](../../migrations/0020_controlled_replays.sql)
adds only the private `controlled_replays` table and immutable/capacity triggers.
Existing device, policy, receipt, credential, collection and field tables are
unchanged. Historical snapshots are bounded to 120 windows and 256 KiB per
request/normalized snapshot, with at most 128 immutable replay IDs.

- `POST /api/v1/admin/replays`: existing full administrator session, same-origin
  JSON mutation, schema `campuspulse-replay-import/1`; strict nested field
  whitelists, actual V3 window validation and complete-source conservation.
- `GET /api/v1/admin/replays/:id`: same administrator session; returns normalized
  `campuspulse-replay-view/1`, `dataset:controlled_test`, `source:historical_cpraw`.
- Responses are `private, no-store`. Session/account revocation and expiry are
  rechecked at reads and transaction commit. Exact-body ID retries return the
  existing immutable snapshot; different content under the same ID conflicts.

The existing main App selects this source only with `capture_replay=<id>`.
It fetches through the existing administrator Cookie path and displays a
persistent “历史采集回放 · 管理员受控测试 · 非当前现场” label. The source-specific card
shows report counts, BLE-visible keys, RSSI, coverage, losses and partial/clock
quality. Its fixed source timeline contains all 113 windows and supports
scrubbing or one-window-per-second playback without changing recorded duration.
Unknown UTC falls back to relative source time. There are no calibrated people,
vehicle or waiting-time estimates.

The production device producer allowlist remains `["cp-v3-small/1"]`.
Cloud raw/feature ingestion remains disabled. This is an administrator historical
aggregate import, not a synthetic device admitted to the production MQTT path.

## Release and evidence

- Additive migration 0020 applied to the existing production database.
- Worker/static-assets version: `5c180e39-c530-41dd-9ae9-127914ee3439`.
- Replay ID: `tf-cpraw-20261029-full`; import returned HTTP 201.
- Import body SHA-256: `164dfd68067c72fc2097cc4d22ad3752ebb7bad42dba99f27a18d7393260ca06`.
- Authenticated online reads matched every normalized window and source metadata
  against local validation, including all 602,315 reports and the partial tail.
- Online main HTML and the main App JavaScript matched the exact local build
  hashes. The actual frontend normalizer accepted the online response.
- Actual card/timeline components statically rendered the first and last windows,
  the complete count and slider maximum 112; the tail displayed 42.339 seconds
  and its partial-window quality. This is **React static rendering, not browser
  DOM/CSS/layout/interaction validation**.
- Anonymous replay reads return 401; the public field route remains independent.
- Backend replay tests: 23 passed, including real workerd/D1 concurrency and
  session races. Existing admin tests: 17 passed. Frontend controlled-source
  tests: 23 passed; the agent's combined existing field/card/illustration scope
  passed 116 tests. Importer/C-core tests: 9 passed. TypeScript/build and scoped
  existing public-field reader/timeline regressions passed.
- The 14 final image assets were rechecked with ExifTool; no privacy metadata
  fields were found. No new images or historical captures were published.

Private `captures/v3-online-replay-20261106/` holds the complete aggregate,
`published-main-check.json` and exact source-hash release manifest. The initial
manual deployment used reviewed working-copy changes based on `28bae8b`; its
source implementation is now recorded in commit `c125a4d`. That initial deployment
preceded Git publication; subsequent push, hosted CI and deployment outcomes are
separate evidence. Before committing, the full JavaScript suite passed 1,307 tests
across 98 files, the importer/C-core suite passed 9 tests, and the TypeScript/Vite
build passed.

The first built-in-browser attempts returned `Local browser use is disabled in
Work settings`. That was the actual release-time blocker; it was resolved before
the following separate browser acceptance, rather than inferred from static tests.

## Actual in-app-browser acceptance

On 2026-11-06 the requested in-app browser opened the published URL. The initial
unauthenticated page showed the administrator login requirement. After the
already authorized same-origin login, the main map displayed the complete
602,315-report / 113-window source, its fixed 112.71-minute historical extent,
the persistent controlled-test label and the actual statistics cards.

- First window: 60 seconds, 86 visible identifier keys and 5,089 worker reports.
- Slider End: window 113, 42.339 seconds, 45 keys, 3,093 worker reports and
  partial/uncertain-clock/coverage quality warnings (mask 7).
- Playing from the last window restarted at window 1. Playback advanced through
  sampled windows, and pause stopped at window 18 with matching card values.
- Starting at window 112 advanced to window 113 and stopped automatically.
- The default 803×984 viewport showed the map, card, source label and full axis.
  At 390×844 the document width was 390 pixels: no horizontal overflow. The
  default viewport was restored, playback paused and the first window selected.
- The authenticated replay tab was retained as the user-facing deliverable.

Private `browser-qa/browser-acceptance.json` and desktop/mobile originals under
the existing ignored evidence directory record this result. Screenshot bytes
were verified as JPEG, irrespective of their initial file extension; originals
were preserved and the final share copy had unnecessary metadata removed and
was rechecked with ExifTool and visual inspection. The screenshot is a page
observation, not additional field collection or hardware evidence. Playback was
sampled at its beginning and end; the earlier exact data checks cover every
imported window, not a claim that every window was manually inspected in the UI.

## Tools

Source preparation: [`prepare-v3-cpraw-replay.py`](../../scripts/prepare-v3-cpraw-replay.py),
with the original segment inputs, `--window-ms 60000 --all` and ignored output.
[`import-admin-replay.mjs`](../../scripts/import-admin-replay.mjs) pins the production
origin, accepts a hidden terminal password only for login, keeps a private
temporary session, whitelists aggregate fields and verifies the imported source.
[`check-published-replay.mjs`](../../scripts/check-published-replay.mjs) performs
the explicitly scoped HTTP/static-render checks without opening another browser.

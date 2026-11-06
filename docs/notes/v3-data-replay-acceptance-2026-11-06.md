# V3 historical-data replay acceptance — 2026-11-06

Status: **bounded local software replay passed**. Saved observations were
processed by the unchanged portable firmware statistics core, then replayed
through the actual local CPV3 relay, RPC Durable Object, service binding,
application Worker, D1 and administrator browser. Broker publishing is a local
substitution. This does not establish production EMQX/native TLS, current field
collection, hardware storage or inference accuracy.

## Sources and transformation

The existing three `captures/raw-algorithm-study-20261029/source/segment-*.bin`
copies contain **602,315** report frames. This run revalidated all files,
including records outside the selected intervals: header/frame CRCs, exact
lengths, untruncated tails, common session, increasing report sequence and
nonregressing timestamps within each frame type. Source hashes matched between
the validation and aggregation passes. No source file was modified.

The files' report sequence is continuous; recorded final cumulative queue-drop
and invalid counters are zero. These are recorder claims at that stats frame,
not proof of radio completeness or independently measured per-window loss.
Replay artifacts explicitly keep original capture losses unknown at per-window
scope and retain the cumulative evidence separately.

Each case starts 373,000 ms after the first report rounded up to a millisecond.
The selected intervals overlap and must not be summed as distinct observations.
The tools compile and call the repository's actual
`firmware/components/cp_v3_stats/stats.c` with 512-key capacity, preserving
report-kind, payload validation, RSSI, bin membership, unique-key, coverage and
quality behavior. No Chimera or other classifier is substituted. Categories
remain `unclassified-v1` unknown, and estimated totals remain unavailable.

Source monotonic boundaries, clock-anchor declarations, source hashes and
normalization diagnostics are private provenance. Replay uses a new boot,
policy, current-time lease and `controlled_test` dataset; durations stay 1/30/60
seconds without time compression. Its `sim-v3-library` placement is a local
test binding, not a claim that historical observations came from the library.
Report/loss counters on the replay wire describe delivery to the replay core;
original source evidence is not promoted to current field authority.

## Measured cases

| Source window / bin | Windows accepted | Source reports replayed | Visible identifier keys | Durable batches | Result |
| --- | ---: | ---: | --- | ---: | --- |
| 1 s / 1 s | 12 | 1,201 | 23–61 per window | 24 | Passed |
| 30 s / 5 s | 1 | 3,084 | 145 in the window | 2 | Passed |
| 60 s / 5 s | 1 | 6,164 | 166 in the window | 2 | Passed |

All selected windows had quality mask 0 in this replay. Coverage comes from the
source's explicit scan-state event; it is not inferred from packet presence.
The first row uses actual historical one-second intervals, not a 30/60-second
interval compressed into one second. The other cases wait their actual duration
and exercise the renewable lease path when required.

Each run passed at least 16 acceptance checks, including:

- Every accepted normalized window exactly matches the independently invoked
  backend validator's normalization of the C-generated template; counts,
  categories, bins, RSSI sums/extrema, coverage, losses and versions agree.
- Stream/window sequences and current replay time are ordered, nonoverlapping
  and inside committed capture-lease spans; status time matches each window.
- Every statistics/status batch has matching committed receipt identity,
  policy, body-digest metadata and sequence tuple. The device runtime itself
  checks receipts against frozen request bytes before releasing its queue.
- Real Chromium opens the historical-replay control label and existing device
  detail, diagnostics and custody panels. Authenticated administrator evidence
  agrees with D1 counts, normalized summaries and bounded receipt rows.
- Public statistics return `no_field_statistics`; no replay is promoted into
  the real-field view. EOF generates no further windows or synthetic fallback.
- Replay upload failures, ACK failures, retries and pending items ended at zero.

Administrator evidence has a list limit. Every row is checked directly in the
isolated D1, while the browser verifies all returned bounded evidence. Receipt
metadata checks do not reconstruct or rehash historical raw source requests;
the report explicitly leaves original raw custody verification false.

## Private evidence and reproduction

Ignored `captures/v3-replay-20261106/` holds the aggregate inputs and independent
private reports:

- `parking-replay-1s.json` / `parking-replay-1s-final-report.json` — final 1-second case,
  additionally checking that failed ACK state remains visible after replay EOF.
- `parking-30s.json` / `parking-30s-report.json` — 30-second case.
- `parking-60s.json` / `parking-60s-report.json` — 60-second case.

The earlier `parking-1s*` trial is superseded by `parking-replay-1s*`, which
clarifies original per-window loss provenance. Do not publish these private
artifacts or raw capture copies with the reusable source tools.

See the [simulator guide](v3-device-simulator.md#喂入已保存的-cpraw) for import,
interactive replay and automated acceptance commands. This run also passed the
8 importer/C-core synthetic tests, 9 runtime/input-loader tests, existing
simulator browser regression, TypeScript and production frontend build.
These checks establish the stated local software boundary only.

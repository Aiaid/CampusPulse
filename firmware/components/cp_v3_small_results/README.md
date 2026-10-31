# Compact v3 small results

Pure one-item `statistics/1` wire serializers for the final small-results path.
See [contract](../../../docs/specs/v3-small-statistics.md). No network, radio,
storage, address table, classifier or temporal-history ownership is added here.

- `cp_v3_small_window_body` takes a complete bounded stats snapshot and its
  exclusive end time, validates counter/RSSI/bin/category conservation and emits
  one compact item. Snapshot address capacity can be512; it does not inherit the
  historical feature producer's16-address bound. The current stats core supports
  at most12bins, which the wire validates and must be advertised honestly.
- `cp_v3_small_event_body` takes an address-free temporal event snapshot and its
  actual slice duration. Random episode UUID, revision, observation state/cause,
  bounded totals and scan-quality semantics remain intact. It neither uploads
  address keys nor claims arrival, boarding or waiting-time predictions.
- `cp_v3_small_status_body` preserves resource unknowns as JSON null, includes
  required queue/loss/retry counters and optionally adds six measured TF raw
  recording counters. Raw counters are omitted when unavailable, not fabricated
  as zero. Their presence must match the frozen policy's local_raw mode.

Initial extractor/rules are `cp-v3-stats/1` and `unclassified-v1`: every retained
key is unknown. Nonzero other categories fail closed until a reviewed classifier
version and corresponding wire/server contract are implemented. A company ID,
OUI or Appearance value does not become a phone/vehicle count.

Caller supplies actual policy/node/boot scope, batch UUID and once-allocated
per-stream sequence. The writer returns exact body bytes, their SHA-256 and
`cp_v3_expected_t` for immutable queueing and receipt matching. It clears output
length/expected state on failure; insufficient capacity never yields a partial
successful body. Buffers can be smaller than4096 when negotiated; there is no
heap allocation. Unknown UTC serializes as paired null values and sets the clock
quality bit; backend historical upload authorization may still reject it.
Creating a body is not proof of application, durable storage or device accuracy.

Source retention is outside serialization. Freeze the original source deadline
with the body using the small-results queue, based on the earliest possible
source time and actual policy retention. Never regenerate its body/expiry under
a later policy or newly calibrated clock. Events can span windows, so their
metadata does not require an invented window association.

Synthetic host acceptance uses ASan/UBSan and the actual TypeScript server
validators, including unknown UTC, invalid counters, output exhaustion, closed
and censored events, nullable resources and TF raw status:

```sh
UV_CACHE_DIR=/private/tmp/campuspulse-v3-queue-uv uv run --no-project python firmware/components/cp_v3_small_results/tests/test_small_results.py
```

Measured exact synthetic bodies with the server's template identifiers:

| Body | Bytes |
| --- | ---: |
|30s window,5s bins |585 |
|60s window,5s bins |678 |
| terminal visibility event |581 |
| status without raw counters |430 |

These match the backend templates and fit a1024-byte body budget for these
fixtures. They are not a universal byte bound or a measurement of actual radio,
TLS, status/control or retry traffic. Longer identifiers, larger counters and
different bin counts change sizes; serialization/preflight must always enforce
the negotiated body limit. No actual board or endpoint is accessed by tests.

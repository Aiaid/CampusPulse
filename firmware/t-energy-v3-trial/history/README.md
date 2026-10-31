# Historical authorization evidence diagnostics

Status: host-tested, read-only structural diagnostics; **not an upload gate**.
No firmware build wiring, NVS backend, hardware operation, network upload or
permission callback is supplied. All results retain `TE_HISTORY_RELEASE_BLOCKERS`,
including `TE_HISTORY_STRUCTURE_MATCHED`. Do not adapt that enum to a `true`
historical-authorized callback.

This addresses the historical-retry boundary in
[`v3-small-statistics.md`](../../../docs/specs/v3-small-statistics.md). The current
small queue retains original boot/scope/body, while runtime recovery still needs
an independently justified `historical_authorized` implementation. A committed
control receipt is a statement about a device ACK or lease. The shared strict
matcher can correctly match a **failed** ACK; matching does not prove successful
application or observation authority. These protocol receipts are not server
signatures. SHA-256 binds bytes and does not authenticate their origin.

The updated server contract does **not** require a device to store or download
this full evidence bundle before retransmitting an original frozen statistics
body: the authenticated backend resolves its retained historical authorization.
This diagnostic explores a stricter device-side proof and must not be presented
as a protocol prerequisite. The board still needs its own persistent local
resource/usage ledger, same-node exact-body protections and safe expiry handling;
the current runtime has not yet implemented and tested that recovery path.

`local_guard.c` separately checks the bounded one-item window/status wire subset,
same-node frozen identity, SHA-256 and conservative observation time. It rejects
raw, per-address payloads, unknown fields, unsupported JSON encodings and unknown
time. Its result is diagnostic only: original-clock provenance, backend approval,
local budget, queue expiry and a strict receipt remain independent obligations.

## Implemented checks

`te_history_inspect` reads a bounded original-artifact bundle through an injected
read-only provider. It has no current-policy argument and never calls an apply
callback, changes live shared control state, invents a receipt, or reserves quota.

- Reuse the actual shared strict capability/policy parser and canonical policy
  digest to bind node, boot, original capability, policy ID/hash/generation,
  placement and dataset. This is the original full frozen policy envelope, not
  a hand-filled policy summary or replacement current desired policy.
- Match the original exact applied request/committed receipt with the shared
  verifier, then separately require `state:applied`, closed-boundary constraints,
  server/receipt chronology, and the original capability/policy/lease deadlines.
  This validates the server's applied **claim**, not a local actual-allocation
  event. It deliberately does not fake `cp_v3_control_apply` during recovery.
- Match up to four original lease request/receipt pairs, with increasing contact
  sequences and nondecreasing uptime/server/deadline. Extend only a contiguous
  same-numbered span; a post-expiry renewal requires the next span number and
  creates a real gap. No merge across a gap and no use of a later lease to
  backdate authority.
- Require known UTC, nonzero same observation clock epoch, ordered monotonic
  times, bounded 0–5000 ms uncertainty, and the entire conservative observation
  interval inside one confirmed span. The exclusive observation end may equal
  the span end only when its uncertainty does not reach beyond it. Unknown UTC,
  overflow, gaps, future observations and epoch changes fail explicitly.
- Require the latest plausible upload time to precede original `accept_until`
  and conservative source retention. Preserve the frozen policy's original
  daily upload limit, enforce its body bound, and identify one unambiguous UTC
  upload day. Midnight-straddling uncertainty fails. No current policy may raise
  the historical quota or deadline.
- Missing, torn, truncated, corrupt, oversized or failed provider reads fail.
  There is no auto-format, fallback state, success-on-missing, eviction or I/O
  mutation.

The parser fact-extraction helpers are currently shared **internal** APIs. This
audit module intentionally uses the same strict parser instead of inventing a
weaker JSON parser. A typed public historical-proof API should replace that
dependency before firmware integration. The parser/receipt matcher is linked
unmodified in tests.

## Exact remaining blockers

The report's following bits are unconditional. The source callback cannot assert
that it is trusted and clear them; there is no `ready`, `allow` or `authorize`
result. The component cannot be used to open the runtime recovery gate.

| Blocker | Evidence still needed |
| --- | --- |
| `NEEDS_DURABLE_ORIGIN` | A real, separately owned persistent provider preserving exact authenticated-origin capability/policy/control artifacts and a consistent immutable snapshot. SHA/checksum alone is not provenance. |
| `NEEDS_ACTUAL_APPLY_JOURNAL` | The actual paused-boundary allocation/application result, durably correlated with the exact pending ACK before new observations are admitted, plus the exact committed receipt. A server receipt alone cannot prove that allocation occurred. |
| `NEEDS_CLOCK_JOURNAL` | Original boot/epoch trusted UTC mapping and its uncertainty, recorded before capture and valid through the actual observed interval. Caller-supplied times here are only diagnostic claims. |
| `NEEDS_PLACEMENT_VALIDITY` | Original placement validity/closure evidence covering the whole conservative observation span. Equality to the frozen policy placement ID does not establish its validity interval. |
| `NEEDS_BODY_TIME_BINDING` | Strict parsing of the exact frozen statistics body, SHA/identity match, and extraction of its actual observation interval. An event's later censored stop marker must not extend source age or coverage. This checker receives a claimed interval and length only. |
| `NEEDS_ORIGINAL_DAILY_BUDGET` | An original-policy/node-scoped persistent daily ledger and a serialized, durable reservation before each transmission, including retries and failure charges. Here the original limit and upload day are checked, but used/reserved bytes are unknown. |
| `NEEDS_REGISTRATION_EVIDENCE` | The original accepted capability registration and its exact identity binding, retained independently from current boot registration. Structurally valid capability JSON is not accepted registration evidence. |

The server must also recheck credentials/revocation/authorization in its final D1
transaction. A future device proof is not a bypass for that transaction.

`cp_v3_budget` can conservatively charge a node's current-day logical budget,
but its current record does not itself attest the original-policy daily lineage,
historical receipt provenance, or atomic linkage to a recovered batch. Reading a
budget snapshot also does not reserve bytes. Integrating it needs a reviewed
owner namespace, all-writer serialization and the original frozen limit, with
no quota reset on policy/boot changes. Do not refund failed sends or infer zero
usage from an absent/corrupt ledger. Consumption on earlier upload days must
remain evidence; current retransmissions consume their current upload day.

## Provider and bounds

The provider loads exact original JSON artifacts under the caller's snapshot
lock. It must distinguish positively absent data from storage failure/corruption,
reject partial reads, and retain original artifact order. The supplied provider
in tests is an in-memory fixture reader only. There is no on-device serialized
format or NVS namespace defined here; native C structs must not be persisted.

The maximum input bundle is 32,768 bytes: one 4,096-byte capability bound, one
8,192-byte policy envelope, and ten 2,048-byte applied/lease request/receipt
artifacts (one applied pair and four lease pairs). Capability content must be
shorter than 4,096 bytes to match the shared control bound. The diagnostic
workspace measures 58,616 bytes on the host test ABI and must not be placed on
a small device task stack. This is not a measured ESP32 memory/capacity claim.
At most five span records are kept. Exceeding four lease records is rejected;
there is no silent truncation or history compaction.

This bundle cannot be squeezed into the current small queue's three 2,048-byte
NVS records. A real provider needs its own capacity, atomic manifest/commit
semantics, write-budget accounting and loss/uncertainty behavior. Removal or
reclamation of an acknowledged control queue entry must not erase history still
needed until `accept_until`. Power-loss acceptance and real NVS integration are
open work, not implied by these tests.

## Verification

Run from the repository root:

```sh
uv run firmware/t-energy-v3-trial/history/tests/run.py
```

In a sandbox that cannot use the default uv cache, add
`--cache-dir /tmp/campuspulse-history-uv-cache` after `uv run`.

The fixture generator uses the actual backend control handler, migrations,
SQLite D1 adapter, canonical policy hash and shared fixture factories with a
synthetic clock and an in-memory database. It generates an applied ACK,
contiguous renewal, post-gap renewal and failed ACK. Test-only credentials exist
only in memory and are not included in output. These are synthetic local server
transactions, not physical board or production evidence.

ASan/UBSan tests link the real shared control parser/matcher and OpenSSL SHA-256.
They cover original scope changes, hash changes, failed ACK despite a successful
exact match, unknown/uncertain/cross-epoch time, lease gaps and boundary crossing,
expiry/retention, UTC-day ambiguity, body/capacity limits, missing/I/O/corrupt/
truncated/oversized artifacts and tampered lease sequence. Every invocation
asserts that all release blockers remain set.

Test fixture setup follows the existing
[`generate-v3-statistics-control-fixtures.mjs`](../../../scripts/generate-v3-statistics-control-fixtures.mjs)
pattern and uses its repository-owned backend helpers; no external source was
imported. Any later commit should include this local reuse in the repository's
shared reuse notes through the owning session.

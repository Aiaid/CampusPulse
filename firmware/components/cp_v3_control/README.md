# Controlled one-boot v3 control core

This is a portable, bounded parser and state machine. It opens no network/radio,
stores no credentials, performs no Flash/TF writes and is not linked to a board
by this component. `cp_v3_evidence` supplies common types/version labels only.

The supported subset is intentionally narrow: `controlled_test`, passive1M,
duplicate filtering off, window-scoped all-worker company/Appearance evidence,
at most16identifiers, one item/4096-byte body, raw/sample/archive off, HTTPS and
durable Flash or TF journal with feature/status/control reserves. Both expiry
actions pause collection/upload; local raw stops. No TF or display is required
by shared logic. TF slot overhead and actual recoverability are checked by the
board's real apply callback, not inferred from a capability claim.

Initialization validates the complete explicit capability JSON snapshot, sorts
object keys while preserving array order, and computes SHA-256 over the exact
`campuspulse-v3-canonical-json/1\n` prefix and canonical bytes. Policy parsing
checks every required object/field, type, discriminator, range, reservation sum,
supported feature and capability limit. It recomputes the complete policy hash
and binds node, boot and the complete capability digest. Strict JSON rejects
unknown/duplicate keys, unsafe numbers, nesting/token/byte excess and trailing
input. This controlled subset accepts the server's unescaped ASCII strings and
unsigned decimal integers; escaped/non-ASCII/exponent representations fail
closed rather than being normalized loosely.

Stages are initialized, registering, registered, offered, ACK-pending, applied,
failed and paused. Configuration delivery never marks a device applied.
`cp_v3_control_apply` checks policy/capability time and closed boundaries, invokes
the caller's actual resource/application callback once, then checks its resulting
boundaries for openness/regression. Success means configured/reserved **with the
scanner still paused**. It freezes a terminal ACK; no capture or upload is
permitted before an exact committed server receipt matches it. Failures produce
an immutable failed ACK. Unsupported/untrusted offers produce no guessed ACK.

Registration and terminal ACK retries return their original exact bytes. Server
timestamps on receipt replay cannot change. A new assignment is unsupported in
this first one-boot trial; reinitializing to manufacture a new boot or application
event is not recovery. Unknown already-applied server history fails closed.

Permissions use the earliest policy expiry, custody deadline, capability expiry
and server ACK time plus lease. UTC uncertainty is applied conservatively, and
the remaining deadline is also frozen onto monotonic time. GET and receipt replay
never renew it. Epoch changes, monotonic regression and expiry pause; every
outcome preserves unacknowledged data. The caller must check permissions before
starting a full window and before each upload, allow uncertainty at both window
ends, and never cache a permission beyond its deadline. Capability issuance must
be at/before the trusted interval's lower endpoint.

The public header is the integration contract. Keep the caller-owned control and
workspace outside a small task stack. Inputs contain no Wi-Fi or bearer secret.
SHA-256 is supplied by the runtime; host tests use OpenSSL and independently match
the actual TypeScript core's digests. Runtime retention, queue reservation and
daily byte/write accounting, frozen batch transport/reclamation, TLS/clock
bootstrap, single ownership and physical memory/power-loss acceptance remain
adapter responsibilities. The module grants no production/deployment authority.

Run from the repository root:

```sh
UV_CACHE_DIR=/private/tmp/campuspulse-uv-cache uv run --no-project python -m unittest discover -s firmware/components/cp_v3_control/tests -p test_control.py -v
```

Tests generate synthetic complete capabilities/policies with the actual local
TypeScript canonical hashing/negotiation core. They cover TF and no-TF Flash
profiles, reordered keys/arrays, incorrect hashes/binding, unknown fields,
unsupported features, queue budgets, expiry, closed/apply boundaries, failed and
committed ACKs, frozen retries, clock changes and nonrenewable leases. Actual
device operations and server authorization/storage transactions are not executed.

# Synthetic backend control receipt fixtures

These six exact-byte fixtures are synthetic request/receipt pairs for the v3
control backend: applied acknowledgement, failed acknowledgement and lease.
They are copied unchanged from the local backend-generated trial templates.
They use the explicit nonregistered synthetic node and policy from
`tests/helpers/v3-statistics-policy-fixtures.ts` and the synthetic test boot UUID
from `tests/helpers/device-v3-fixtures.ts`. They contain no observations or
credentials and do not represent an actual device or committed server state.

The copies were checked for synthetic node/policy/boot, absence of identity or
credential fields, and request SHA-256 equality with each receipt's recorded body
hash. Preserve request and receipt bytes together; do not pretty-print either
file, since the tests validate the exact frozen request digest with the real
strict control matcher. Changes to backend receipt semantics require regenerating
and revalidating all affected pairs, rather than editing responses to make tests
pass. The tests require OpenSSL and `pkg-config`; no local `captures/` path is
needed.

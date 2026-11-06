# Continuous online simulator

Status: deployed with bounded online renewal verification, 2026-11-06. The user explicitly requested
that the two existing online virtual devices run until stopped. The public live
display version remains fixed; this change concerns the simulator and its scoped
backend renewal only.

## Previous disappearance

The bounded clients exited normally around 17:53 after their 20-minute startup
deadline, including initial assignment wait. They reported 95 and 107 accepted
statistics/status pairs, no pending batches and zero loss/upload/ACK/retry counts.
After 90-second freshness expired, the normal map hid their current actors.
Historical records remained intact. Both virtual placements have no end date;
placement expiry was not the cause.

During the temporary recovery, the old bounded MQTT client disconnected and
exhausted retries because it had no reconnection lifecycle. Its one and two
pending batches were retried with their exact original boot/body identities;
all three received matching committed receipts before new sessions started.

## Continuous mode

Set `continuous: true` in each existing owned 0600 private configuration. The
client then has no preview deadline. Bounded mode remains available, with its
display duration measured from the first applied ACK and initial assignment
wait measured separately.

The client preserves its boot and sequences, closes/drains the current window
and frozen data/control bytes before refreshing capabilities. Refresh occurs
before either capability or policy expiry; a short policy uses a proportional
lead so it cannot trigger an immediate renewal loop. MQTT disconnection uses
bounded backoff and preserves the RPC high-water mark, exact pending bytes and
receipt checks. TLS, producer identity and raw-data restrictions are unchanged.

The separate deployment grant `DEVICE_V3_SIMULATOR_CONTINUOUS_NODE_IDS` defaults
to `[]` and must be an exact subset of the admitted simulator nodes. After a
successful authenticated MQTT capability registration, the backend may derive
the next immutable generation only from that node's current desired policy and
matching durable applied ACK. It retains the approved placement, profile and
budgets, binds the new capability digest, respects normal finite authority and
requires a real new ACK/lease. A pending administrator change is never replaced.
Physical devices and initial onboarding do not gain automatic approval.

Disabling the node or removing the grant prevents new renewal. Already-issued
policies retain their original finite validity. No administrator cookie is
required by this mode. No historical queues, receipts or records are deleted.

## Operation and limits

The Node processes run on the current computer and need its network connection.
They are not a deployed cloud daemon or an automatic restart service. SIGINT or
SIGTERM stops them and writes a private pending-state audit snapshot; this does
not establish automatic durable restart recovery. A local SIGUSR1 requests the
same drained renewal path for verification; it is not a public control endpoint.

Verification must distinguish fake-clock lifecycle tests, real local D1/native
entrypoint tests, and actual production same-boot renewal/map checks.

## Recorded verification

The selected backend/client-only source snapshot passed 1,559 tests in 111 files,
TypeScript/Vite build and Wrangler dry-run. It excluded all display, firmware and
unrelated administration edits. The current published HTML matched the frozen
HEAD build; deployment reported no changed static assets. The main Worker was
published as `8452a0e2-986f-4475-971e-6eb4faf5e05b` with existing variables and
bindings retained and only the exact two-node continuous scope added.

Both actual native MQTT clients obtained new applied policies without an admin
cookie. A local renewal signal then exercised the same drained path used by
expiry: both kept the original boot, advanced registration 1→2 and policy 3→4,
and committed new-generation windows (19 and 26 at the check). Production summary
reads were fresh with 12/24 keys and bike/car candidates 3/2 versus 6/3.
Normal 30-second statistics windows were subsequently selected for ongoing use.
Idle-sleep prevention is tied to the owned simulator PIDs and releases when they
exit. This bounded check does not establish arbitrary power-loss recovery or
indefinite reliability.

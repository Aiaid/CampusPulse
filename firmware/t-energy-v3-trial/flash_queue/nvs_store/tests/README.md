# NVS host integration tests

From the repository root, run:

```sh
bash firmware/t-energy-v3-trial/tests/run_host_tests.sh
```

The existing runner builds with C11, warnings as errors, AddressSanitizer and
UndefinedBehaviorSanitizer. `control_receipt.c` links the shared queue, NVS
adapter, real `cp_v3_control_match_frozen_receipt` and OpenSSL SHA-256. It runs
each applied-ack, failed-ack and lease pair twice: the checked-in synthetic
fixtures and freshly generated backend fixtures. OpenSSL and `pkg-config` are
required. No captured device data, network service or attached device is needed.

The historical control cases verify that:

- Default configuration, the generic `allow_historical_small` option, a legacy
  profile and a different node keep old control records quarantined.
- Explicit `allow_historical_control_reclaim` exposes a same-node small control
  record with its original boot, complete expected envelope and exact body bytes.
  The ordinary ingestion ACK cannot reclaim it.
- Changed receipt boot, body hash or policy hash fails the real strict matcher;
  an invalid lease deadline also fails for receipt types carrying that field.
  Changed request bytes and scope bindings fail matching. Every rejected receipt
  preserves the complete original NVS record and creates no expiry tombstone.
- Unknown or expiry-straddling time blocks the matcher. A damaged stored body or
  source-expiry field blocks reclamation before the matcher runs. At the source
  deadline, failed expiry storage preserves the original record.
- The exact original receipt reclaims the historical record after reopening.
  The opt-in still rejects attempts to enqueue an old-boot record, including
  after successful reclamation.

These are host tests with synthetic fixtures, simulated NVS and a simulated
clock. They establish neither hardware durability nor permission to capture or
apply a configuration under an old boot. Stateless historical receipt matching
does not update the current boot's control state or lease authority.

## Window snapshot through durable handoff

The same runner builds `window_handoff.c`, linking the real board statistics
worker/window, `board_window_freeze`, handoff state machine,
`cp_v3_small_window_body`, OpenSSL SHA-256, small-results queue and NVS adapter.
Only the collector callbacks, trusted clock and NVS API are host substitutes.
Twelve deterministic synthetic reports produce one real 60-second statistics
snapshot. Its scope, window sequence, fixed batch/stream sequence, exact snapshot
bytes and independent direct serializer output are checked through handoff.
The current vector produces a **626-byte body / 1144-byte complete record**;
the test asserts the 1024-byte body and 2048-byte encoded-record limits.

The integration verifies exact NVS readback before returning durable success,
then separately releases the original collector snapshot. Both NVS's three-key
cap and its available-entry guard apply backpressure. Actual mocked blob writes
can fail as well. Two failed attempts preserve the same snapshot, body,
identity and SHA-256 with no additional peek or collector release; after the
condition clears the exact item can complete. The test binding reopens the queue
before each store retry to reconcile uncertain RAM state against persisted bytes.
A wrong envelope body hash is rejected by the queue; a changed handoff digest
faults before storage. Neither permits collector release.

After successful persistence and collector release, reopening with the original
boot reads identical bytes and envelope from NVS. A wrong receipt digest keeps
the record; the exact strict statistics receipt reclaims it. The test reserves
the control slot and leaves it empty throughout; it manufactures no control
acknowledgement. Reused NVS test helpers have a renamed standalone main to keep
the executables separate.

This is a host integration of the real computation/serialization/storage
sources. The runtime collector remains a stub and its store/release binding is
not installed by this test. NVS failure injection does not establish real flash
atomicity, wear, capacity, power-cut survival, radio quiescence, live upload or
server acceptance. The fixed sequence, batch and synthetic receipt are test
inputs, not a production sequence allocator or backend transaction.

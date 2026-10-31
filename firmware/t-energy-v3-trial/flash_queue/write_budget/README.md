# Cross-restart write reservation core

This portable core reserves a caller-chosen number of write units against a fixed
UTC calendar-day limit. It does not access NVS or any hardware, allocate a Flash
partition, perform the actual queue write, or promise Flash wear or power-failure
behavior. The owner must serialize every operation and use one budget owner.

`te_budget_open` never initializes absent data. Only an explicit
`te_budget_provision` can create an initial record, and its caller must first
establish that the chosen backend is truly new and dedicated: absence after
corruption, rollback, erasure or a failed provisioning attempt is *not* proof of
new storage. Do not automatically provision after absence or I/O failure.

`te_budget_reserve` requires externally authenticated/credible UTC and saves the
new time and consumed units before returning OK. The caller may perform at most
those reserved operations after OK. A failed actual operation still consumes its
reservation. A save failure latches the instance blocked; reboot/open must
reconcile from the backend before further requests. A save that succeeded but
returned failure can consume budget without granting a write, deliberately.
Unknown or earlier-than-last-persisted time is rejected, including after reboot.
The first reservation on a later UTC day persists the reset and reservation in
one transaction. A later exhausted attempt persists its observed time before
returning exhausted so a reboot does not forget that observed time; this itself
adds storage writes. Events where time is never passed to this component cannot
be detected. A clock that falsely jumps forward may grant a new day: this core
cannot authenticate time, detect a spoofed future or prove elapsed time. Do not
pass a guessed time as trusted.

The backend contract is stronger than a plain write function: after a successful
save it must durably recover that record or a newer one, never silently return
an older record or absence; after an interrupted/failed save it may return the
old or new valid record, or return error, but must never return absent/invalid as
a fresh empty store. Failed/ambiguous operations must not be retried as fresh
provisioning. Backend storage must preserve integrity and distinguish corruption,
be power-loss tested, and protect against stale copies/rollback; CRC catches
accidental corruption but does not prevent replay or hostile alteration. No
production backend here satisfies or verifies these requirements. In particular,
no NVS guarantees are assumed without an actual designed and tested adapter.
Physical brownout, voltage safety, reliable UTC and hardware endurance cannot be
established by these host tests.

The budget applies to queue operations selected by the caller, not its own
metadata saves. Size the total wear budget including these saves, erase/write
amplification, retries, rotation and other users of the same Flash. A budget
counter is not a wear-leveler and using a dedicated backend cannot establish that
its physical sectors are unused. Queue entries must still be retained until a
strict durable receipt; the current v3 server rejects new retired-boot uploads,
so this counter alone does not provide cross-boot queue delivery.

Host-only injected save-before, save-after, torn record and read failures:

```sh
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I firmware/t-energy-v3-trial/flash_queue/write_budget \
  firmware/t-energy-v3-trial/flash_queue/write_budget/write_budget.c \
  firmware/t-energy-v3-trial/flash_queue/write_budget/tests/test.c \
  -o /tmp/cp-te-budget-test
/tmp/cp-te-budget-test
```

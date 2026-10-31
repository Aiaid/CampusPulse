# T-Energy trial Flash queue adapter

**Not suitable for the current no-repartition T-Energy task.** See [the existing cpqueue audit](CPQUEUE_REUSE.md).

`te_flash_queue_prepare` binds an existing **dedicated** `v3queue` data
partition (subtype `0x40`, exactly `0x18000` bytes, 4 KiB erase size,
unencrypted, writable). It does not create, format, erase, or verify ownership
of the underlying Flash region. The caller must verify the real partition table,
that the entire region was provisioned for this purpose, and that it does not
contain old data before deployment; selecting a label cannot establish ownership.
Do not map it over the existing `cpqueue`. All access must be serialized and the
partition exclusively owned for the lifetime of the queue. No device was touched.

There are twelve 8192-byte slots, each accepting up to 6144 record bytes.
An all-0xff slot is free. A write verifies the payload before writing and
verifying the length/CRC/magic header; incomplete, invalid or foreign bytes are
occupied, never erased automatically. Failed operations mark the slot uncertain
in RAM until reopen. On reopen an interrupted write may be free if no bits changed,
valid if publication completed, or quarantined if partial. A successful store
means the synchronous ESP-IDF partition calls and readback succeeded, not that
power-loss behavior or flash endurance was physically verified.

Only `cp_v3_queue` should call reclaim after matching its durable application
receipt. It verifies the exact encoded record before erasing its second sector,
then the header sector; interruption leaves either a free slot or a valid or
quarantined record. The queue's own hash and boot identity checks still apply.
Ambiguous slots need explicit offline investigation, not automatic recovery.
A matched server receipt followed by power loss may cause duplicate retry; server
idempotency is required. CRC detects accidental damage, not malicious alteration.
Flash writes/erases wear the chip; no wear leveling, lifetime or throughput claim
is made. The partition is plaintext and must not be used for secrets.

Host-only fault injection (no ESP-IDF or hardware):

```sh
cc -std=c11 -Wall -Wextra -Werror -I firmware/t-energy-v3-trial/flash_queue/tests \
  -I firmware/t-energy-v3-trial/flash_queue firmware/t-energy-v3-trial/flash_queue/flash_queue.c \
  firmware/t-energy-v3-trial/flash_queue/tests/test.c -o /tmp/cp-te-flash-test
/tmp/cp-te-flash-test
```

Actual ESP-IDF integration, physical flash erase interruption, brownout,
readback, wear and long-run behavior remain to be verified.
Reference: [ESP-IDF v5.5.3 partition API](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32s3/api-reference/storage/partition.html).

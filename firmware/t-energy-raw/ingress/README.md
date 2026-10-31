# T-Energy raw ingress

A bounded, single-producer/single-consumer ring for SDK-delivered BLE reports.
It does not scan, interpret data, persist, transmit, or imply radio completeness.
Caller allocates a power-of-two array of `te_raw_report_t` slots (for example in
PSRAM), and keeps that array and the initialized `te_raw_ingress_t` alive until
scanning is stopped, all callbacks have returned, and the worker has stopped.
Initialize/reset only while both producer and consumer are stopped. The caller
must ensure the SDK invokes this producer serially. There is exactly one consumer.

Populate metadata from the actual SDK legacy or extended descriptor, preserving
address bytes in SDK order, event, type, RSSI and extended fields as delivered.
The caller must explicitly define sentinel values for fields absent from a given
SDK descriptor and must not describe sentinel values as measured facts. Set
`kind=0` for legacy and `kind=1` for extended; the component copies metadata
without validating or inferring it. The caller supplies the callback's monotonic
timestamp and a readable payload pointer and exact length; no SDK pointer is
retained after return. Zero-length data may use a null pointer. Oversized data
or a null nonempty payload is rejected, never truncated. The upper bound of
1650 is a storage limit, not a claim that any SDK delivers this amount.

`push` assigns a 64-bit sequence to every attempted report, including rejected
reports, copies into a free slot and publishes it using release/acquire atomics.
It performs no allocations, locks, waits or retries. The worker `pop` copies the
record into caller-owned non-aliasing storage and releases the slot. Only the
first `length` payload bytes of the output are defined. Do not reuse that output
until its consumer finishes. Full, oversized and invalid drops are counted;
received and enqueued are separately counted. Counters are 32-bit modulo values,
individually sampled and not an atomic combined snapshot; read after stopping
producer for a consistent accounting. Sequence exhaustion rejects subsequent
reports. Loss before delivery by the SDK, controller or radio is not observable.
This component cannot guarantee durability: slots are volatile and power loss
loses buffered reports. A slow or disconnected worker eventually fills the ring.

Host test (no device access):

```sh
cc -std=c11 -O2 -Wall -Wextra -Werror -pthread -I firmware/t-energy-raw/ingress \
  firmware/t-energy-raw/ingress/raw_ingress.c firmware/t-energy-raw/ingress/tests/test.c \
  -o /tmp/cp-te-raw-ingress-test
/tmp/cp-te-raw-ingress-test
```

The test covers byte copying, metadata, all loss classes, sequence gaps,
32-bit ring-index wrap and concurrent producer/consumer ordering. Actual ESP-IDF
build, callback serialization, PSRAM placement, capture rate and saturation
must be checked during integration and on hardware; no test here claims those.

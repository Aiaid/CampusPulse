# Matched LAN HTTPS / MQTT-TLS comparison

Isolated ESP32-C3 diagnostic, built with ESP-IDF 5.5.3. This does **not**
replace the production application. It measures native SDK transports against
two listeners on the same physical host, with the same ECDSA P-256 certificate,
CA, network path and TLS 1.2 cipher. See the [server instructions](../../../relay/transport-compare/README.md).

The application uses saved Wi-Fi through a static, read-only NVS partition
descriptor. Wi-Fi settings remain in RAM; Wi-Fi and PHY NVS writes are disabled.
TLS CA, hostname/IP SAN and certificate date checks remain enabled. Receipt
guard version 2 rejects decoded U+0000 in all JSON keys/values before cJSON can
truncate C strings; `COMPARE_START receipt_guard=2` identifies this build.
A current
external configuration epoch initializes the diagnostic clock; it is not an
authenticated time service. Logs contain numeric counters and synthetic receipt
identities only. The secret is never printed, but the local build artifacts
contain it and must remain private.

Default workload, for each total application payload size of 1024 and 8192 bytes:

- HTTPS: six fresh clients, one keep-alive priming request, ten warm requests.
- MQTT: three fresh connect + QoS1 SUBACK + message trials; one additional
  connection and ten warm messages. MQTT uses native ESP-MQTT 3.1.1, not WebSocket.
- Every body contains a random 16-byte run correlation, four-byte big-endian
  sequence and deterministic synthetic remainder. Both protocols send identical
  bytes for any given correlation/sequence/size and receive the same eight-field
  `cp-link-probe/1` length/SHA-256 receipt. No real node, capture or BLE payload
  goes to either listener.

The application receipt's `kind=transport_received` means that this process
verified the bytes in RAM. It does **not** assert D1/R2, disk, production ingest,
or durable delivery. MQTT PUBACK and this application receipt are separately
required and logged; neither is substituted for the other. Only one outgoing
QoS1 application message is outstanding. The outbox limit is 20000 bytes and
the MQTT task stack is 6144 bytes; these are configured limits, not measured
allocation sizes.

`mqttDirectPublish=0` (default) retains the original `esp_mqtt_client_enqueue`
path. In pinned ESP-IDF 5.5.3, enqueue places data in the outbox without waking
the MQTT task's blocking transport-read poll. Its receipt latency therefore
includes SDK worker scheduling delay and must not be labeled pure MQTT wire
protocol latency. Set `mqttDirectPublish=1` for a separately labeled controlled
trial of `esp_mqtt_client_publish`, whose synchronous send executes in the
calling diagnostic task. Both use the same QoS1, one-outstanding-message limit,
outbox accounting, PUBACK correlation and verified application receipt. Overall
elapsed time and payload goodput include the selected API call plus both ACKs.
`api_call_us` isolates the call; `enqueue_call_us` or `publish_call_us` identifies
the selected path, with -1 for the unused API. `puback_us` and `receipt_us`
remain relative to the same request start. Preserve the original enqueue run
and report its API selection separately from direct-publish results.

`mqttOutSize` optionally selects the native MQTT output buffer, integer
1024–9000 bytes, default 1024. Keep 1024 when first changing API selection to
avoid confounding SDK poll delay with fragmentation/buffer memory. Larger
values require another controlled run. Startup, connection and message logs
include actual `mqtt_api` and `mqtt_out_size`; receipt/lifetime version guards
remain unchanged. Counts 1/6/1/6 yield 30 total receipts across both sizes,
including the two HTTPS priming requests.

Optional task CPU accounting is a separate paired profile. `cpuStats=0` is the
default and performs no task lookups, scheduler suspension or forced yields.
To return to the original kernel baseline after a CPU-profile build, also use
a fresh sdkconfig with only `sdkconfig.defaults`; setting `cpuStats=0` alone
does not remove runtime accounting already enabled in a cached sdkconfig.
For `cpuStats=1`, use a fresh sdkconfig with the override below; a compile guard
requires unicore non-SMP FreeRTOS, trace facility, ESP_TIMER microsecond runtime
statistics and 64-bit counters. Apply the same profile to both protocols:

```sh
uv run --no-project --python /absolute/esp-idf-python/bin/python \
  "$IDF_PATH/tools/idf.py" -C firmware/diagnostics/transport-compare \
  -DSDKCONFIG=/absolute/private/compare-sdkconfig-cpu \
  '-DSDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.cpu-stats' \
  -DCP_COMPARE_CONFIG_FILE=/absolute/private/compare.json build
```

The observer allocates no heap, starts no task, scans no stack and uses one
scalar `TaskStatus_t`. It suspends the unicore scheduler across task lookup and
read, then resumes it; interrupts remain enabled. It identifies the native
`mqtt_task` using the exact pinned SDK name and its trace task number. Every
snapshot first yields the calling `main` task for one tick so FreeRTOS charges
its current running tail before the read. The two yields occur outside the
recorded protocol latency window, but alter scheduling and add interval time.

`COMPARE_CPU main_us` is a task runtime counter delta, not request wall time.
`mqtt_us` is the same-task MQTT counter delta for warm messages. Fresh MQTT
starts before connection/task creation and samples after verified receipt while
the task is still alive; if absent before and present after, the newly created
task's entire counter is included (`mqtt_new=1`). Fresh MQTT also includes the
existing connection diagnostic line between setup and the request. HTTP reads
only the main task, after HTTP client creation but before request preparation.
Thus fresh lifecycle coverage differs slightly; warm rows are the cleaner
paired comparison. The main and MQTT task CPU values exclude BLE, Wi-Fi,
TCP/IP and other tasks, so their sum is not total system or complete protocol
CPU cost. Kernel/context-switch and ISR attribution follow FreeRTOS; interrupts
can be charged to the interrupted task. No CPU percentages are inferred.

`known` is a bitmask: 1 validates main, 2 validates MQTT. Unknown CPU values are
zero placeholders, not measured zero usage. Reason codes: 0 known, 1 absent,
2 recreated task, 3 backwards/wrapped counter, 4 invalid/non-increasing clock.
`interval_us` spans the snapshots and includes yielding/instrumentation.
`snapshot_wall_us` is their total observer wall time, including both one-tick
yields; `snapshot_read_us` is total lookup/read/resume wall time and may include
interrupts/preemption. Neither is observer CPU time. Two startup
`kind=control mode=empty` rows give raw empty-interval CPU/wall observations
under the same BLE/Wi-Fi activity. Preserve these observations and report the
instrumentation limit; do not blindly subtract them from protocol measurements.
The observer's remaining current-task tail is small but not eliminated by
yielding; task-counter results are instrumented attribution evidence, not
exclusive TLS/HTTP/MQTT instruction accounting.

MQTT lifetime guard version 1 (`COMPARE_START mqtt_lifetime_guard=1`) keeps all
callback state, client ownership and receipt queue in static lifetime storage.
Only a confirmed `esp_mqtt_client_stop()==ESP_OK` licenses destroy/queue release
after a successful start. A supervised stop worker waits up to ten seconds;
failure, timeout or worker allocation failure marks the experiment failed and
aborts every remaining transport group. The client, queue, callback state and
any late stop worker are retained safely until hardware reset. They are never
reinitialized or treated as successfully cleaned up. The worker accesses no
client state after publishing its completion. An initialized client whose SDK
start never succeeded may be destroyed without stop. The pinned SDK's destroy
function is not trusted to validate stop itself. The temporary supervisor task
allocation occurs after request timing/low-water measurement and may still
affect an immediate group-end heap snapshot until idle-task reclamation.
The stop helper runs below the waiting main task's priority. Its task timeout
does not contain SDK code that masks interrupts or prevents scheduler progress;
the ten-second wait is a supervised task deadline, not a hardware watchdog.

Real passive BLE scan defaults to 100 ms interval / 20 ms window. Set
`bleWindowMs=50` only for a separate 100/50 experiment. A 64-report static RAM
queue feeds the shared `cp_collect` worker, with RAM summaries discarded every
ten seconds. No UI, journal, storage or production cloud transport runs. BLE
callbacks do not allocate, block, hash or upload; logs expose counts, overflow,
queue losses and reset/error status only. Scan stop retains the initialized
SDK radio runtime; no full controller teardown is attempted. BLE/device
acceptance is not established by compilation.

Build using uv and the existing SDK environment, setting `IDF_PATH`,
`IDF_PYTHON_ENV_PATH` and its supported RISC-V toolchain in `PATH` first:

```sh
uv run --no-project --python /absolute/esp-idf-python/bin/python \
  "$IDF_PATH/tools/idf.py" -C firmware/diagnostics/transport-compare \
  -DCP_COMPARE_CONFIG_FILE=/absolute/private/compare.json build
```

Never pass secrets as `-D` values. Only the external configuration path enters
CMake's cache. The generated secret header is restricted to the ignored,
mode-0700 `build/` tree. Keep all build outputs private. Do not flash from this
README: the supervising hardware procedure must first verify the connected
board, backup and partition table. This project retains the 3 MB application
partition and `cardid` at 0x356000 and emits separate bootloader, partition and
application images. Never erase the entire Flash or write a padded merged image.

Timing uses monotonic microseconds. HTTP `elapsed_us` includes connect when
needed, request, body receipt, complete-data check and JSON verification;
MQTT message elapsed includes the selected API, both ACK waits and receipt verification.
MQTT event `puback_us` and `receipt_us` exclude consumer polling delay;
`COMPARE_MQTT_FRESH_TOTAL` sums measured connect/SUBACK and message intervals,
excluding serial logging between them. Fresh HTTPS starts after SDK client
initialization; MQTT connect includes native task initialization/start. Report
these small lifecycle differences alongside the numbers. JSON/hash work and
per-message logging also perturb this diagnostic.

Heap bytes: `free_start`, operation-scoped `free_min`, `free_end`, and largest
free block before/after. `heap_caps_get_minimum_free_size(INTERNAL|8BIT)` sums
independent low-water marks of matching heaps. Their minima may occur at
different instants, so `free_min` is not necessarily a simultaneously observed
total free heap; subtracting it from `free_start` is not a measured peak of
transport-owned allocations. Group `boot_min` uses the analogous SDK since-boot
per-heap minima and is distinct from the operation-local sums. Compare group baselines before allocating a
transport, active connection baselines and after teardown to capture retained
task/TLS/outbox overhead. BLE and Wi-Fi allocate concurrently, so neither these
low-water-derived differences nor a BLE-on/off difference alone attributes
allocation ownership to the SDK transport.

Every group logs the actual Wi-Fi PS enum. Default `wifiPs=0` explicitly uses
`WIFI_PS_NONE` for both protocols. `wifiPs=1` selects `WIFI_PS_MIN_MODEM` for a
separate matched experiment. Production's actual power setting must be reported
before comparing with this diagnostic. The default budget is 300 seconds,
including a 20-second teardown allowance, with capped counts and per-operation
timeouts. Budget exhaustion and unsuccessful receipts remain failures, not
successful latency samples.

Validation commands:

```sh
IDF_PATH=/absolute/esp-idf-v5.5.3 sh firmware/diagnostics/transport-compare/tools/test-wire.sh
CP_COMPARE_DEPS=/private/tmp/cp-transport-deps node --test relay/transport-compare/server.test.mjs
node relay/transport-compare/analyze.mjs /absolute/private/serial.log
```

The extractor separates fresh and verified warm samples and excludes HTTP
priming; inspect raw numeric diagnostics for allocation/setup failures as well.
It reports payload goodput in bytes/second, latency in milliseconds, and heap
in bytes. The extractor names the derived metrics
`minimum_sum_per_heap_low_water_bytes` and
`maximum_start_minus_sum_per_heap_low_water_bytes` to retain this distinction.
MQTT fresh heap is in `COMPARE_MQTT_CONNECT` and `COMPARE_MQTT_MSG`,
not the summed timing row. A small sample set is exploratory, not a distribution
guarantee. Reverse protocol order or repeat after a fresh boot to investigate
ordering/fragmentation drift before drawing conclusions.

Local provenance: `saved_wifi.c`, `probe_wire.*` and wire sanitizer tests are
adapted from this repository's `cf-longlink` diagnostic. `ble_load.*` is adapted
from `https-lan`; the scan window is now external-configurable. HTTPS control
flow is adapted from `cf-longlink`; Worker-specific socket assumptions were
replaced with this LAN server's socket correlation. No neighboring private
repository was imported for this experiment. Aedes 1.2.0 is an external MIT
dependency installed in a temporary directory, not vendored here.

These LAN measurements isolate relative protocol/SDK overhead. They do not
measure the Cloudflare route, broker relay geography, production UI/Flash
contention, monetary charges, network loss recovery, radio completeness, or
whole-system production capacity.

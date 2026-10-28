# Isolated ESP32-C3 LAN HTTPS diagnostic

This ESP-IDF **5.5.3** project reads the already saved CampusPulse Wi-Fi settings
and sends only synthetic data to an explicitly configured local HTTPS server.
By default it does not start BLE or collection. An optional mode adds real
passive BLE scanning and the shared pure RAM aggregation workload, described
below. Both modes omit display, enrollment, journal, cloud control and
production upload code. They never call a settings save, proof creation, flash
erase or production journal operation. Wi-Fi storage is RAM; PHY calibration persistence is
disabled to avoid its independent NVS write path. The diagnostic initializes NVS
through `nvs_flash_init_partition_ptr` using a static copy of the actual `nvs`
partition descriptor with `readonly=true`; it does not call ordinary settings
or NVS initialization. Pinned IDF checks this descriptor before partition writes
or erases, including recovery during initialization. Any initialization or
settings-load failure aborts without writable retry, formatting or erasure.
Existing saved personal, open
or PEAP credentials are supported without printing them. PEAP retains the
existing selected RADIUS policy; HTTPS independently enforces CA, IP SAN and
certificate validity dates. Wi-Fi modem power save is disabled for this isolated
performance baseline.

Build from this directory with the installed ESP-IDF environment and these
external CMake values:

```sh
uv run --no-project --python "$IDF_PYTHON_ENV_PATH/bin/python" \
  "$IDF_PATH/tools/idf.py" -DIDF_TARGET=esp32c3 \
  -DCP_LAN_URL=https://LAN_IPV4:PORT \
  -DCP_LAN_CA_FILE=/absolute/path/to/public-ca.pem \
  -DCP_LAN_BAD_CA_FILE=/absolute/path/to/unrelated-public-ca.pem \
  -DCP_LAN_UNIX_TIME=CURRENT_UNIX_SECONDS build
```

Replace the placeholders. The origin must contain an IPv4 address and explicit
port, without a trailing slash. Its certificate must include that IP SAN.
The public certificates and values are placed in the ignored build directory;
no private key is needed. Time is set from the externally supplied current Unix
time and then advances normally. There is no network time service. Rebuild when
the supplied time becomes stale. The negative-test CA is optional; supplying it
requires a certificate-verification failure with no HTTP headers sent and no
successful connection event before synthetic POSTs are allowed, after positive
HTTPS health succeeds with the intended CA. Evidence must be either the
`NOT_TRUSTED` verification flag or exactly
`MBEDTLS_ERR_X509_CERT_VERIFY_FAILED` (either error-code sign). Pinned ESP-TLS
records the negated mbedTLS handshake error; verification flags may remain zero
if its separate peer-certificate check is unavailable. Generic connection/TLS
errors and timeouts do not pass this gate. The raw numeric stack code and flags
are logged separately, including zero flags, without inventing a trust flag.

The default project only links the existing `cp_settings` application component. It
also reuses the fingerprint-gated ESP-IDF async transport retry/error repair
from `cp_network/cmake`, generating the repaired SDK translation unit inside
the build directory without changing the installed SDK or linking the
production network task. CA/name/date verification is unchanged by that repair.

**Flash only the built app at `0x10000` after backing up and verifying the actual
device.** The copied partition CSV matches the Passport baseline exactly:
3 MiB factory app, protected `cardid` at `0x356000`, original NVS and queue.
This layout is specific to the verified AI Passport. Do not run an erase or
flash a merged image. Building this diagnostic does not validate any board.

The server must implement HTTP/1.1 keep-alive and TLS 1.2:

- `GET /health` returns HTTP 200 with
  `{"ok":true,"benchmark":"lan-https","tls":"TLSv1.2"}`.
- `POST /benchmark` accepts a bounded body and returns HTTP 200 with
  `{"ok":true,"received":N,"sha256":"lowercase exact-body SHA256"}`.

The firmware first self-checks rejection of wrong length, hash, HTTP status and
oversized responses, then makes five separate TCP-only probes and validates
HTTPS health. With the unrelated CA supplied it next verifies trust rejection.
It runs ten requests for each combination of 1 KiB/8 KiB payload and new/reused
HTTP handle. Each reuse group is primed by a validated health GET and ends with
another health GET. Failed handles are discarded and health is checked before
the next reuse attempt. Body fields are cleared before every method/size change.
The reused groups have separate handles; an 8 KiB group does not inherit the
1 KiB group's connection. Actual connection events identify any reconnection.

The current I/O baseline matches the production HTTP client: 12-second initial
connect timeout, 1-second connected I/O timeout, 20 ms delay between asynchronous
retry calls, and 1024-byte receive/transmit HTTP buffers. The connection callback
changes the timeout to 1 second immediately, including within the first perform
call; successful reuse keeps that connected timeout without requiring a new
connection event. Each outer loop iteration also caps its timeout by the
remaining application budget.

The earlier hardware trial used an aggressive diagnostic mode with 25 ms I/O
polls, 1 ms retry delay and 512-byte HTTP buffers. It recorded 20/20 successful
1 KiB benchmark POSTs, 7/10 successful new-connection 8 KiB POSTs and 4/10
successful reuse-group 8 KiB POSTs. Failures included six HTTP write errors,
one 12-second POST timeout and two failed 12-second reuse health checks. Those
results remain evidence from that earlier mode and do not establish how the
matched baseline performs. A bounded local TLS health success does not remove
those larger-payload failures. No SDK write behavior or verification policy is
changed for the matched-baseline trial.

Each asynchronous request has a 12-second application deadline, checked between
I/O polls and SDK steps; a step finishing after that deadline fails
validation. This is a cooperative deadline, not a hard preemption limit:
the pinned SDK may process multiple body reads inside one perform call. A server
that continuously streams an oversized response could exceed 12 seconds before
control returns. The paired local server returns bounded fixed-length responses;
cryptographic work and scheduling can also cause overshoot. Redirects and
authentication retries are disabled, and stored response contents are
bounded to 511 content bytes. HTTP 200, complete framing, JSON acknowledgement,
exact length and hash must all pass. Failed or oversized responses close the
connection. At completion or any fatal setup failure the app idles; it does not
restart automatically.

`LAN_REQ` records contain no network identity, credentials, body or hash:

- `connect_us` measures request start to `HTTP_EVENT_ON_CONNECTED`, including
  TCP plus verified TLS; `-1` means no new connection event. The separate TCP
  probes do not make subtraction an exact measurement of TLS cost.
- `headers_us`, `first_body_us` and `total_us` are elapsed from request start.
- `free_min` uses IDF's local per-request heap monitor. It sums individual heap
  minima, which may occur at different instants. All memory fields select
  internal 8-bit-capable RAM. `largest_sampled_min` is sampled approximately
  every 2 ms plus HTTP callbacks and perform-loop returns; it is not an exact
  allocation-time minimum. Sampling adds some measurement overhead.
- `LAN_SUMMARY` reports valid requests, failures, measured connection events,
  successful requests with no connection event and successful-sample p50/p95
  times. Health and negative trust requests are separate records and excluded
  from these totals. Small sample sizes are diagnostic evidence only.

## Optional real BLE coexistence load

Use a fresh SDK config and build directory when switching modes. Add these
arguments to the build command above for twenty POSTs per mode/payload and a
two-second minimum start-to-start cadence:

```sh
-B build-ble-load -DSDKCONFIG=build-ble-load/sdkconfig \
  -DCP_LAN_BLE_LOAD=ON -DCP_LAN_SAMPLES=20 -DCP_LAN_PERIOD_MS=2000
```

`CP_LAN_SAMPLES` accepts 1..40 (default 10); `CP_LAN_PERIOD_MS` accepts
0..60000 (default 0, the original 30 ms inter-request delay). With a nonzero
period, starts are spaced relative to the previous actual POST start. Requests
that exceed the period do not trigger catch-up bursts. Priming and final health
GETs remain separate, and health recovery can extend the interval.
`CP_LAN_BLE_LOAD=ON` automatically combines `sdkconfig.defaults` and
`sdkconfig.ble-load`; the effective Kconfig mode must agree with the CMake flag.
For the original mode, use a separate fresh directory/config with
`-DCP_LAN_BLE_LOAD=OFF`.

The optional mode links `cp_collect` (which requires `cp_vehicle`) and NimBLE,
without linking the production pipeline. It passively scans real advertisements
at 100 ms interval / 50 ms window with duplicate filtering disabled. The callback
only timestamps and copies at most 31 advertisement bytes plus the address and
radio fields into a nonblocking 64-report queue. A worker calls the shared
`cp_collect_begin` / `cp_collect_observe` code with ten-second windows,
one-second bins, at most 64 addresses and raw retention disabled. The shared
vehicle AD parser therefore runs as normal aggregation CPU load. Advertisement
payloads, names, addresses, hashes and per-address summaries never appear in
logs, uploads, ACKs or Flash; all observations stay in RAM. Windows and the
worker's temporary report are cleared. Vacated queue backing storage is wiped on
empty-queue worker ticks, and again after ingress is sealed and the worker
acknowledges completion. Active queued reports remain until processed. No public identity,
advertising or pairing service is started. NimBLE NVS persistence, controller
Flash logs and PHY calibration persistence are disabled.

There is at least five seconds of scan/aggregation warmup before TCP or TLS
probes. BLE remains enabled during every HTTPS request, reconnect and idle
keep-alive interval. The TLS parameters and positive/negative verification gates
remain unchanged. `LAN_BLE` records report only counts: received, enqueued,
processed, queue drops, aggregation rejects, address-table overflow reports,
closed windows, lifetime queue high-water mark, active scan flag, scan errors
and resets. Request and phase records are counter deltas; the high-water mark
and active flag are current absolute values. Final totals reconcile only after
the queue has drained: received = enqueued + queue drops, and enqueued =
processed. Aggregation rejects and address overflow are distinct; an overflowing
new address can still contribute to the overall window. `windows` includes the
final partial window. Snapshot boundaries can straddle ingress/worker work, so
per-request processed counts need not equal enqueued counts.

Terminal shutdown seals ingress, requests scan cancellation in a helper with a
five-second external completion wait, confirms discovery is inactive, then
drains and clears the worker with a three-second completion wait. Application
queue and collector buffers are wiped after the worker acknowledges completion.
The NimBLE host task, controller and SDK allocations remain alive and idle:
`nimble_port_stop` and `nimble_port_deinit` are deliberately skipped. SDK-internal
vacated buffers are not claimed to be zeroed. `LAN_STOP` and `LAN_DONE` explicitly
report `runtime_retained=1 full_deinit=0`; completion means scanner/collection stopped and
application observations cleared, without claiming full SDK lifecycle acceptance.
No live task is forcibly deleted. Cancellation or worker failure prints
`LAN_STOP_FAILED`, retains uncertain SDK ownership and idles without claiming
`LAN_DONE` or rebooting. A successful cancellation must return 0 or EALREADY and
also report discovery inactive. A sync already in progress must finish before
the helper cancels, while subsequent sync callbacks cannot restart discovery.

`LAN_BOOT` includes numeric `reset_reason`. `LAN_STOP_STAGE` records identify:
1 before sealing ingress; 2 ingress sealed; 3 cancellation helper entered;
4 before scan-disable command; 5 command returned (numeric result); 6 SDK host
stop/deinit skipped; 7 before worker wait; 8 worker completion acknowledged;
9 application buffers cleared. Stage records are flushed before proceeding.
The first real-BLE hardware run completed all 80 POSTs but reset during the old
full teardown path before a terminal record. Its exact reset site/reason was
not captured. The approximately 357 ms interval is consistent with the configured
300 ms interrupt watchdog, but does not prove that cause. Lower-priority task
supervision cannot contain an SDK operation that masks interrupts; this temporary
diagnostic now avoids that unproven teardown path entirely.

This workload exercises real BLE plus the shared pure aggregation while sending
synthetic LAN uploads. The UI and production Flash journal/upload protocol are
absent; it is not full production acceptance or calibrated field accuracy.

SDK application logs are suppressed before Wi-Fi starts to avoid network
identity leakage; the structured diagnostic output remains available on native
USB serial/JTAG. Bootloader output may still precede the application records.

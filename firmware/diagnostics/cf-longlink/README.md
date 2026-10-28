# Temporary Cloudflare HTTPS / WSS diagnostic

Independent ESP-IDF **5.5.3 / ESP32-C3** synthetic transport experiment. The
frontend, production ingestion endpoint, BLE scanner, UI, journal and upload
queues are absent. A valid receipt establishes exact transport delivery to the
diagnostic Worker; it does not establish durable production storage.

The saved-network bootstrap is copied from `../mqtt-relay/main/saved_wifi.c`
and uses the production `cp_settings` reader. It copies the NVS descriptor into
static storage, sets `readonly`, and aborts any initialization/load error.
The installed IDF rejects writes/recovery through this descriptor. Wi-Fi uses
RAM configuration; PHY NVS calibration storage is disabled. Existing saved PEAP
policy is preserved independently of strict public HTTPS/WSS TLS verification.
No ordinary NVS, card ID or journal modification is part of this diagnostic.

## Configuration and build

Place a **0600 JSON file outside the repository**. Never pass a bearer token as
an argument, CMake definition or UART command. Example schema (use your current
UNIX epoch and an actual public diagnostic hostname):

```json
{
  "httpsOrigin": "https://probe.example.com",
  "token": "REPLACE_WITH_DEDICATED_SYNTHETIC_TOKEN",
  "epoch": 1793145600,
  "freshSamples": 6,
  "reuseSamples": 12,
  "wsSamples": 12,
  "reconnectSamples": 4,
  "budgetSeconds": 540
}
```

Counts are bounded: fresh1..6, reused1..12, WSS1..12 and reconnect1..4 per the
indicated phases. Budget is300..600seconds including a20second teardown reserve.
The origin must be HTTPS with a DNS name, no credentials, path, query or custom
port. The private header is generated only beneath this project's ignored
`build/`, with mode0600; the build root is0700. App images, ELF/debug files and
all build output contain the token and remain private. Remove them after use.

Set the installed5.5.3 environment, including the actual RISC-V compiler path:

```sh
cd firmware/diagnostics/cf-longlink
export IDF_PATH=/path/to/esp-idf-v5.5.3
export IDF_PYTHON_ENV_PATH=/path/to/idf5.5_python_env
export PATH=/path/to/riscv32-esp-elf/bin:$PATH
export UV_CACHE_DIR=/private/tmp/cp-link-uv-cache
uv run --no-project --python "$IDF_PYTHON_ENV_PATH/bin/python" \
  "$IDF_PATH/tools/idf.py" -B build \
  -DCP_LINK_CONFIG_FILE=/absolute/external/probe-private.json build
```

Run from this project directory so relative `-B build` cannot target another
project's build tree. The managed dependency is pinned to Espressif WebSocket
client1.6.1, with its component hash in `dependencies.lock`. CMake reuses the
existing fingerprint-gated build-local async TLS error/read-retry repair from
`../../components/cp_network/cmake/transport_async_errors.cmake`; it does not
modify the SDK or link the production runtime. See the pinned
[Espressif component](https://components.espressif.com/components/espressif/esp_websocket_client/versions/1.6.1).

TLS verifies the root bundle, hostname and certificate dates. No insecure
fallback exists. A configuration epoch within one day of generation initializes
the clock; a bounded10second SNTP attempt follows, and the resulting clock must
remain within the configured epoch-300seconds .. epoch+86400seconds. SNTP is
not authenticated: this is an operator-supplied diagnostic date anchor, not a
production trusted-time solution. Its source/result is logged.

## Wire behavior and measurements

Each exact1024/8192byte binary payload contains a random16byte run ID, a4byte
big-endian sequence, then `byte[i]=(i*31+seq*17)&255` for offset20 onward.
One run ID and increasing sequence span all phases. HTTPS sends authenticated
`POST /benchmark`; WSS uses `/ws` with the same Authorization bearer header.

Every success requires a bounded flat JSON object with exactly these fields:

```json
{"protocol":"cp-link-probe/1","kind":"transport_received","run_id":"32 lowercase hex digits","seq":1,"bytes":1024,"sha256":"64 lowercase hex digits","connection_id":"10000000-0000-4000-8000-000000000001","colo":"HKG"}
```

Length, full SHA-256, run and sequence must match; malformed, nested, duplicate,
unexpected or trailing JSON is rejected. WSS text events are assembled across
SDK chunks and continuation frames with a767byte cap and queue-loss reporting.
Local send success is never counted as receipt success.

For each size, HTTP runs6fresh handles and12requests on a reused handle by
default, using12second initial connection/total request cap,1second connected
I/O,20ms async retry,1024byte RX/TX buffers and no redirects. Reuse is verified
through retained SDK open state and zero new `ON_CONNECTED` events. HTTP receipt
IDs are request-scoped and do not identify the underlying Cloudflare TCP socket.
Failures explicitly close the handle; replacement connections appear in logs.

WSS disables automatic reconnect. It sends12messages of each size over one
connection, waits45seconds with10second protocol ping/pong heartbeats, verifies
one post-idle payload, sends literal authenticated text `close-for-test`, requires
clean close1000, then explicitly creates one new client and sends4alternating
sizes. WSS receipt connection IDs must remain stable within a connection and
differ after reconnect. Each message has a12second overall cap; explicit
1024byte frames use at most1second timeout per call, further reduced to one
eighth of remaining time for nested lock, poll and header/payload write waits. The final continuation FIN
is also bounded. Separate TX locking is enabled.

The SDK's receive/ping/close/initial-handshake network timeout remains12seconds;
there is no public post-connect timeout setter. WSS control/receive timing is
therefore different from HTTP's1second connected I/O. Queue receipt waits and
message validity still enforce the12second successful-receipt threshold.
The SDK's error cleanup can wait for its receive lock, so12seconds is not a hard
execution bound under a failing transport; actual elapsed time is always logged.
A20second reserve is
kept for client teardown. Logs report connect/reconnect and receipt elapsed
times, failure stage, HTTP status, TLS numeric errors, connection counters,
heap low watermarks and largest blocks. Timeouts are failed/censored samples,
not measured successful RTTs. `CF_DONE complete=1` requires all65default
payload receipts and no failed phase. The run ends without reboot/retry.

## Local checks and hardware boundary

```sh
node --test tools/configure.test.mjs
sh tools/test-wire.sh
```

The host wire test compiles the actual portable C module with IDF cJSON under
ASan/UBSan, checking exact framing, run/sequence/length/hash rejection,
duplicate/trailing JSON, fragmented/chunked receipt assembly and overflow.
The Node checks validate config schema, bounded counts, strict origins,
permissions and output confinement. A passing C3 build is compile validation.

The included table reserves the Passport's3MiB app at0x10000 and protected
`cardid` at0x356000, plus the unchanged ordinary NVS and journal layout.
Deliver separate bootloader/table/app images. This project deliberately has no
flash automation: the main operator must identify the actual board, verify its
8MiB backup/digest and layout, write **only** the temporary application, then
restore the original app and verify protected bytes and restored boot. Never
use `idf.py flash`, erase-all or a padded merged image for this experiment.

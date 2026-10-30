# Optional isolated v3 HTTPS transport

This component supplies a single-task Wi-Fi/TLS/time owner for an explicitly
configured private v3 experiment. It does not start automatically. It does not
depend on `cp_network`, MQTT, a TF card, a display, the v2 control service or a
board adapter. It can serve a T-Energy/no-TF test with the same interface.
It is transport plumbing, not a policy validator, collector, durable queue or
receipt verifier. A completed HTTP 200 is not custody or permission to reclaim.

## Ownership and bootstrap

Stop all other Wi-Fi owners before `cp_v3_transport_start`. One application task
must call start, request, time, optional clock sync and stop. Another task may
only call cancel, which asks the owner to leave its bounded I/O loop. Start
rejects an already initialized Wi-Fi driver; it never takes over that driver.
There is one Wi-Fi association attempt, no background reconnect or upload loop.
Cleanup retains ownership on a driver cleanup failure so the same task can retry
stop; callers must not assume successful handoff until stop returns `ESP_OK`.

Initialize NVS without erasure before start. Pass a validated existing
`cp_settings_t` for Wi-Fi credentials and enabled-node bearer token. The saved
settings' fixed production origin is not the destination: `config.origin` is a
mandatory, explicit `https://host[:port]` origin. Paths, userinfo, query, fragments,
control characters and production `pulse.anend.net` (on any port) are rejected.
Do not print the bootstrap payload, settings, request headers, token or CA input.
PEAP requires a caller-supplied RADIUS CA and expected certificate domain, with
certificate date validation enabled. There is no unverified-PEAP mode.

The caller supplies a trusted per-boot `clock_seed`, for example from physical
USB plus host UTC, including the corresponding board monotonic milliseconds,
nonzero clock epoch and an honest uncertainty bound. The component never uses
unauthenticated SNTP as proof for TLS validation. It applies the trusted anchor
to system time before Wi-Fi/TLS. An anchor expires when uncertainty exceeds
5,000ms; time grows by monotonic elapsed milliseconds and uncertainty grows at
a conservative 500ppm, rounded upward. Retain clock epoch within the boot.

`server_ca_pem=NULL` uses the ESP CA bundle; set
`CONFIG_MBEDTLS_CERTIFICATE_BUNDLE=y` in the consuming application. Otherwise
provide an explicit NUL-terminated PEM CA for the isolated server. CA pointers
must remain valid through stop. TLS always checks CA, original server hostname
(also used for SNI) and certificate dates. There is no plaintext or verification
bypass option. The component emits no logs and disables verbose SDK TLS/radio
logs. It does not restore SDK log levels because doing so could expose a later
request's secrets through a different component.

Both trust modes require `CONFIG_MBEDTLS_HAVE_TIME=y` and
`CONFIG_MBEDTLS_HAVE_TIME_DATE=y`. The component refuses to compile without
certificate-date checking, which ESP-IDF otherwise disables by default. A
bundle-disabled build accepts explicit PEM only and rejects NULL CA at start.

## Bounded requests and clock boundaries

Allowed routes are POST capabilities, configuration ACK and ingest under
`/api/v3`, plus GET config with exactly one lowercase UUIDv4 `boot_id`. No v1/v2
or administrator route is accepted. Request bodies are capped at 65,536 bytes;
the caller freezes exact bytes and retries them itself. POST computes SHA-256
over those exact bytes and sends `X-Body-SHA256`. The SHA function is also a
`cp_v3_sha256_fn` adapter for the evidence producer.

DNS is asynchronous IPv4 with a generation guard against callbacks from an old
attempt. TLS connects to that resolved address while verifying and sending SNI
for the configured hostname. DNS/TCP/TLS/read/write polling shares one absolute
1–30s deadline. Each attempt creates and closes its own connection. HTTP is
parsed incrementally with ESP-IDF's `http_parser`, including Content-Length,
chunked and close-delimited bodies. There is no dynamic response allocation:
caller buffers are capped at 32,769 bytes including NUL. Header names are at most
63 bytes, values 511 bytes, and total name/value bytes 8,192. Oversize, truncated,
compressed, upgraded, malformed and concatenated responses fail. Redirects are
returned to the caller as status/body and never followed. Non-2xx status is not
a transport error; the caller must examine `http_status` and strict receipt data.

Safe numeric response diagnostics retain the last stage (0 idle, 1 DNS, 2 TLS,
3 request headers, 4 request body, 5 response headers, 6 response body, 7 complete),
DNS error, final async TLS connect return, last read/write returns and aggregate
received/written byte counts. `io_error` retains a raw failing I/O return when
available or the ESP error otherwise. TLS stack/certificate errors also remain
available. Failed-response cleanup clears partial body/clock acceptance while
preserving these diagnostics. No header, body, address or credential is included.
Pinned ESP-IDF5.5.3 maps TLS `close_notify` to read-return zero; zero before a
complete HTTP message is an invalid response, never proof of a committed ACK.

A complete 2xx HTTPS response may supply one strictly parsed IMF-fixdate Date
header. A duplicate or invalid Date yields unknown time. Its candidate anchor
includes half the whole request duration, 500ms quantization and the configured
server-clock error allowance. The latter is a declared assumption about server
clock accuracy, not something TLS proves. Candidates exceeding 5,000ms
uncertainty are unknown. Requests do not change the active evidence clock.
Only an explicit `cp_v3_transport_sync_clock()` at a closed collection boundary
applies the latest candidate and increments epoch, preventing silent clock
changes inside an open window. This time update is not a lease renewal.

## Validation and remaining acceptance

Run the real pinned IDF HTTP parser plus protocol bounds under ASan/UBSan:

```sh
IDF_PATH=/path/to/esp-idf-v5.5.3 uv run firmware/components/cp_v3_transport/tests/test_protocol.py
```

The implementation uses ESP-IDF5.5.3's ESP-TLS API and its bundled MIT-licensed
Joyent HTTP parser as dependencies, without copying those source files.
An isolated compile/link check is separate from a real device/server result.
The bounded [Waveshare trial](../../../docs/notes/waveshare-v3-acceptance-2026-10-30.md)
now verifies association, public-CA HTTPS, direct v3 control/ingestion and one
real response timeout/retry. Physical certificate rejection, Wi-Fi interruption,
sustained throughput and absolute clock accuracy remain open. No transport
test establishes durable receipt matching, queue recovery or radio completeness.

API references: [ESP-TLS5.5.3](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32s3/api-reference/protocols/esp_tls.html),
[Wi-Fi5.5.3](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32s3/api-reference/network/esp_wifi.html).

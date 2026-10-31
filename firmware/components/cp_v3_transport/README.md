# Independent V3 native MQTT/TLS transport

`CP_V3_NATIVE_MQTT` defaults off. Only the two standalone V3 applications opt in
explicitly. Off builds compile `mqtt_disabled.c`, expose no MQTT SDK calls or
global IO wrappers, and reject native mode before Wi-Fi starts. The inert SDK
dependency declarations remain for ESP-IDF's pre-Kconfig requirements scan;
they do not instantiate an owner. The obsolete V1/V2 network component and its
build owner were removed on2026-10-31. Native URI validation, memory admission
and confirmed-stop lifetime helpers now live in this component's
`mqtt_lifetime.h`; no old RPC wire codec or include path is retained.

Current production mode (2026-10-31) is `CP_V3_TRANSPORT_MQTT_TLS`, with logical
`CP_API_ORIGIN`, a current `active_boot` UUID and the existing settings' fixed
`CP_MQTT_PRODUCTION_URI` plus independent broker credentials. It uses the system
CA bundle with strict hostname/date checks. Production has no HTTPS/proxy
fallback; `CP_V3_TRANSPORT_HTTPS` is retained for isolated diagnostics only.
Native callback copying, fragment correlation and retained-stop ownership are
covered by the V3 host regressions.

The [V3 wire contract](../../../docs/specs/device-v3-mqtt.md) wraps original
requests in8 bytes: `CPV3`, version1, subop1..5, receipt-only bit0, reserved0.
Bodies are at most8192 bytes; config has no body. Topics retain
`cp/v1/<namespace>/<active_boot>/req/ingest/<rpc>` and corresponding replies.
Responses are2-byte big-endian status plus at most8192 original CF JSON bytes.
No body, hash, old-boot scope or receipt is regenerated while changing transport.
The transport RPC high-water counter is separate boot-lifetime state: reconnect
and explicit stop/start with the same active boot preserve it. A different
node/namespace/boot in the same firmware boot is rejected; uint32 exhaustion
stops admission. No connection reset clears the gateway correlation sequence.

Requests publish QoS1/nonretained, replies subscribe QoS0/nonretained. Callback
work is bounded scalar/fragment copying and signaling only. Full correlated
response + matching PUBACK + empty SDK outbox establishes transport completion,
not custody: the app must still validate the original full strict CF receipt.
Auto-reconnect is disabled and SDK retransmit timeout lies far beyond the bounded
attempt. Every failed/unknown request stops the client before another application
attempt; unconfirmed stop retains all reachable storage and the owner attempts
radio containment. Never reclaim from a PUBACK or partial reply.

External state/reply/frame, TLS and S3 outbox data use PSRAM. Cold/hot admission
keeps nonzero internal and PSRAM floors. Owner `begin_memory`/`end_memory` leases
serialize hot IO allocations and expose actual session phase/floors to collector
admission. Do not call MQTT/start/request/stop while holding the lease. The parent
TLS handle is read by the owner after CONNECTED, not by the event callback.
Cold/hot numeric heap phases are measured independently; no build/test sets
physical qualification flags. Callback stack watermark0 is explicitly unknown.

The trusted host/RTC anchor remains the transport clock. MQTT never supplies or
fakes an HTTP Date; ISO receipt times are checked by the existing control code.
No credentials, topics, payloads or identifiers are logged. Native MQTT resources,
continuous RF/coexistence, reconnect and power-loss still require device acceptance.

## Historical HTTPS implementation and isolated diagnostics

The following earlier HTTPS notes describe the retained diagnostic plumbing.
Any earlier production-HTTPS statement is superseded by the native mode above.

# Optional v3 HTTPS transport

This component supplies a single-task Wi-Fi/TLS/time owner for an explicitly
configured v3 destination. It does not start automatically. It does not
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
and control characters are rejected. Following the user's explicit release and
two-board integration authorization, production accepts only canonical
`CP_API_ORIGIN` (`https://pulse.anend.net`, implicit443). Explicit`:443`, other
ports, trailing spellings and production subdomains are rejected. This adds no
automatic startup, enrollment, policy or collection permission. Historical
isolated acceptance records remain limited to their original test environment.
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
Production always requires `server_ca_pem=NULL` and the system certificate
bundle; even an empty custom-CA pointer is rejected before Wi-Fi starts.

Both trust modes require `CONFIG_MBEDTLS_HAVE_TIME=y` and
`CONFIG_MBEDTLS_HAVE_TIME_DATE=y`. The component refuses to compile without
certificate-date checking, which ESP-IDF otherwise disables by default. A
bundle-disabled build accepts explicit PEM for isolated servers only, rejects
NULL CA at start and cannot connect to production.

`flush_dns_on_network_failure` defaults to false. An application that owns all
outbound network clients may explicitly enable it for canonical`CP_API_ORIGIN`.
After its own DNS resolution has completed, a failed TLS/HTTP transport attempt
with no received HTTP status and no certificate-verification flags can request
one whole SDK DNS cache flush, after TLS cleanup and on the TCP/IP task through
`esp_netif_tcpip_exec`. Both the caller's owner/cancel state and the callback's
remembered owner/cancel state are checked. No flush occurs for cancellation,
successful requests, any parsed HTTP status (including401/403/409 with a broken
body), failed DNS resolution, an isolated origin or verification flags.

This is **a whole-cache operation**, not a targeted or completed-entry-only
operation. In the pinned SDK, `dns_clear_cache()` can cancel other pending DNS
queries as well as removing completed cache entries. Do not enable this option
for an application sharing networking with other HTTP/MQTT/SNTP/DNS clients.
It does not change DHCP DNS servers, insert a fixed address or change TLS/SNI.
The next exact request resolves the same hostname using the existing DNS setup;
the DNS server may return the same address again. `whole_flush_attempted` means
TCP/IP execution was requested; `whole_flush_succeeded` requires that the
callback actually executed the flush successfully. A cancelled/failed dispatch
never reports success; `whole_flush_error` retains its numeric dispatch/callback
result. Neither flag proves that a later retry will work. Local allocation,
SHA, certificate parser/configuration and HTTP parser failures are excluded;
flags0 alone does not classify an arbitrary failure as a network failure.

`parsed_http_status` is independent of `http_status`/`complete`: a parsed status
is retained through header/body errors for retry classification, while an
incomplete response cannot become a valid receipt or trusted clock sample.

## Bounded requests and clock boundaries

Allowed routes are POST capabilities, configuration ACK, explicit lease and
legacy/statistics ingest under `/api/v3`, plus GET config with exactly one
lowercase UUIDv4 `boot_id`. No v1/v2
or administrator route is accepted. Request bodies are capped at 65,536 bytes;
the caller freezes exact bytes and retries them itself. POST computes SHA-256
over those exact bytes and sends `X-Body-SHA256`. The SHA function is also a
`cp_v3_sha256_fn` adapter for the evidence producer.

Historical control recovery uses `cp_v3_transport_request_receipt_only` with
the same arguments. It accepts only exact POST configuration-ACK/lease paths
and adds `X-Receipt-Only: 1`; the frozen body and hash remain unchanged. All
other paths/methods fail before DNS. A missing original committed receipt must
remain a server conflict, not create a new ACK or lease. Normal requests retain
their original behavior, and neither API itself grants collection authority.

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

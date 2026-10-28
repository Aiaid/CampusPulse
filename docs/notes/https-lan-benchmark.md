# Controlled LAN HTTPS benchmark

Status: the controlled physical run, original-application restoration, complete
Flash equality and original-version boot checks passed on one connected
Passport. This is an isolated synthetic experiment, not production capture or
field throughput acceptance.

On 2026-10-26 the user authorized a local HTTPS server, locally signed TLS trust
material embedded in a temporary ESP32-C3 diagnostic application, and flashing
the connected Passport to distinguish device TLS performance from public-network
latency. The existing Cloudflare services are not changed by this experiment.

## Controlled setup

- ESP-IDF 5.5.3, verified Passport/C3 with 8 MiB Flash and 3 MiB application.
- Local TLS 1.2 server with HTTP/1.1 keepalive and TCP_NODELAY enabled. The server
  accepts only synthetic benchmark requests, never production credentials or
  ingestion acknowledgments.
- A short-lived private test CA signs the server certificate, including the
  local server IP SAN. Only public trust certificates enter the diagnostic
  application; private keys, addresses, build inputs and Flash backups stay in
  ignored local captures.
- CA, IP SAN and certificate date validation remain enabled. The supplied
  build-time clock is a controlled test input; this does not validate production
  SNTP, trusted clock anchors or offline authorization.
- The standalone application reads saved Wi-Fi settings through a read-only NVS
  partition descriptor. Wi-Fi storage is RAM and PHY calibration persistence is
  disabled. It does not start BLE, LCD, enrollment, production control, journal
  reclamation or collection.

The [diagnostic project](../../firmware/diagnostics/https-lan/README.md) documents
the build inputs and metric definitions. The local server is
[`https-lan-server.py`](../../firmware/tools/https-lan-server.py).

## Measurements and safeguards

The client first measures five TCP connections, validates the real local CA,
and requires a failed wrong-CA connection with a trust flag or the exact X.509
certificate-verification failure code, with no connection-success or HTTP-header
events. It then measures ten requests in each of four groups:
new connection / reused connection, each with 1 KiB / 8 KiB synthetic bodies.
Success requires HTTP 200, a complete response, exact received length and exact
SHA256. Connection events establish whether a handle actually reused TLS.

Client metrics distinguish combined TCP/TLS connection completion, headers sent,
first response body and complete request time. These are not separate exact TCP
and TLS handshake timings. Free internal heap minima and sampled largest block
are reported separately. The 12-second limit is cooperative; a continuously
streaming unexpected response can keep one SDK call running beyond that limit.
The paired server returns a fixed bounded JSON response.

Server handshake timings have a separate host clock. Its request duration starts
before waiting for a request line and can include keepalive idle time, so it must
not be treated as pure application processing latency.

The experiment requires a newly verified complete Flash backup before any write,
application-only writes at `0x10000`, protection of NVS/cardid/queued records,
non-application byte verification, and restoration of the original application.
No whole-chip erase, padded merged image or queue format is permitted.

## Interpretation limits

This is a low-load baseline: no BLE/display/journal tasks, modem power save off,
and a short local certificate chain. The final run matches the production
uploader's 12-second initial connection timeout, 1-second connected I/O timeout,
20 ms asynchronous retry interval and 1024-byte HTTP buffers. A passing LAN
experiment can establish basic
TLS/upload performance on this board; it cannot establish production coexistence,
radio completeness, public-network quality or sustained ingestion capacity.

The earlier Mac public-network comparison separately found 4/14 successful
Wi-Fi direct requests to two Cloudflare IPv4 addresses (3.93–8.70 seconds), with
10 hitting a 12-second limit; the Stash path succeeded 7/7 (0.69–0.90 seconds).
Eight direct failures occurred before TCP connected. These are local-network and
time-specific observations, not a general mainland availability guarantee.

## Physical results

The final matched-I/O run completed all 40 synthetic uploads, with exact length
and SHA256 verification, no upload errors, no 12-second timeout and no crash.
Each group has ten measurements; P50/P95 use nearest-rank sample quantiles.

| Payload | Connection | Success | P50 complete request | P95 complete request |
| --- | --- | ---: | ---: | ---: |
| 1 KiB | Fresh TCP/TLS | 10/10 | 1,086.621 ms | 1,229.711 ms |
| 1 KiB | Existing connection | 10/10 | 38.074 ms | 129.868 ms |
| 8 KiB | Fresh TCP/TLS | 10/10 | 1,167.990 ms | 1,351.210 ms |
| 8 KiB | Existing connection | 10/10 | 98.874 ms | 315.838 ms |

All 20 existing-connection POSTs had zero connection events; each reuse group
had a separate successful initial health/handshake outside its POST timings.
Fresh-connection combined TCP/TLS P50 was 1,062.533 ms for 1 KiB and
1,065.405 ms for 8 KiB. Five independent TCP-only connections all succeeded
(21.177–54.278 ms; P50 30.502 ms). They are separate connections and must not be
subtracted to claim an exact TLS-only time.

The SDK internal-heap minimum metric stayed at least 196,712 bytes; the sampled
largest free internal block stayed at 114,688 bytes. The heap metric sums local
per-heap minima and is a lower-bound statistic, not an exact simultaneous system
minimum. No low-memory behavior from the production workload was exercised.

The unrelated CA was rejected before connection/header events with the exact
X.509 verification code `+0x2700`; detailed verify flags were zero in the pinned
SDK failure path. Correct local CA, IP SAN and date checks passed. This is not
a test with verification disabled.

### Earlier diagnostic controls

The first run stopped at its negative-CA assertion: verification had rejected
the wrong CA, but the assertion originally demanded a detailed trust flag that
the SDK did not supply. The corrected assertion accepts only the explicit trust
flag or exact signed X.509 verification-failure code, still requiring a failed
request and no connection/header events after the successful positive control.

A second run used 25 ms I/O waiting, 1 ms retries and 512-byte HTTP buffers.
Its 1 KiB groups succeeded 20/20, but the 8 KiB groups succeeded 7/10 fresh and
4/10 reuse slots. Six writes failed, one POST connection timed out, and two
reuse warmup health requests timed out before their POST slots. The server
observed six incomplete bodies of exactly 4096 bytes. These results remain
preserved separately; they are not silently reclassified as successful uploads.

Pinned SDK source exposes two relevant short-timeout edges: TLS write polling
can return zero without `EAGAIN`, making an incomplete multi-record HTTP body
terminal; and initial async TCP `select()` timeout clears fd sets that are not
refilled on subsequent connect attempts. A 25 ms connect poll can therefore
produce an eventual outer timeout. The source paths and the controlled repeat
support the diagnostic-setting explanation, but do not instrument every failed
call or establish that production's longer waits encounter the same paths.
No production HTTP code, SDK write behavior or TLS verification was changed.

### Device restoration

The actual connected target was ESP32-C3 with 8 MiB Flash and no Flash encryption
or Secure Boot. Its complete pre-experiment Flash backup was digest-verified.
Each diagnostic write targeted only the application at `0x10000`; separate
bootloader/partition images were built and checked, not written.

After the final experiment, whole-Flash verification confirmed that every
non-application byte still matched the backup. Only the 1,064,960-byte original
application sector range replaced by the diagnostic was restored. A subsequent
whole-Flash digest check matched the original 8 MiB backup exactly, before
starting the restored application. Bootloader/table, settings, `cardid`, queues
and all remaining bytes were retained without whole-chip erase or data-region
writes.

The restored `cp-aa1b3ec36d40` version was observed at boot. USB status replied
twice with saved credentials present, increasing uptime in the same boot and
no crash marker. This confirms restored startup, not sustained cloud collection.
The local test listener was stopped. Safe numeric device/server evidence and
private backup/build material remain under the ignored
`captures/https-lan-20261026/` directory. The server host preflight and eleven
framing/privacy/TLS configuration tests also passed.

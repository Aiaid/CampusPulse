# Cloudflare public long-connection diagnostic

Status: bounded public-path device diagnostic completed, 2026-10-28.
This experiment measures a synthetic transport receipt. It does not implement
production ingestion, confirm D1/R2 durability, or release device journal data.

## Cloudflare capabilities checked

The following official documentation was checked on 2026-10-28:

| Capability | Device-facing role | Scope |
| --- | --- | --- |
| [Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/) | TLS 443 bidirectional persistent connection | Requires application authentication, framing, retry and receipt handling; not a managed MQTT broker |
| [Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) | Coordinate device sessions, commands and state | Hibernation retains sockets while an idle object leaves memory; reconnect handling remains necessary |
| [Queues](https://developers.cloudflare.com/queues/) | Buffer events and process/retry asynchronously | Queue acceptance differs from final application/database acceptance |
| [Queues HTTP publishing](https://developers.cloudflare.com/queues/examples/publish-to-a-queue-via-http/) | Publish through an HTTPS API | Does not create a persistent device connection; a cloud-management API token should stay on the backend |
| [API Shield mTLS](https://developers.cloudflare.com/api-shield/security/mtls/) | Authenticate devices using client certificates | Authentication capability, not a message broker or an alternative network route |
| [Workers connect handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/connect/) | Receive TCP forwarded over Worker service bindings | Current reference explicitly excludes direct public Internet TCP ingress |

Cloudflare [announced MQTT Pub/Sub in private beta in 2022](https://blog.cloudflare.com/announcing-pubsub-programmable-mqtt-messaging/).
Its former `/pub-sub/` documentation currently redirects to the documentation
home. Current self-service availability is unconfirmed; this is not evidence of
a particular retirement date. Queues and Pub/Sub are different products.

For this diagnostic a bounded ordinary Worker WebSocket session is sufficient.
Durable Objects and Queues are possible later architecture choices, rather than
prerequisites for testing whether connection reuse helps.

## Matched experiment

- One isolated authenticated CF Worker hostname serves all protocols. No change
  to the production Worker, bindings, device credentials or ingestion schema.
- HTTPS HTTP/1.1 with fresh connections and retained client/socket, and standard
  WebSocket over TLS. Record actual connection events rather than assuming that
  reusing a client means the socket survived.
- Identical synthetic 1,024- and 8,192-byte binary bodies contain a random run
  identifier, sequence number and deterministic payload. Both transports return
  correlated byte counts and SHA-256; successful local writes alone do not count.
- Initial connection time, verified message RTT, failures/timeouts, idle survival
  and controlled close/reconnect are separate metrics. Capture CF colo and
  connection identity. Small samples are diagnostic evidence, not a service SLA.
- Strict certificate chain, hostname and date checks remain enabled. Saved Wi-Fi
  is loaded through a read-only NVS descriptor; the diagnostic uses RAM network
  configuration and disables calibration persistence.
- Fresh full 8 MiB Flash backup and digest verification precede app-only writes
  at `0x10000`. Protect bootloader, partition table, NVS, `cardid` and queue.
  Restore original modified app sectors and verify whole-Flash equality before
  booting the restored application.

The initial device experiment excludes BLE, LCD and the production Flash
journal to isolate the public path. Historical LAN/BLE results are documented
separately in [the coexistence record](https-ble-coexistence.md). Any Mac control
must bind the physical network interface and real destination address because
`--noproxy` alone does not bypass Stash's transparent TUN.

## Evidence and limitations

The independent `campuspulse-link-probe` Worker was deployed on the previously
unused `pulse-linktest.anend.net`. Incorrect bearer tokens returned401; a correct
token returned a verified1024byte receipt. This service smoke used Stash and is
not included in direct-path performance. Python's default client identification
received a CF1010 edge response; curl and both actual ESP client identification
strings reached the Worker. No edge security setting was changed.

The physical C3 then connected over its saved Wi-Fi directly to the public
endpoint; the Mac proxy was not in that device path. All65 payload receipts
matched run ID, sequence, length and SHA-256. Every successful device receipt
reported CF colo `LAX`. Total diagnostic elapsed time was128.672seconds,
with no timeout, malformed receipt, queue loss, reset or crash marker.

| Transport | Total bytes | Verified samples | Median ms | Observed range ms |
| --- | ---: | ---: | ---: | ---: |
| HTTPS fresh | 1024 | 6/6 | 2774.750 | 2729.086–3195.809 |
| HTTPS already connected | 1024 | 11/11 | 434.622 | 419.153–465.375 |
| HTTPS fresh | 8192 | 6/6 | 2956.698 | 2896.706–3062.029 |
| HTTPS already connected | 8192 | 11/11 | 631.667 | 596.561–661.181 |
| WSS already connected | 1024 | 12/12 | 432.270 | 390.800–461.349 |
| WSS already connected | 8192 | 12/12 | 838.422 | 795.245–864.144 |

Each retained HTTPS group also had one successful initial connection/upload,
2832.187ms and2963.916ms respectively; these two warmup samples are excluded from
the already-connected rows. The22 already-connected HTTP requests generated zero
new SDK connection events. This is actual socket-reuse evidence, rather than an
assumption based on retaining a client handle.

WSS initial connection took2648.443ms. All24 steady messages retained one session
ID. A45.001second interval without business data retained the connection with
five ping replies; the next1024byte receipt took448.626ms. The server then closed
with code1000 at the authenticated test command. Explicit reconnect took
2611.970ms, produced a different session ID, and verified four further receipts.
These five additional WSS receipts and the two HTTPS warmups bring the total
to65 payload receipts.

HTTPS uses the existing production-style initial12second/connected1second I/O
configuration and generated async retry repair. WSS uses explicit <=1024byte
frames plus FIN and a12second receipt-validity threshold; SDK receive/control
I/O and cleanup differ from HTTP and may outlast the success threshold on error.
This compares these specific implementations, not universal protocol overhead.
HTTPS requests are separated by30ms; WSS steady requests wait for each receipt
but have no additional cadence delay. HTTP idle survival, long-duration soak,
matched BLE/production-journal load, weak Wi-Fi and reconnect under packet loss
were not measured. Wi-Fi RSSI was not sampled. Groups ran sequentially, so time
variation remains a confound; no nationwide availability or SLA is inferred.

ESP-IDF5.5.3 C3 compile, two configuration tests, ASan/UBSan C receipt/wire/fragment
tests, eight Worker tests, generated types/checkJs and Wrangler dry run passed.
Worker tests distinguish seven real local workerd cases from the controlled
overlapping-handler fixture; local workerd compatibility was2026-10-19, while
the deployed date was2026-10-27 (the current UTC date during this local Oct28 run).
The tested app was1006848bytes, SHA-256
`1d62979bfed0ad314356b6547c3151a4a5bb35b03942a43a2885602b7042d5a1`.

The original app sectors were restored. Before reboot, ROM digest verification
confirmed all8MiB exactly matched the fresh pre-experiment backup, including NVS,
`cardid`, bootloader, partitions and queue. The original `cp-aa1b3ec36d40` boot
message was observed, both read-only USB status requests passed with saved
credentials present, the boot ID stayed unchanged and no crash marker appeared.
This confirms restoration, not production collection/cloud acceptance.
The temporary Worker and Custom Domain were deleted; API readback confirmed
both absent and the production `campuspulse` service metadata and `pulse.anend.net`
binding unchanged. No MQTT instance, DO, Queue or storage resource was created.

Private evidence is under ignored `captures/cf-longlink-20261028/`:
`results-safe-summary.json`, `device-safe-evidence.json`,
`diagnostic-flash-safe-summary.json`, `restoration-safe-summary.json`,
`restored-boot-safe-evidence.json`, `cf-cleanup-safe-summary.json` and
`frozen-build-provenance.json`. Flash images, secrets and generated artifacts
remain local/private and must not be published. No production transport code
was changed or committed by this experiment.

Recommendation: prioritize persistent HTTPS client/socket reuse with bounded
reconnect and exact durable ACK validation in the existing upload worker.
Measured1024/8192byte median reductions were84.3%/78.6% compared with fresh
connections. WSS offered no measured speed advantage over retained HTTPS in
this implementation; select it later if server-initiated device commands or
continuous bidirectional messages justify its lifecycle complexity. Add DO for
session coordination and Queues for asynchronous backpressure only when those
requirements exist, while preserving final D1/R2 receipt semantics.

Even a successful long connection does not remove slow first connections or
cross-border routing failures. Runtime updates and network changes can close
sockets. Production use would retain exact batch identity, idempotency and
verified durable receipts across reconnects.

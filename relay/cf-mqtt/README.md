> Historical implementation retired on 2026-10-31. The executable legacy
> relay was removed in the V3-only migration. The production path is
> `../emqx-cloud/`. Historical source remains in Git at `69a0fee`.

# Cloudflare MQTT over WSS gateway prototype

This is a restricted MQTT 3.1.1 RPC gateway for CampusPulse device API v2. It is
not a general-purpose MQTT broker, a raw TCP/8883 listener, or a managed Pub/Sub
product. The new Worker and one SQLite-backed Durable Object per authenticated
node terminate MQTT over WebSocket/TLS. HTTP RPC forwarding uses the existing
`campuspulse` Worker Service Binding, never a public self-fetch or client URL.

Status: locally tested on workerd with synthetic D1 credentials, a synthetic
service binding and durable synthetic receipt rows. Production deployment,
physical firmware acceptance, latency/heap improvements, and mainland routing
must be recorded separately. Local passes do not prove any of those outcomes.

## Wire contract

- WSS `/mqtt`, no query string, `Sec-WebSocket-Protocol: mqtt` exactly.
- HTTP `Authorization: Bearer <existing device token>`; do not put credentials
  into the URI, MQTT password, logs, or tracked configuration.
- MQTT CONNECT: protocol name `MQTT`, version 4, flags `0x82` (clean session,
  username only), username = authenticated node, client ID = `<node>:<boot>`.
  Node is `[a-z0-9_-]{1,15}`; boot is lowercase UUIDv4. Keepalive is 30 or 60 s.
- One subscription: `cp/v1/<node>/<boot>/rep/+/+`, requested QoS 0 or 1; SUBACK
  grants QoS 0. No other wildcard, namespace or cross-node subscription exists.
- Request: QoS 1, non-retained PUBLISH to
  `cp/v1/<node>/<boot>/req/<op>/<rpc>` with the original body bytes.
- `<op>` is `contact`, `config`, `activation`, or `ingest`. `config` has no body.
- `<rpc>` is canonical decimal uint32, nonzero, increasing for this connection.
  The firmware must not reuse RPC numbers within a boot. Reconnecting starts a
  clean transport session; the backend retains batch-level idempotency.
- Response: QoS 0, non-retained PUBLISH to the corresponding `/rep/<op>/<rpc>`.
  Payload is a two-byte big-endian HTTP status followed by the **unaltered**
  response body. There is no JSON wrapper or body reserialization.
- PUBACK only acknowledges transport delivery. Release a frozen local batch
  only after the existing firmware validator verifies its Cloudflare receipt.
- Matching in-flight DUP requests are PUBACKed without another forward. The
  most recent completed RPC can be retried with DUP only when operation, packet
  ID and exact body hash agree. It is forwarded again for backend idempotency.
  Changed or older RPCs close the session; new retries should use a new RPC ID.
- MQTT 5, Will, retained delivery, QoS 2, unsubscribe, arbitrary topics and other
  unsupported control packets fail closed. Binary WebSocket messages can split
  or coalesce MQTT packets; fixed headers and Remaining Length can be split.

| Operation | Service binding method/path |
| --- | --- |
| `contact` | `POST /api/v2/device/contact` |
| `config` | `GET /api/v2/device/config` |
| `activation` | `POST /api/v2/device/config/ack` |
| `ingest` | `POST /api/v2/ingest` + SHA-256 of the exact bytes in `X-Body-SHA256` |

All binding requests have the fixed origin `https://pulse.anend.net`. Incoming
headers, query strings, URLs and asserted identity are never forwarded.
Backend 401/403 replies are sent unchanged, then the socket closes. Ordinary
422/409/5xx responses remain distinct, including backend error JSON. An oversized
response, transport failure or 15-second deadline yields status 504 and
`{"error":"gateway_outcome_unknown"}`. This is not a durable receipt: aborting
the binding request cannot prove the backend did not commit. Retrying the exact
frozen batch remains necessary. Late results from a timed-out call are ignored.

## Resource and lifecycle limits

| Item | Bound |
| --- | --- |
| Active sockets | 1 per authenticated node; replacement closes the old socket |
| Awaited backend RPCs | 1 per node; concurrent distinct requests close the sender |
| Request body | 8192 bytes |
| MQTT packet / individual WS message | 8704 bytes |
| Coalesced packets | 32 per incoming WS message |
| Original response body | 2048 bytes (2050-byte status/body envelope) |
| Fragment assembly | 5 s total from first incomplete fragment |
| CONNECT deadline | 10 s |
| Backend deadline | 15 s including response body consumption |
| Idle expiration | MQTT keepalive × 1.5 |
| Per-connection minute limit | 4096 WS messages, 4 MiB, 600 RPC attempts |

Limits are per authenticated connection and reset on a clean reconnect; this is
not a global DDoS/rate-limiting service. HTTP authentication performs a D1 lookup.
One deadline alarm per node enforces MQTT idle time; it does not poll the backend.

The DO uses `acceptWebSocket()` and hibernation event methods. Complete sessions
have no periodic JS timer or open outbound connection. Binary MQTT PINGREQ is
handled normally; the text-only auto-response API is deliberately not used.
Credentials are AES-256-GCM wrapped with a random IV and node/session-bound AAD
before crossing into the DO. Attachments are under 2 KiB and contain ciphertext,
protocol counters and identity; no raw token, request body or receipt is stored
in SQLite/KV. `SESSION_WRAP_KEY` is a separate Worker secret, not a device token.
Changing it invalidates existing wrapped sessions on their next RPC.

Partial packets live only in bounded RAM with a five-second timer, which prevents
normal hibernation during assembly. In-flight forwarding keeps its event alive.
The attachment records partial/in-flight state before asynchronous work. If a
forced restart loses that RAM, the constructor closes the connection, requiring
frozen-data retry instead of fabricating completion. The gateway is not a durable
queue; durability remains in existing Cloudflare API receipt transactions.

The APAC location setting is a best-effort hint for initial placement, not a
guaranteed region, latency, mainland endpoint or data-residency constraint.

## Local verification

From the repository root (existing pinned npm dependencies):

```sh
WRANGLER_LOG_PATH=/tmp/campuspulse-mqtt-wrangler.log \
  node_modules/.bin/wrangler types --config relay/cf-mqtt/wrangler.jsonc \
  relay/cf-mqtt/worker-configuration.d.ts
node_modules/.bin/tsc -p relay/cf-mqtt/tsconfig.json
node --test relay/cf-mqtt/test/gateway.test.mjs
WRANGLER_LOG_PATH=/tmp/campuspulse-mqtt-wrangler.log \
  node_modules/.bin/wrangler deploy --config relay/cf-mqtt/wrangler.jsonc \
  --dry-run --outdir relay/cf-mqtt/.build/dry-run
```

Miniflare needs loopback listener permission. Tests use no production credentials
or cloud writes. `test/entry.ts` supplies test-only attachment inspection and an
interrupted-state fixture; the deployed entry is always `src/worker.ts`.
Wrangler generated the environment/runtime types using locally installed
workerd 1.20261019.1. Local tests select that runtime's supported date. Deployment
targets 2026-10-28; current published Workers types 5.20261028.1 were independently
retrieved to check the hibernation APIs and location-hint signatures.

The suite exercises strict MQTT grammar, deterministic fuzz, WS fragmentation,
maximum bodies, namespace isolation, forged identity, auth revocation, one pending
RPC, duplicate deliveries, durable duplicate receipts, lost response/reconnect,
hibernation/wakeup, interrupted-state closure, partial-packet timeout, keepalive
PING handling, rate bounds, backend 422/503, response overflow and deadlines.

## Deployment inputs (no cloud resources created by this prototype)

The template names the new service `campuspulse-mqtt-gateway`, binds
`INGEST_SERVICE` to `campuspulse`, and declares the `MqttSession` SQLite migration.
Before an independently authorized deployment:

1. Resolve the existing account and `campuspulse` D1 database ID into a private
   config override. The committed UUID is a placeholder; do not create another
   production device database or apply schema migrations from this directory.
2. Set `SESSION_WRAP_KEY` to 32 cryptographically random bytes encoded as standard
   base64, using secret input/file facilities without printing it.
3. Check domain ownership/conflicts, then attach the selected custom hostname
   (proposed `pulse-mqtt.anend.net`). No route is preselected here. Workers.dev
   and preview URLs are disabled. Certificate provisioning must finish first.
4. Verify a controlled synthetic node through the actual service binding and
   the production API's receipt validator before physical-node acceptance.

Do not enable a paid plan as an implicit side effect. Current Cloudflare docs
allow SQLite Durable Objects on Workers Free: 100,000 request units/day and
13,000 GB-s/day; exceeding a free limit fails the affected operation. Incoming
WebSocket messages use a 20:1 billing ratio; handshake/RPC/alarm requests count
separately. API/D1/R2 usage and their own limits are additional. Eligible idle
hibernation does not accrue duration, but active forwarding, the bounded
fragment timer and active event handling do. Check the actual account/plan and
current usage before deployment; these are documentation limits, not measured
costs for this device.

## Provenance and references

The parser/gateway are newly authored in this repository. Authentication directly
imports the repository's `worker/ingest.ts::device` and `IngestError` rather than
copying credential logic. No third-party MQTT broker/parser implementation,
historical firmware, credentials, captures or image assets are imported. Existing
repository rights apply to that internal reuse; it does not create a new external
license grant. Root `docs/notes/reuse.md` should index this reuse before commit.
Generated Cloudflare runtime declarations retain their upstream license notices.

- [OASIS MQTT 3.1.1](https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html)
- [Cloudflare WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Data-location hints](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

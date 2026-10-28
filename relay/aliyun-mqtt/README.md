# MQTT to Cloudflare relay core

Local implementation with fixture-only tests; no Alibaba resources, event source,
handler, broker credentials or deployment are configured here. Node ESM uses only
the standard library, independently of the frontend package and lockfile.

Run `node --test relay/aliyun-mqtt/relay.test.mjs` from the repository root.

## Request contract, version 1

The UTF-8 JSON MQTT payload has exactly these five fields; no others are accepted:

```json
{
  "protocol": "campuspulse-mqtt-relay/1",
  "request_id": "b0c7e118-64ae-4d48-9cac-7508bc09fe77",
  "op": "health",
  "body_base64": "",
  "body_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

`request_id` is a lowercase RFC 4122 UUID v4. `body_base64` is canonical padded
RFC 4648 base64 of the exact frozen HTTP body bytes. `body_sha256` is their
lowercase SHA-256. GET operations use zero bytes and the empty-body hash above.
Replays retain the UUID, body bytes and hash. No payload field supplies a device
token, broker/Alibaba root secret, identity, reply topic, URL or HTTP headers.
An ingestion HTTP body still contains the existing API's `node_id`; the relay
checks it against the authenticated server binding and never treats it as authority.

| op | method | fixed path |
| --- | --- | --- |
| health | GET | `/api/v1/health` |
| contact | POST | `/api/v2/device/contact` |
| config | GET | `/api/v2/device/config` |
| config_ack | POST | `/api/v2/device/config/ack` |
| ingest | POST | `/api/v2/ingest` |

The production origin is fixed to `https://pulse.anend.net`. No arbitrary query
parameters are accepted. Config reads the current desired configuration; fetching
an explicitly named historical configuration is outside version 1. The only origin
override is an explicitly injected `testOrigin` using HTTP localhost/loopback.

The core accepts at most 65,536 decoded request bytes, 88,408 envelope bytes,
12,288 response bytes, 8 seconds total fetch/body time, 16 JSON nesting levels,
8,192 JSON object keys and 128 UTF-16 code units per key. JSON duplicate decoded
keys, nonfinite numbers and invalid UTF-8 are rejected. Body JSON is inspected
without reserialization. Cloudflare remains responsible for the API's complete
schema, enabled-device and capture-policy validation.

**The HTTP limit is not a broker deliverability guarantee.** Base64 expands the
body by roughly one third. For a managed MQTT product with a 64 KB message limit,
configure the device batch cap at 45 KiB or lower (61,440 base64 characters plus
this envelope), then validate that product's actual byte limit, request/reply
topic rules, QoS limits and event-source limits before deployment. Responses also
need room for base64 and the reply envelope. The FC adapter must enforce the
selected provider's smaller ingress limit before invoking the core.

## Reply contract and receipt boundary

The returned `replyTopic` is always from the server binding. An upstream HTTP
response produces this reply, retaining its original status and exact body:

```json
{
  "protocol": "campuspulse-mqtt-relay/1",
  "request_id": "b0c7e118-64ae-4d48-9cac-7508bc09fe77",
  "op": "health",
  "request_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "kind": "upstream_response",
  "status": 200,
  "body_base64": "e30=",
  "response_sha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
}
```

The illustrative body `{}` is not a real health or ingestion ACK. The device
must first match protocol, UUID, op and request hash, verify the response hash,
then validate the original Cloudflare response against its expected node, boot,
sequence/config or batch identity using the existing API ACK parser. Only that
validated durable ingestion receipt permits reclaiming a frozen batch.

HTTP 401, 429, duplicate receipts, other errors and manual 3xx responses retain
their status/body; no response headers are forwarded. `redirect: 'manual'`
prevents following Location. A fetch implementation that reports an already
followed redirect is rejected. Each broker redelivery performs a new HTTP request
with the same original bytes; there is no in-memory success cache or invented
deduplication receipt.

A transport failure returns the same four correlation fields plus:

```json
{ "kind": "relay_error", "code": "upstream_timeout" }
```

Other codes are `upstream_network_error`, `upstream_response_too_large` and
`upstream_redirect`. Such replies have no HTTP status or body. Authentication or
invalid ingress throws `RelayFault` and produces no reply with unvalidated
correlation. Exception messages, credentials and request bodies are not logged.
Adapters may record only fixed error codes and operational counters.

Broker PUBACK, successful FC invocation, local receipt, and reply publication are
not Cloudflare durable ACKs. A publish failure must retry safely; uncertain
network/body-timeout outcomes preserve the frozen request for exact redelivery.

## Server integration boundary

`createRelay({ bindings, fetchImpl?, testOrigin?, timeoutMs? })` returns
`relay({ principal, topic, payload })`. Server-only bindings contain
`principal`, `topic`, `node_id`, `device_token` and `reply_topic`. The exact pair
of authenticated transport principal and incoming topic selects one binding.
Bindings are copied at factory creation and contain no MQTT wildcard topics.
Load credentials from a server secret service at runtime; never commit them.

`adapter-interface.mjs` provides a handler factory requiring three functions:

- `authenticateAndNormalize(event, invocationContext)` authenticates the actual
  broker-trigger invocation and obtains broker-attested principal/topic/payload.
- `relay(trusted)` invokes the core.
- `publishReply(boundTopic, bytes)` publishes through independently configured
  server credentials and awaits the broker result.

There is deliberately no default Alibaba event parser or exported ready-to-deploy
FC entrypoint. A JSON object that claims `clientId`, `principal`, `topic` or
`node_id` does not establish trusted context. An HTTP caller must not be able to
invoke the broker adapter with fabricated event fields. Before wiring a real
product, confirm its authenticated invocation/service role, metadata provenance,
topic construction and per-device request/response ACLs. Fail closed if any is
missing. Provider-managed metadata and device payload must remain separate.
Do not allow device principals to publish other devices' requests or replies.
Deployment must also apply broker/FC rate and concurrency quotas; the core does
not implement a distributed rate limiter or durable local queue.

The handler factory supports one normalized message per call. A product whose
event contains multiple messages needs an explicit bounded adapter with defined
partial-failure/retry behavior. No assumptions about that product's event fields,
batch retry policy, publishing SDK or caller authentication are made here.

> Historical prototype record,2026-10-28. The production registry, six-field
> broker event and replay-window design supersede fixed DEVICE_MAP and lifetime
> boot caps below. See [current gateway](README.md) and [production operations](../../docs/notes/mqtt-production.md).

# EMQX to Cloudflare RPC ingress

This replaces the temporary Mac bridge with the requested cloud path:

```text
Device -- MQTT/TLS, persistent --> Hangzhou EMQX
                                  | HTTP connector, HTTPS
                                  v
                       Cloudflare campuspulse-emqx Worker
                                  | Service Binding
                                  v
                       Existing campuspulse ingestion API

CF response -- one-shot MQTT/TLS publish --> EMQX --> device
```

Status as of2026-10-28: **deployed; scoped EMQX connector/rule and bounded
physical cloud-only acceptance pass**.
89 host tests, one real workerd/SQLite Durable Object integration test,
JavaScript type checking and a Wrangler deployment dry run pass. An initial
automatic approval rejection was resolved by the user's explicit authorization
to store this chain's device/MQTT/webhook credentials in Worker secrets. The
isolated Worker and new custom domain are deployed; the main application and
paid plan were not changed. A real config-only service-binding→MQTT reply test
passes in2474ms, returning the original1072-byte status/body envelope, with
unauthenticated webhook rejection verified. This test originates on the Mac;
it is separate from the subsequent physical acceptance below. The operator
created the HTTPS connector with the webhook credential, strict peer validation
and SNI. The scoped rule/HTTP action are enabled and available, the owned Mac
bridge exited normally, and a process audit confirms no local bridge remains.

## Physical cloud-only acceptance

The unchanged `emqn-85e81c46c0cb` C3 image passes303.747s of continuously sampled
active BLE collection during a336s observation. Opening USB observation triggers
one `ESP_RST_USB` reset (reason11); no flashing occurs and no further reset/crash
is observed. Five buffered RPC records and four verified uploads from before
that boot marker are excluded from all counts below. The reset interrupts the
previous running window; this test does not establish uninterrupted capture
across that reset. Full safe summaries remain ignored/private.

| Metric | After initial USB reset, Mac bridge absent |
| --- | --- |
| Boot BLE reports seen |6310 |
| Device MQTT session / cold setup |1 /2970ms |
| RPCs / reused / transport errors |72 /71 /0 |
| Warm successful RPC |median2767.5ms, p95 5023ms, max7252ms; complete CF roundtrip |
| Verified CF batches / original body bytes |50 /124679B;46 current-boot batches |
| Active pending queue |4–6 batches; first/last checkpoints5→5 |
| Final heap / largest contiguous block |54240B /34816B |
| Allocation failures / memory denials |0 /0 |
| Callback/window/storage/summary/raw losses |0 in each reported counter |
| Memory/pressure pauses / seal overflows / ACK failures |0 in each reported counter |

One preserved historical422 remains distinct from new upload failures. Device
collection continues after serial observation closes. The current full path is
device→native MQTTS→Hangzhou EMQX→HTTPS rule→CF Service Binding/API, with the
original CF receipt published back through EMQX. No Mac or Stash relay participates
in that path. No six-hour local-service expiration applies to the cloud service.
This is a bounded original-policy trial, not maximum-payload/address stress or
an unlimited lossless guarantee. Earlier unstable-path persistence coupling and
domestic durable custody remain separate unresolved work.

## Identity and byte preservation

The HTTP connector supplies one complete JSON object with exactly these fields:
`username`, `topic`, `qos`, `retain`, `payload_b64`. The username must come from
EMQX's authenticated publication event, not a device JSON field. The private
`DEVICE_MAP` secret maps that username to its one allowed node and existing CF
upload token. Broker ACLs remain necessary. A distinct256-bit `WEBHOOK_KEY`
authenticates the broker's HTTPS calls in `X-CP-Webhook-Key`; device credentials
alone cannot invoke this endpoint. Only configured fixed CF paths are reachable.

Original payload bytes are Base64-encoded by the rule, validated canonically,
decoded without reserializing, and sent unchanged to the existing API. Ingest's
`X-Body-SHA256` is computed from those bytes. Older-boot frozen ingest batches
remain legal; contact/activation must match the current topic boot. Config has
an empty body and always reaches CF for a fresh lease.

The existing firmware topics and reply envelope are unchanged:

- Request: `cp/v1/<node>/<topic-boot>/req/<op>/<rpc>`, QoS1, non-retained.
- Reply: corresponding `/rep/`, two-byte big-endian HTTP status followed by the
  exact CF response bytes. The device validates its existing durable receipt.
- Operations: `contact`, `config`, `activation`, `ingest`; paths match the local
  verification bridge in [`../emqx`](../emqx/README.md).

The per-node SQLite DO persists only latest RPC/op/SHA256 for up to64 topic
boots and minute admission counters. It rejects older/changed RPCs, allows exact
retries through CF, and admits one request across backend/publication awaits.
No credentials, payloads, replies or config leases are stored in that journal.
Boot entries are not automatically evicted; reaching64 requires operator review.

## Bounds and failure semantics

| Item | Limit |
| --- | --- |
| Allowlisted nodes |16 |
| Original payload / whole HTTP event |8192B /12288B |
| Original CF reply / MQTT envelope |2048B /2050B |
| In-flight work |1 per node |
| Minute admission |600 attempts /4MiB per node; duplicates/rejected replays count |
| CF request and body deadline |10s |
| Return MQTT connect/publish/close deadline |6s |
| Device's existing RPC wait |20s; remaining time covers broker/HTTP/DO overhead |

The one-shot return publisher uses strict platform TLS on8883, a random clean
MQTT3.1.1 session, the existing scoped relay identity, QoS1 publication and a
matching PUBACK before cleanup. No deployment-wide administration API key is
required. The device's subscription is QoS0; its frozen-data retry remains
necessary if a reply is lost. Each return publication currently reconnects;
the device's collection/upload MQTT connection stays persistent.

CF errors including401/403/409/422/5xx remain exact application replies.
Transport, compressed or oversized CF responses return only504
`gateway_outcome_unknown`, never a successful custody claim. If MQTT publication
fails, the webhook returns503 so the provider may retry. HTTP204 means the
broker accepted the return publication, not that the device received it.
Neither broker PUBACK nor this DO journal grants domestic durable custody.

## EMQX connector and rule plan

These are reviewed setup instructions; **a generated plan is not an applied
cloud configuration**. Serverless supports public HTTP connectors. Configure a
fixed HTTPS destination `/emqx`, strict TLS peer verification, content type
`application/json`, the private webhook header, and a request timeout of at least
25s. Do not weaken TLS or create deployment-wide API access.

Build the entire JSON object in SQL to avoid unsafe string-template escaping:

```sql
SELECT
  json_encode(
    map_put('payload_b64', base64_encode(payload),
      map_put('topic', topic,
        map_put('username', username,
          map_put('qos', qos,
            map_put('retain', map_get('retain', flags, false), json_decode('{}'))))))
  ) AS webhook_body
FROM "cp/v1/+/+/req/+/+"
WHERE qos = 1 AND map_get('retain', flags, false) = false
```

Action: HTTP POST, body **`${webhook_body}`**, without additional quotes. Narrow
the rule to the actual authorized device username/topic before activating it.
The actual Serverless SQL test passes38 original bytes including Unicode,
leading/trailing spaces and newlines. Its test event omits false flags, so
`map_get('retain', flags, false)` is necessary; direct `flags.retain = false`
did not match that event. The UI refuses an empty test payload; actual empty
config requests are validated separately through the real MQTT path. Maximum
original payload size is host-tested, not a maximum-size physical load trial.

The new webhook secret's entry/submission in the browser must be completed by
the operator, following the computer-use credential handoff rule. Keep all real
configuration in ignored private directories with0700/0600 permissions. Do not
put tokens into URLs, screenshots, source, logs or commit messages.

## Validation and deployment

```sh
node --test relay/emqx-cloud/test/handler.test.mjs \
  relay/emqx-cloud/test/mqtt-publish.test.mjs \
  relay/emqx-cloud/test/rpc-guard.test.mjs
node --test relay/emqx-cloud/test/workerd.test.mjs
node_modules/.bin/tsc -p relay/emqx-cloud/tsconfig.json
WRANGLER_LOG_PATH=/tmp/campuspulse-emqx-cloud.log \
  node_modules/.bin/wrangler deploy --config relay/emqx-cloud/wrangler.jsonc \
  --dry-run --outdir relay/emqx-cloud/.wrangler/dry-run
```

The committed broker host is deliberately invalid; resolve private deployment
inputs separately. Use Wrangler's secret-file facility without printing values.
The existing primary Worker, device NVS and firmware are not redeployed by this
slice. `test/publisher-fixture.mjs` is a build substitution for local workerd
tests only; the production entry imports the real TLS publisher.

The bounded cloud-only acceptance above stops the owned Mac bridge, observes
fresh validated CF receipts, reports queue/heap/software loss and verifies the
local relay's absence. A deployment or host-test pass alone is not that proof.

## Provenance and primary references

New code is authored for this repository. Wire validation and frozen-body/ACK
semantics follow the existing CampusPulse relay and CF gateway. No vendor SDK,
private capture, credential, CA or image is copied into this source directory.

- [EMQX HTTP data integration](https://docs.emqx.com/en/cloud/latest/data_integration/http_server.html)
- [EMQX SQL functions](https://docs.emqx.com/en/cloud/latest/data_integration/rule-sql-builtin-functions.html)
- [Cloudflare TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [SQLite Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

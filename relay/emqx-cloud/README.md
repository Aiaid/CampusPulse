# Production EMQX to Cloudflare gateway

The production source implements device nativeMQTT/TLS→Hangzhou EMQX→HTTPS
rule→CF gateway→private `MqttDeviceApi` service binding. The original CF status
and exact receipt bytes return through a scoped MQTT publisher. No Mac relay or
Stash connection participates in the device upload path.

See [production enrollment and operations](../../docs/notes/mqtt-production.md)
for the verified credential pool, protected device setup, deployment bootstrap
and hardware-rollout status. The [2026-10-28 prototype record](prototype-20261028.md)
retains the earlier physical trial and its measurement/reset boundaries; it is
not acceptance of every new source revision.

## Broker event contract

[`rule.sql`](rule.sql) builds one complete JSON object with exactly:

- `username`: authenticated publication identity from EMQX.
- `topic`: `cp/v1/<namespace>/<boot>/req/<contact|config|activation|ingest>/<rpc>`.
- `qos:1`, `retain:false`.
- `payload_b64`: canonical Base64 of original frozen bytes; config is empty.
- `published_at_ms`: EMQX's trusted `timestamp`, independent of device payload.

Use HTTP POST `/emqx`, `application/json`, header `X-CP-Webhook-Key`, strict
server TLS/name verification and25s action expiry. HTTP body is exactly
`${webhook_body}`. The five-field prototype contract is deliberately rejected.
The rule excludes probe-only unsupported operations. Serverless test events
omit false flags, so the rule uses `map_get('retain', flags, false)`.

The gateway validates size/grammar/freshness, then asks the production registry
to authorize username+namespace **before** allocating a per-node DO. The private
API rechecks assignment, verification, node enablement and canonical observation
ownership at processing/commit. There is no fixed allowlist, device-token map,
public identity-bypass header or credential in a topic/URL. Namespaces are
independent of factory node IDs; original body node/boot validation stays in the
existing API. An older frozen ingest body boot remains legal.

## Reply, replay and bounds

The return MQTT3.1.1 publisher uses strict platform TLS on8883, a fresh random
clean session and QoS1 publication, waiting for matching PUBACK before bounded
cleanup. Device subscription remains QoS0 and exact frozen retries remain
necessary. Broker PUBACK or webhook204 never grants CF data custody.

The reply body is two-byte big-endian HTTP application status plus unchanged API
bytes. Errors including401/403/409/422/5xx remain distinct. An API deadline,
invalid/oversized reply or other uncertain outcome returns only504
`gateway_outcome_unknown`. A failed return publish leaves the webhook503 so
retry can obtain the authoritative API receipt. Configuration leases are never
cached.

| Resource | Bound |
| --- | --- |
| Request / webhook / original API reply |8192 /12288 /2048 bytes |
| In-flight ownership |1 per canonical registered node |
| Admission |600 attempts/4MiB per minute per node |
| Accepted broker event time |past120s through future10s |
| Latest boot replay records |64 active-window boots; retire only after130s |
| Registry/API/return publish deadlines |2s /10s /6s |
| Existing device RPC wait |20s |

The DO stores only latest RPC/op/SHA256/publication time and rate counters. It
rejects changed/older RPCs during the replay window and allows exact retries to
reach CF again. Stale events cannot prune or reset state. It does not store
credentials, observations, receipts or config leases. Existing v1 state migrates
to v2 without wiping sequence/rate state. A rollback must retain compatibility
with v2; the untouched prototype guard is not a safe rollback target.

## Deployment and validation

`wrangler.jsonc` names the production public host and named service binding.
Private Worker secrets are `WEBHOOK_KEY`, `MQTT_USERNAME`, `MQTT_PASSWORD`.
Device credentials live encrypted in the main registry; the gateway receives no
device upload token. Old prototype `DEVICE_MAP` should be removed after cutover.
Use the dedicated reply-only server identity; no deployment-wide EMQX API key is
required.

```sh
node --test relay/emqx-cloud/test/*.test.mjs
node_modules/.bin/tsc -p relay/emqx-cloud/tsconfig.json
WRANGLER_LOG_PATH=/tmp/campuspulse-mqtt.log \
  node_modules/.bin/wrangler deploy --config relay/emqx-cloud/wrangler.jsonc \
  --dry-run --outdir relay/emqx-cloud/.wrangler/dry-run
```

Production CI generates the account-scoped config with
`scripts/cloudflare-mqtt-config.mjs`. Set
`CLOUDFLARE_MQTT_ROLLOUT_READY=true` only after broker import/verification, the
six-field rule and device migration are ready. Deploy the main API entrypoint
before switching the gateway. Secret values remain retained Worker secrets;
never pass them as CLI arguments or commit export files.

`test/backend-fixture.mjs` and `test/publisher-fixture.mjs` are local build
substitutions only. Host tests and real workerd RPC tests are separate from live
broker, USB/BLE and sustained hardware acceptance. Keep exact raw evidence in
ignored private captures and report software loss/queue pressure explicitly.

## Provenance

New code is authored for CampusPulse and follows its existing v2 API/frozen
receipt contract. No vendor MQTT implementation, private repository history,
operator credential or image is copied here. Public CA provenance is in
[`firmware/certs`](../../firmware/certs/README.md).

- [EMQX HTTP integration](https://docs.emqx.com/en/cloud/latest/data_integration/http_server.html)
- [EMQX SQL functions](https://docs.emqx.com/en/cloud/latest/data_integration/rule-sql-builtin-functions.html)
- [EMQX authorization CSV](https://docs.emqx.com/en/cloud/latest/deployments/default_authz.html#import-authorization-information)
- [Cloudflare service-binding RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)
- [Cloudflare TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)

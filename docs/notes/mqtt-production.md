# Production MQTT enrollment and upload

Date:2026-10-29. This is the current production software contract. The earlier
[MQTT transition record](mqtt-wss-transition.md) retains protocol experiments and
the2026-10-28 physical cloud-only trial; those measurements are not acceptance
of every later firmware image or every board.

## Transport and identities

```text
Device -- persistent native MQTT/TLS --> Hangzhou EMQX
  ^                                      |
  |                                      | HTTPS rule with original-byte envelope
  |                                      v
  +--------- scoped MQTT reply ------- CF MQTT gateway
                                          |
                                          | private MqttDeviceApi service binding
                                          v
                                   Production registry/API/D1/R2
```

Normal firmware defaults to native MQTT/TLS. There is no automatic HTTPS upload
fallback when MQTT credentials are absent. HTTP device APIs remain available
for backwards compatibility and explicit diagnostics; their Bearer checks are
unchanged. The public map, backend and data remain hosted on Cloudflare.

The factory `node_id` remains the canonical observation owner. The independently
allocated MQTT username/namespace need not equal it. The gateway authenticates
the EMQX webhook, resolves username+namespace through the **live production
registry**, and routes one bounded DO owner per canonical node. The private
`MqttDeviceApi` service checks assignment, broker verification and node enablement
again when processing/committing. No public HTTP header can select this trusted
identity. The gateway no longer needs a fixed device-token map or device upload
tokens. Disablement takes effect through the registry instead of a gateway
secret redeployment.

Requests use `cp/v1/<namespace>/<boot>/req/<operation>/<rpc>`, with the unchanged
frozen JSON bytes. EMQX Base64-encodes those bytes and supplies its authenticated
username and trusted broker publication timestamp. The gateway never substitutes
namespace for the canonical node in an observation. Ingest retains its original
body boot and SHA256; configuration leases always come freshly from the API.

Replies preserve the two-byte big-endian HTTP application status followed by
the exact original API body. MQTT PUBACK and HTTP webhook204 are transport
acknowledgments. Only the existing full CF durable-receipt validator permits
Flash-journal reclamation. Uncertain processing remains504/unknown and is
retried idempotently; no domestic durable-custody receipt is invented.

## One batch import, then automatic registration

EMQX Serverless currently supports built-in password authentication, but does
not provide its user/ACL creation through the documented Serverless API or
support JWT/external authentication. See the
[official authentication matrix](https://docs.emqx.com/en/cloud/latest/deployments/auth_overview.html)
and [Serverless API index](https://docs.emqx.com/en/cloud/latest/api/serverless.html).
The production workflow therefore uses a verified credential pool:

1. An authenticated, recently verified administrator generates1–32 independent
   device identities in **设备管理 → MQTT 设备授权池**.
2. Passwords are encrypted with AES-GCM in D1 using Worker secret
   `MQTT_PROVISIONING_KEY`; ciphertext is bound to record ID, username, namespace
   and the fixed broker URI. Ordinary listings and audits contain no passwords.
3. Download the two one-time private CSV files. Import them into the selected
   EMQX deployment's authentication and username-authorization pages. The
   authentication header is `username,password`; authorization uses
   `username,topic,action,access`, with Cloud action values `pub`/`sub`/`pubsub`.
   Do not use Enterprise-only CSV field names or `publish`/`subscribe` values.
   Select **用户名**, not the default client-ID view, before opening Import.
   Username+topic pairs are unique: use one final `#,pubsub,deny` row per user,
   never two separate pub/sub deny rows for the same `#` topic.
4. Click **已导入，验证此授权**. The server actually verifies strict broker TLS,
   login, the own reply subscription and allowed request publication, plus denial
   of cross-namespace access, request subscriptions and forged reply publication.
   The probe publishes no contact or ingestion evidence. Failed verification
   leaves the record unavailable; material generation alone is not readiness.
5. Registering a device atomically allocates one verified ready identity together
   with node creation and audit. An empty pool fails explicitly without leaving
   an orphan device. Concurrent registrations cannot share the same identity.
6. Protected USB/BLE/SoftAP provisioning writes the issued identity to that
   device. Registry allocation, device save, desired-policy activation and actual
   cloud receipts are distinct states in the UI.

The current batch contains16 device identities and a separate server identity
restricted to publication on `cp/v1/+/+/rep/+/+`, with a final `#` pubsub deny.
It cannot publish requests or subscribe; the stable reply role supports later
pool refills without credential/ACL changes to that server identity. Importing this batch does
not alter existing test accounts or add an All Users rule. The broker's existing
CNY0 consumption limit is retained; no paid-plan upgrade is requested.

New device material is the existing candidate plus:

```json
{
  "mqtt": {
    "uri": "mqtts://q9a692f8.ala.cn-hangzhou.emqxsl.cn:8883",
    "username": "synthetic_user",
    "password": "synthetic-example-password-only",
    "namespace": "synthetic_user"
  }
}
```

This is a synthetic schema example, not usable production credentials. Settings
v3 appends runtime MQTT fields; v1/v2 settings are read without erasing old slots.
A legacy enrollment with no MQTT identity enters setup with a migration status,
preserving saved network data and queued observations. Wi-Fi-only saved-identity
reuse keeps MQTT credentials. Explicit recovery of an assigned identity requires
fresh administrator authentication and does not silently rotate it. The existing
rotation control now says **备用 HTTP 凭证**; it does not rotate MQTT authorization.

USB and SoftAP accept at most1536 UTF-8 candidate bytes. BLE retains the496-byte
authenticated plaintext/512-byte encrypted GATT limit and uses bounded
`configure_chunk`/`configure_commit` when needed. Assembly is wiped and freed
before candidate validation/network handoff. The final C3 stack review removes
recursive handler dispatch; the compiled configure frame is2176B rather than
nested3632B frames. NVS holds ordinary application secrets, not encrypted storage
at rest; transport and cloud encryption are separate properties.

## Replay window and resource bounds

The rule in [`relay/emqx-cloud/rule.sql`](../../relay/emqx-cloud/rule.sql) emits
exactly `username,topic,qos,retain,payload_b64,published_at_ms`. The timestamp comes
from broker `timestamp`, not device payload. Require that six-field contract:
the old prototype's five-field envelope is not a production fallback.

The gateway rejects events more than120s old or10s in the future before DO
allocation and before reservation. A DO stores latest RPC/op/hash and publication
time for at most64 **active-window** boots, retiring only records older than130s.
This replaces the prototype's lifetime64-boot limit. It retains strict duplicate
checks throughout the accepted replay window without permanently rejecting a
legitimate device's65th lifetime reboot. Existing v1 guard state migrates
conservatively to v2 while preserving counters/high-water marks. A rollback must
retain code compatible with v2 state; untouched prototype guard code is not a
safe rollback target.

Bounds remain8192B request,12288B webhook,2048B original API reply, one owner per
node,600 attempts/4MiB per minute. Registry authorization has a2s deadline, API
processing10s and return publication6s; the device's existing RPC wait is20s.
The HTTP action uses25s expiry. Return publication currently opens a bounded
one-shot MQTT/TLS connection; the device's connection remains persistent.

## Release and operations

- The new main Worker/frontend and additive D1 migration0007 are deployed. Existing
  administrator/R2/D1 settings and the previously accepted upload path are kept.
- All16 device identities pass actual broker TLS/login, allowed own-topic
  operations and denied cross-topic/forged-reply operations. The dedicated reply
  account passes its separate publish-only checks. The official production API
  verified all16 pool records; assigning one to the existing C3 leaves15 ready
  and1 assigned. The original node and backup HTTP credential are retained.
- The generalized six-field rule is saved and survives reload, with the original
  HTTP action available. SQL simulation preserves the original UTF-8 bytes in
  Base64 and adds a broker-owned integer timestamp. The dynamic production
  gateway with named service binding is deployed. Device receipt acceptance
  remains a separate gate.
- Physical USB migration exposed an outer controller guard that still rejected
  nested MQTT objects before reaching the provision parser. The first candidate
  was rejected as `invalid_json` and not saved; correct that narrow boundary and
  cover the actual USB→provision path before repeating hardware acceptance.
- CI checks app tests, gateway protocol/real workerd RPC, firmware host ownership,
  browser enrollment and legacy ingestion. The main Worker deploys before its
  named-entrypoint gateway. `CLOUDFLARE_MQTT_ROLLOUT_READY=true` enables automatic
  gateway deployment only after initial broker/rule bootstrap is complete.
- The master key and gateway secrets are injected privately, never through
  committed configuration or CLI values. Preserve existing secrets during
  deployment; never replace the master key casually, because existing ciphertext
  is bound to it. Plain CSV exports, Flash backups and captures stay ignored.
- [`firmware/certs`](../../firmware/certs/README.md) contains a verified public CA
  certificate and provenance. DigiCert explicitly permits root use/distribution
  without a special license. No private key or device password belongs in Git.

Local browser acceptance uses synthetic peers; actual Worker/D1/R2 and named
service-binding tests are separate. `seed-mqtt-browser-fixtures.mjs` is an
explicitly enabled **local-only synthetic** fixture helper; it never contacts a
broker or supports a remote mode. Its ready rows are not real broker verification.

Current accepted C3 production source builds to1583248B before any later source
revision; the selected build SHA and actual protected app-only write/physical
run must be recorded separately. Preserve Passport's3MiB application partition,
`cardid` at0x356000 and Flash journal; never whole-chip erase or flash a padded
merged image. Other physical boards/driver profiles still require their own
verification. Existing registry labels alone do not verify board hardware.

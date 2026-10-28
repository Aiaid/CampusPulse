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
  is verified separately below.
- Physical USB migration exposed an outer controller guard that still rejected
  nested MQTT objects before reaching the provision parser. The first candidate
  was rejected as `invalid_json` and not saved. Commit `b5e5e4e` fixes that narrow
  boundary, retaining duplicate-key, array/depth and scalar-type guards. ASAN/
  UBSAN now runs the real USB controller→provision parser and confirms all four
  MQTT fields reach candidate submission unchanged; malformed nested input and
  broker/schema-invalid values remain rejected. The corrected physical write
  and network-validated settings-v3 save are accepted below.
- CI checks app tests, gateway protocol/real workerd RPC, firmware host ownership,
  browser enrollment and legacy ingestion. The main Worker deploys before its
  named-entrypoint gateway. `CLOUDFLARE_MQTT_ROLLOUT_READY=true` enables automatic
  gateway deployment only after initial broker/rule bootstrap is complete.
  That repository variable is now true after actual bootstrap/device acceptance.
  The old `DEVICE_MAP` secret is removed; only the webhook key and scoped reply
  username/password remain in the gateway. No device upload token is stored there.
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

## Actual C3 release and recovery acceptance

Selected firmware source: `b5e5e4e0b02f17c662e5896f35fe9c18f50f014f`,
image version `mqtt-b5e5e4e0b02f`, app1574224B, SHA256
`7d0cb0ccf2e14a94ad8add968c8ebcfbe3d7f5004db6a34944d799cd4469c1a7`.
The real ESP32-C3/8MiB board has no PSRAM. Separate bootloader, partition and app
images are produced; only the app at0x10000 is written. A fresh full8MiB backup
and digest comparison precede each write, and full Flash matches the expected
app-only change before boot, preserving NVS, `cardid`0x356000 and the journal.
The first USB-boundary failure and its superseded image are retained privately.

The official admin UI/WebSerial confirmed the existing factory identity and
assigned its independent MQTT identity after user reauthentication. The final
physical write uses the same USB protocol through a local CLI, reusing the saved
HTTP credential and original Wi-Fi. It is not claimed as a browser write of the
new image. The device validates the cloud path before atomically saving
settings-v3. Actual production D1 and the admin page report this exact image
version, the same observed boot and applied configuration. No node recreation or
HTTP credential rotation occurs.

Two separately recorded observations pass303.735s active BLE collection and
121.630s same-boot recovery; there is an observation gap between phases. The
final boot counter is11148 received reports. All114 observed RPCs reuse the
MQTT connection:112 return200, one returns the preserved old-boot422, and one
new upload times out after20019ms. Successful warm RPC median1958.5ms,
nearest-rank p95 2341ms and maximum4496ms include the gateway, API and reply leg;
these are not broker-only timings or guaranteed latency bounds.

The transient timeout raises pending1→6; automatic same-boot retry drains it to1.
The recovery phase adds no further upload failures. Final free heap52748B,
largest block32768B; observed RPC/pipeline minimum free heap48448B and largest
block32768B are sampled values, not a full cold-handshake low-water measurement.
Allocation-failure count remains0. Callback/input, window, summary, raw, storage,
seal-overflow and ACK-failure counters remain0; seal wait peaks5371ms and
persistence266ms. The collector is running without memory/pressure pause at the
end, and the device remains collecting after the observer exits.

A following read-only D1 snapshot at2026-10-29 07:20 China time confirms85
current-boot batches:17 windows,51 address-summary batches/272 summaries and17
status samples, with applied configuration and matching observed boot/version.
That snapshot is later than the bounded observations. It reports one upload
failure and zero new unpersisted-window reports, window/summary/storage/ACK
losses. These durable CF rows and the device's validated receipts are separate
from broker PUBACKs.

Limits remain explicit: the unchanged16-address policy reports4564 address-table
overflow reports in that snapshot. The preceding overnight boot also recorded
201060 address overflows,463 unpersisted-window reports,1 dropped window and16
dropped summaries. Preserve that older evidence; the new bounded result does
not erase it or prove radio completeness, lossless operation or recovery under
long disconnections. The original historical422 batch is retained unchanged.
Other physical boards/driver profiles still need their own verified firmware
upgrade and acceptance; existing registry labels do not verify board hardware.

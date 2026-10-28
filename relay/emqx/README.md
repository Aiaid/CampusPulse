# Local EMQX MQTT/TLS verification bridge

This bridge runs on the operator's Mac for the native device → EMQX MQTT/TLS →
existing Cloudflare API trial. It is **not a domestic durable relay**. EMQX
PUBACK only confirms MQTT delivery to the broker. The bridge's SQLite state is
local audit/restart state, not a device receipt. A successful application reply
comes only from the unchanged Cloudflare response; firmware must validate that
response's existing durable receipt before releasing any frozen batch. When CF
is unreachable this bridge cannot issue a successful acknowledgement.

The implementation has synthetic mock HTTP/MQTT host tests only. This directory
does not create resources, set budgets/ACLs, download certificates, deploy a
service, subscribe to a real broker, or contain usable credentials. Production
and hardware acceptance are independent work.

## Wire contract

- Device native MQTT 3.1.1 over TLS, broker FQDN on TCP **8883**. Paho handles
  standard MQTT framing for the relay connection. No WSS or insecure TCP mode.
- Device requests: QoS 1, non-retained,
  `cp/v1/<node>/<boot>/req/<op>/<rpc>` with original frozen JSON bytes.
- Relay replies: QoS 0, non-retained, corresponding
  `cp/v1/<node>/<boot>/rep/<op>/<rpc>`. Payload is **two-byte big-endian HTTP
  status + unchanged original response body**, with no wrapper or reserialization.
- Node is `[a-z0-9_-]{1,15}` from the private allowlist. Boot is lowercase UUIDv4.
  RPC is canonical decimal uint32, nonzero and increasing within a transport boot.
- `config` body is empty. `contact` / `activation` JSON boot must match the topic.
  Ingest's `node_id` must match the allowlist node, but a frozen ingest batch may
  belong to an **older boot than the current transport topic**. Its body and hash
  remain unchanged. Full payload/schema/receipt validation stays in the CF API.
- The relay subscribes to each allowed node's `cp/v1/<node>/+/req/+/+` only.
  It never subscribes to responses or a general `#` namespace.

| Operation | Fixed upstream method/path |
| --- | --- |
| `contact` | `POST /api/v2/device/contact` |
| `config` | `GET /api/v2/device/config` |
| `activation` | `POST /api/v2/device/config/ack` |
| `ingest` | `POST /api/v2/ingest` + `X-Body-SHA256` of original bytes |

The origin is hardcoded to `https://pulse.anend.net`. There is no configurable
origin, client URL, incoming-header forwarding, ForwardAuth, or payload token.
Only the private node → existing CF token mapping supplies the HTTP Bearer
header. That token is never used as MQTT username/password or added to MQTT
messages. Redirects are returned as their original non-success HTTP response;
the relay never follows them or forwards credentials to their target.

HTTP status/error JSON, including 401/403, 409/422 and 5xx, remains unchanged.
401/403 also blocks further forwarding for that node until relay restart after
the operator reviews credentials. Transport failure, total deadline, compressed
response or response overflow yields status 504 with exactly
`{"error":"gateway_outcome_unknown"}`. It never means rejection/rollback or
successful custody: CF might have committed before the reply was lost. Retry
the exact frozen batch through the existing idempotent API.

## Duplicate handling and bounds

The standard broker's relay-facing MQTT packet ID and DUP bit do **not** identify
the original device publish. They cannot supply the direct-WSS gateway's packet
ID duplicate checks. This bridge instead persists `(node, topic boot, latest RPC,
operation, SHA-256, exact body)` in SQLite. Changed same-number and older RPCs
fail closed. A matching request while in flight produces no second HTTP call.
An exact retry of the latest completed/interrupted RPC calls CF again so CF
supplies the authoritative idempotent receipt. **Config replies are never cached**:
even exact duplicate config RPCs fetch a fresh upstream lease.

| Resource | Bound |
| --- | --- |
| Allowlisted nodes | 16 |
| In-flight / queued work per node | 1 |
| Concurrent CF workers | 1–8 (default 4) |
| Waiting queue | 1–64 (default 16) |
| Cross-thread callback admission | queue size + worker count |
| Pending QoS0 relay reply packets | queue size |
| Request body | 8192 bytes |
| Original response body | 2048 bytes (2050-byte status envelope) |
| CF overall deadline, including body | 1–15 seconds (default 15) |
| Per-node valid RPC attempts / body bytes per minute | 600 / 4 MiB |
| Journal latest RPC rows | 64 topic boots per node; 1024 total |

The journal stores only the latest request/response for each topic boot, replacing
older RPC detail. Reopening marks interrupted `pending` rows `outcome_unknown`,
never successful. There is no automatic boot eviction: reaching a limit requires
an operator decision; do not delete audit state during a retry. Config/auth/rate
state is process-local; monotonic RPC hashes and exact bodies survive restart.
An exclusive journal lock prevents two runners from sharing that journal.
Queue/rate/identity/RPC rejections receive no fabricated application receipt;
the device retains its frozen data and times out/retries. The relay's subscriber
PUBACK is independent of device-to-broker PUBACK and grants no custody semantics.
QoS0 replies can be lost; exact retries intentionally reach CF again.

Paho parses broker packets before application body checks. Its MQTT 3.1.1 client
has no negotiated MQTT 5 maximum-packet bound. A hostile/misconfigured broker can
therefore allocate a larger receive buffer before this bridge rejects the body.
Before the real trial, set the broker's supported packet/body limits and trusted
ACLs; application queue bounds are not a broker-wide memory/DDoS defense.

## Private configuration and local commands

Use `config.example.json` only as a **synthetic schema example**. Every broker,
account and node value in it is invented; `.example.invalid` cannot be a real
broker. The CF origin is intentionally absent because it cannot be overridden.

Create a private directory/file outside tracked source and set mode 0600 on the
configuration. The process refuses non-0600, wrong-owner, linked and symlinked
secret config files. The SQLite file also requires mode 0600 and a user-owned
parent directory that is not writable by group/others. Prefer a dedicated 0700
directory. Local config/SQLite files are ignored, but do not rely on Git ignore
as the only secret boundary.

```sh
cd relay/emqx
uv sync --frozen --group dev
uv run --frozen pytest -q
uv run --frozen ruff check .
uv run --frozen ruff format --check .

# After privately copying/editing the synthetic example and chmod 600:
uv run --frozen cp-emqx-relay --config /absolute/private/path/relay.json --check
# Only after broker credentials and ACLs have been independently reviewed:
uv run --frozen cp-emqx-relay --config /absolute/private/path/relay.json
```

`--check` checks config permissions/schema and constructs the verified broker TLS
context only. It does not open the journal, resolve DNS, connect, subscribe or
prove broker/CF reachability. SIGINT/SIGTERM stops the real runner. Interrupted
requests remain uncertain for restart/retry.

Required fields are `broker_host` (FQDN), `mqtt_username`, `mqtt_password`, `nodes`
(node → existing CF token), and `journal_path`. Relative journal/CA paths resolve
against the config file's directory. Optional `broker_port` must be 8883;
`workers`, `queue_size`, `timeout_seconds` use the bounds above. Unknown keys and
duplicate JSON keys are rejected. Reusing the CF token as broker username or
password is rejected. Private configurations never appear in CLI arguments as
values, logged objects or exception messages.

Optional `ca_file` adds an operator-downloaded PEM broker CA to system trust.
Download/verify the CA through the provider's official console/documentation
separately; this bridge does not fetch certificate URLs. TLS always verifies the
chain, hostname and SNI against the configured broker FQDN, with TLS 1.2 minimum.
There is no skip-verification setting. CF independently uses verified system
TLS. Optional `cf_proxy` accepts an explicit HTTP/HTTPS proxy URL for the CF leg
only (for example an operator's loopback proxy); it never changes broker routing
or disables CF certificate/hostname checks. HTTPX proxy environment variables
are ignored; TLS uses Python/OpenSSL's default system trust configuration.
Default CF routing is direct.

Logs contain static event enums only: no payload, topic, node/boot, username,
password, token, headers, receipt IDs or network exception details. Inspect the
private SQLite journal only through a deliberately private audit workflow; do
not upload it or print its exact contents into shared logs.

## ACL plan before any real connection

The relay cannot observe the original publisher's authenticated username after
EMQX delivers its publication. **Node authorization therefore depends on broker
ACL enforcement**, not topic syntax alone. Do not enable this bridge with a
broker-wide shared username permitted to publish other nodes' requests.

For each controlled node, create an independent device MQTT identity with only:

- Publish QoS1 non-retained to `cp/v1/<that-node>/+/req/+/+`.
- Subscribe to `cp/v1/<that-node>/+/rep/+/+`, receiving QoS0 responses.
- Deny publishing `/rep/`, subscribing `/req/`, other nodes, `$SYS`, and all
  unlisted topics. Disable retained request writes/reads where broker controls
  support it; the relay also rejects retained deliveries.

Give the separate relay MQTT identity only the reverse rights, expanded over
the exact private allowlist: subscribe `/req/` and publish QoS0 non-retained
`/rep/`. Deny other topics. Give it no broker administrative role. Confirm actual
provider ACL wildcard/deny semantics and test cross-node rejection before the
physical trial. This README is an ACL plan, not a claim those rules exist.

Real acceptance should establish the authorized zero consumption limit and
broker ACLs first, then verify subscription, controlled native TLS delivery,
unchanged CF receipt, CF outage/no-success behavior and exact retry after reply
loss. Domestic durable custody requires a separately designed domestic durable
store/queue and a distinct relay receipt; neither this Mac nor EMQX PUBACK fills
that role. No paid resource creation or spending authorization is implied.

## Offline batch provisioning (first automation step)

Each device needs its own MQTT identity, but those accounts and scoped rules can
be prepared in a batch. This local tool generates reviewable import material;
it makes no network calls, reads no existing credentials or observations, and
does not create broker accounts or apply ACLs. Run it from this directory with
an existing user-owned parent that is not writable by group/others:

```sh
# Create the private parent once; choose a new bundle directory for each batch.
mkdir -m 700 "$HOME/campuspulse-mqtt-private"
uv run --frozen python -m cp_emqx_relay.provision \
  --nodes node1,node2 \
  --relay-username relay1 \
  --out-dir "$HOME/campuspulse-mqtt-private/batch-001"
```

`--relay-username` is optional. Identities must match `[a-z0-9_-]{1,15}`;
duplicate nodes, a relay/device username collision, and more than 16 nodes are
rejected. Devices use their node ID as username. Every identity receives an
independent random 256-bit URL-safe password. These are broker credentials;
the tool has no Cloudflare token field and never substitutes a device API token.

The new directory has mode 0700 and every generated file has mode 0600:

- `authentication.csv`: `username,password` import material.
- `authorization.csv`: `username,topic,action,access` scoped rules, using
  `pub`/`sub` and `allow`, followed by a `pubsub` deny on `#` for each generated
  username only. Each device can publish its request topics and subscribe
  to its reply topics only. The optional relay has the reverse rights over the
  listed nodes only, with no broker administrative role.
- `device-<node>.json` and optional `relay-credential.json`: private runtime
  provisioning material containing MQTT username/password. These are inputs for
  a future reviewed provisioning workflow, not firmware source constants or a
  claim that a firmware NVS provisioning API exists.
- `manifest.json`: node IDs and credential file paths, without password values.
  It is written last; a partial directory without this file must not be imported.
- `authorization-plan.json`: non-secret, explicitly **not applied** plan for
  per-user fallback, precedence review and negative acceptance. No All Users
  rule is generated or changed; existing unrelated clients are outside scope.

Stdout contains only counts and the bundle directory path. Keep the whole bundle
outside source control and shared logs, including the CSVs. Symlink paths and
unsafe/foreign-owned parents are refused. Existing output paths, including empty
directories, are always refused: rerunning cannot overwrite or rotate keys.
There is no incremental registry yet. For additional devices, use a new directory
and list **only new node IDs**; omit `--relay-username` when retaining the current
relay account. Review new-node ACL additions for that existing relay separately.
Generating an old username in a different directory produces a different key;
do not import it as an update unless credential rotation was explicitly intended.

Before any real import, download the current deployment's authentication and
authorization templates and compare fields/values with these files. The formats
follow EMQX Cloud's [default authentication](https://docs.emqx.com/en/cloud/latest/deployments/default_auth.html)
and [default authorization](https://docs.emqx.com/en/cloud/latest/deployments/default_authz.html)
documentation, but no CSV import or deployment API call has been tested by this
tool. Review each username's final deny rule, conflicting broad rules, ordering,
QoS/retain limits, and cross-node rejection before using a generated identity.
Later, deployment-level API automation can batch account and ACL creation under
one explicit authorization after verifying the deployment's API capabilities.
This does not depend on [external HTTP authentication](https://docs.emqx.com/en/cloud/latest/deployments/http_auth.html),
which EMQX Cloud Serverless does not support.

## Provenance

Bridge code is newly authored. Wire bounds/fixed paths follow the repository's
[`cf-mqtt` protocol](../cf-mqtt/README.md) and existing CF v2 API; no legacy
backend, credentials, captures, certificate bundle or MQTT parser source is
copied. Dependencies are pinned in `pyproject.toml` and `uv.lock`: Eclipse
Paho MQTT 2.1.0 (EPL-2.0 OR BSD-3-Clause) and HTTPX 0.28.1 (BSD-3-Clause). Their
licenses remain in their installed distributions; no third-party source is
vendored. Repository-level reuse indexing is handled alongside the integration.

- [Paho client API](https://eclipse.dev/paho/files/paho.mqtt.python/html/client.html)
- [Paho PyPI release](https://pypi.org/project/paho-mqtt/2.1.0/)
- [HTTPX PyPI release](https://pypi.org/project/httpx/0.28.1/)
- [HTTPX environment configuration](https://www.python-httpx.org/environment_variables/)

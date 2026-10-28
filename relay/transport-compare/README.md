# Same-host HTTPS and native MQTT-TLS listeners

This bounded synthetic LAN harness uses Node 24 and Aedes 1.2.0. It creates no
cloud resources and forwards nothing. [Firmware workload and interpretation](../../firmware/diagnostics/transport-compare/README.md).

Install dependencies outside the repository; do not change root packages:

```sh
npm install --prefix /private/tmp/cp-transport-deps --no-package-lock \
  --no-audit --no-fund aedes@1.2.0 mqtt@5.15.0
```

Create one external, mode-0600 JSON configuration. The example token below is
a placeholder; generate a fresh 32-byte random hex secret without logging it.
Use an explicit local physical interface IPv4 address for `host` and a leaf
certificate with that exact IP SAN. Both listeners use the same P-256 key,
leaf/chain and CA. Keep all referenced PEM files outside the repository and
mode 0600, including the public diagnostic CA copy. Never include existing
production credentials or device identities in this configuration.

```json
{
  "host": "192.0.2.10",
  "httpsPort": 18443,
  "mqttPort": 18883,
  "token": "<64 lower-case random hex characters>",
  "epoch": 0,
  "caFile": "/absolute/private/ca.pem",
  "certFile": "/absolute/private/server-chain.pem",
  "keyFile": "/absolute/private/server-key.pem",
  "aedesModule": "/private/tmp/cp-transport-deps/node_modules/aedes/aedes.js",
  "freshSamples": 6,
  "reuseSamples": 10,
  "mqttFreshSamples": 3,
  "mqttWarmSamples": 10,
  "mqttDirectPublish": 0,
  "mqttOutSize": 1024,
  "cpuStats": 0,
  "budgetSeconds": 300,
  "bleWindowMs": 20,
  "wifiPs": 0
}
```

Replace `host` with the observed LAN address and `epoch` with current Unix
seconds. Firmware configuration rejects epochs more than 24 hours away from
build time. Counts may only be reduced from the defaults; budgets are 60–600
seconds for firmware and 30–600 for the server. Scan windows are exactly 20 or
50 ms. The server requires the bind address to exist on a local interface.

```sh
node relay/transport-compare/server.mjs /absolute/private/compare.json
```

Both listeners force TLS1.2 `ECDHE-ECDSA-AES128-GCM-SHA256`, P-256, strict
client-side CA/identity/date checking and disabled server session resumption.
HTTP accepts only authenticated POST `/benchmark` with exact 1024/8192 content
length, no chunked requests. MQTT accepts an authenticated synthetic
`bench-<32hex>` client, QoS1 publish only to `probe/<its-client-id>/data`,
and QoS1 subscription only to `probe/<its-client-id>/ack`. Wildcards, another
client's topics, retained messages, client-published ACKs and `$SYS` topics are
denied. A malformed pattern receives no application receipt. Failed subscription
grants are SUBACK128 and must not be treated as successful subscription.

The server returns the same eight-field length/SHA-256 application receipt
after checking the entire deterministic synthetic body. Its
`kind=transport_received` is RAM receipt only. MQTT PUBACK remains a separate
broker event. Nothing here claims persistent storage or cloud ingest.

Each listener caps live connections at four; both share a four-connection
tracking cap and 128 lifetime connection attempts. Sockets expire after 15s
idle; handshakes, HTTP headers and request handling are bounded. MQTT frames
are capped at 8400 bytes before Aedes parsing, with only 1024/8192 payloads
authorized. The process stops at the configured lifetime or SIGINT/SIGTERM,
destroys its own sockets and emits numeric counters only. No library exception,
token, body, network identifier or certificate path is logged. These limits
serve a trusted controlled LAN experiment, not an Internet-facing broker.

Official API references checked for this implementation:
[Aedes broker/auth/ACL API](https://github.com/moscajs/aedes/blob/main/docs/Aedes.md),
[ESM createBroker example](https://github.com/moscajs/aedes/blob/main/docs/Examples.md).
Aedes is MIT licensed and remains in the temporary dependency prefix. The
`mqtt` package is used only by host tests, not the diagnostic runtime.

Host validation uses loopback and generated temporary certificates, never the
device or production configuration. It tests socket reuse, matching receipts,
MQTT QoS1/SUBACK1, failed wildcard SUBACK128, untrusted CA failure, and payload
and frame bounds. It does not establish hardware performance or BLE acceptance.

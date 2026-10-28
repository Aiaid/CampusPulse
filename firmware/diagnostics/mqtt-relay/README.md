# Temporary MQTT/TLS relay diagnostic

This independent ESP-IDF **5.5.3 / ESP32-C3** project tests one managed MQTT/TLS
broker and its trusted serverless HTTPS relay to CampusPulse. It is synthetic:
BLE, UI, raw observations, production journal, and journal reclamation are absent.
It reuses the LAN diagnostic's read-only saved-network bootstrap and protected
Passport partition table. It does not initialize or modify ordinary saved NVS,
`cardid`, `cpqueue`, bootloader, or partition bytes. NVS recovery writes are
blocked by a lifetime-long read-only partition descriptor; Wi-Fi storage is RAM,
PHY NVS calibration storage is disabled, and an initialization error aborts.
Saved PEAP authentication policy remains independent of strict MQTT TLS checks.

No provider root AccessKey, Cloudflare node bearer token, or real observation
belongs on this device. Device-only MQTT username/password and exact topic ACLs
must come from the managed service. Server bindings select the fixed node,
Cloudflare authorization, URL and reply topic using authenticated broker
principal plus inbound topic. Those fields are never device-controlled envelope
fields. Verify this server/broker binding independently before using this probe.

## Private configuration

Create the JSON file **outside this repository**, permissions `0600`. Do not pass
passwords in CMake `-D`, shell arguments, UART or issue text. All paths below are
examples, not working credentials:

```json
{
  "broker_uri": "mqtts://broker.example.invalid:8883",
  "client_id": "dedicated-synthetic-probe",
  "username": "DEVICE_ONLY_PLACEHOLDER",
  "password": "DEVICE_ONLY_PLACEHOLDER",
  "ca_file": "/private/tmp/probe-ca.pem",
  "request_topic": "probe/request",
  "reply_topic": "probe/reply",
  "unix_time": 1793145600,
  "synthetic_node_id": "cp_demo000000001",
  "deadline_ms": 120000
}
```

Use the current UNIX time, within one day of configuration. This is an
operator-supplied diagnostic clock, not an authenticated production time anchor.
The public CA chain must verify the broker DNS hostname and date. No insecure
TLS, skip-name/date checks, IP substitution, or private keys are supported.
The URI must contain no username/password, query or application path.

For optional synthetic ingest, additionally supply `body_fixture_file` pointing
to the exact serialized **v2** fixture (1..8192 bytes), with root `dataset:"demo"`
and `node_id` equal to `synthetic_node_id`, plus `expected_ack`:

```json
{
  "node_id": "cp_demo000000001",
  "boot_id": "00000000-0000-4000-8000-000000000001",
  "batch_id": "00000000-0000-4000-8000-000000000002",
  "stream": "node_status",
  "body_sha256": "SHA256_OF_THE_EXACT_FILE_BYTES",
  "accepted_count": 1,
  "durability": "committed"
}
```

The generator checks dataset, node/boot/batch/stream identity, exact-file SHA and
expected count equal to `items.length`. Broker connection strings and credentials
must be printable ASCII (maximum 1024 characters). The main operator must verify the configured demo node
is correct and that the file contains only synthetic values;
the dataset label alone does not sanitize a capture. The fixture is never
reserialized, and its base64/SHA are computed directly from file bytes. The
frozen request UUID and envelope remain unchanged across all retries in one run.

## Prepare and build

The standard-library Node generator writes only the private build header; it
prints no credentials, topic, address, body, hash, or private file contents.
The generated header and app image contain MQTT credentials. Keep **all build
outputs private**, never commit/upload them, and remove them when no longer
needed. Only the path to the configuration is cached by CMake.

```sh
cd firmware/diagnostics/mqtt-relay
uv run --no-project --python "$IDF_PYTHON_ENV_PATH/bin/python" \
  "$IDF_PATH/tools/idf.py" -B build \
  -DCP_MQTT_CONFIG_FILE=/private/tmp/private-mqtt-probe.json build
```

Set the installed ESP-IDF 5.5.3 toolchain environment first. Use a fresh
build/sdkconfig for this independent project. A passing build is not
hardware validation. This project supplies no flashing automation: the main
operator must verify the actual board/port, full backup and its digest, factory
partition at **0x10000 with size 0x300000**, protected `cardid` at **0x356000**,
and the real Flash layout before any temporary application-only write. Never
use `idf.py flash`, erase-all, or a padded merged image. Back up before testing,
restore the saved application afterwards, and verify all protected regions and
restored boot separately. Do not assume an earlier serial path still identifies
the same physical board.

## Protocol and interpretation

The firmware sends exactly the five-field
`campuspulse-mqtt-relay/1` envelope: `protocol`, UUIDv4 `request_id`, `op`,
canonical RFC4648 `body_base64`, and lowercase `body_sha256`. It verifies the
matching subscription packet ID and broker's single granted QoS1 byte before
enqueueing the QoS1 health request; a denied or downgraded subscription is counted
and does not permit publishes. Optional ingest follows only
after a verified 200 health response. Requests are retried at most every 15s,
preserving exact bytes. The SDK has a bounded 40KB outbox, a 1024-byte I/O buffer,
and manual reconnect scheduling within the test budget. The 8KB fixture bound
leaves substantial room below the domestic broker's envelope limit.

Replies must match protocol/UUID/op/request SHA, contain exactly the defined
upstream-response or relay-error fields, decode as canonical base64, and have
the exact decoded response SHA. Retained replies are rejected. Duplicate JSON
keys, embedded NUL, excess nesting, trailing bytes, oversized and misordered
fragments are rejected. The 18KB envelope buffer holds a 12KB HTTP response plus
base64/correlation overhead. Incoming overflow/busy/invalid counters expose
discarded responses; application retry remains the recovery mechanism.

`qos1_pubacks` measures broker acknowledgement only. A verified 200 health body
must report `status:"ok"` and `ingestion:"implemented"`. A 200 health response is
network-path evidence only; it never proves durable ingest. Ingest verification
also requires the exact current nine-field committed Cloudflare ACK schema:
expected node/boot/batch/stream/body SHA/count/durability, nonempty bounded
`receipt_id`, and valid UTC millisecond ISO `received_at`. This diagnostic does not reclaim
data, even on a verified ACK. The fixture bytes and UUID persist in memory until
reset. `relay_errors`, `upstream_failures` and rejected replies are separate.

The default **application test** is cooperatively bounded to 120s including
saved Wi-Fi startup (configurable 10..120s), and exits earlier on verified probes.
UART emits only synthetic operation labels, numeric counters, timing, heap and
numeric TLS errors; vendor logs are disabled. Reset reason is emitted at boot.
An unavailable reply is a failed/censored probe, not a latency measurement.

At completion the firmware prints `idle=1`, `runtime_retained=1`,
`application_requests_stopped=1`, `reclaimed=0`, and `auto_restart=0`. It never
calls MQTT stop/destroy or automatically resets. **The retained SDK runtime may
continue MQTT keepalives and retransmit already queued QoS messages** until the
operator resets/restores the device. Wi-Fi may also retain its runtime. This
avoids claiming a clean teardown or reinitialization based on the earlier BLE
cleanup experiment. There is no BLE load or radio-completeness acceptance here.

## Source provenance and validation

`saved_wifi.c` and `partitions.csv` reuse repository-owned
`firmware/diagnostics/https-lan`; ACK parsing concepts follow repository-owned
`firmware/components/cp_network/protocol.c`. MQTT API fields are checked against
the locally installed official ESP-IDF 5.5.3 `mqtt_client.h`. No private upstream
source, SDK modifications, or production dirty source edits are included.
The parent session performs the actual build, hardware run and restore; this
subtask does not claim those outcomes.

Generator checks can be run with `node --test tools/configure.test.mjs`.

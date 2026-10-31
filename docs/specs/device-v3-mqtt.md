# Device V3 over the existing native MQTT gateway

Status: **native MQTT gateway deployed, with bounded concurrent two-board
production acceptance recorded in the pre-retirement release.** See the
[production release](../notes/v3-production-release-2026-10-31.md) and
[V3-only migration](../notes/v3-only-migration-2026-10-31.md). The current path is
device MQTT/TLS → existing Hangzhou EMQX → authenticated Cloudflare gateway →
`MqttDeviceApi` → V3 control/statistics modules. No Mac proxy is used. The
V3-only source retirement adds no new physical-device acceptance.

This transports [V3 control](device-v3-control.md) and
[small statistics](v3-small-statistics.md). It does not enable raw, per-address or
historical V3 feature ingestion. New active policies select `mqtt_tls`; original
HTTPS policies and frozen bodies retain their original authority and receipts.

## Topics and frozen frame

Requests use the already permitted topic shape:

```text
cp/v1/<namespace>/<current_boot_uuid>/req/ingest/<rpc_uint32>
```

Replies replace `/req/` with `/rep/`. The namespace is the existing broker
registry namespace; the topic boot is the current connection boot, including
when recovering work frozen under an earlier boot. RPC numbers are decimal
integers from 1 through 4294967295, without leading zeroes. Requests use QoS 1,
non-retained messages; replies preserve the existing non-retained QoS 0 path.
Delivery is at least once. Only a complete, matching durable server receipt
authorizes device queue reclamation.

The MQTT payload is an eight-byte header followed immediately by the original
frozen JSON request bytes:

| Byte offset | Value |
| --- | --- |
| 0–3 | ASCII `CPV3`, hex `43 50 56 33` |
| 4 | Frame version `01` |
| 5 | Suboperation from the table below |
| 6 | Flags: bit 0 is receipt-only; all other bits must be zero |
| 7 | Reserved, must be zero |
| 8 onward | Original JSON bytes; empty only for configuration GET |

| Suboperation | Existing V3 operation | Body and boot binding |
| --- | --- | --- |
| 1 | Capability registration | Original registration JSON; nested `capabilities.node_id` belongs to the registry node and nested `boot_id` equals the topic boot |
| 2 | Configuration GET | Zero body bytes; the gateway supplies the topic boot as the existing `boot_id` query parameter |
| 3 | Configuration ACK | Original ACK JSON; live body boot equals the topic boot |
| 4 | Capture-lease renewal | Original lease JSON; live body boot equals the topic boot |
| 5 | Compact statistics/status ingest | Original compact JSON; `n` belongs to the registry node; original body boot `o` may differ from the topic boot |

Flag bit 0 is valid only for suboperations 3 and 4. In that mode, an original
old-boot body is allowed, but the control module returns only its already
committed, exact ACK/lease receipt. An absent receipt returns
`409 v3_receipt_not_committed`; it cannot create an ACK, lease or capture span.
Suboperations 1, 2 and 5 reject this flag. CPV3 framing is mandatory: unframed
legacy JSON and malformed/truncated frames are rejected, with no legacy handler
fallback. The frame is accepted only on the existing `ingest` topic operation;
retired device operations are rejected. The `cp/v1` prefix is a stable topic/ACL
namespace, not payload-version negotiation or V1/V2 compatibility.

Original JSON whitespace, order, UTF-8 and bytes are preserved. The relay parses
only to validate framing/JSON shape and never serializes the body again. The
backend applies its normal duplicate-key, privacy, mathematical, time, policy,
boot and source-authority validation to the original unwrapped bytes.

## Bounds and reply

| Boundary | Limit |
| --- | ---: |
| Original V3 JSON body | 8192 bytes |
| Framed V3 request payload | 8200 bytes |
| Existing broker webhook JSON | 12288 bytes |
| V3 configuration reply JSON | 8192 bytes |
| Other V3 reply JSON | 2048 bytes |

The reply retains the existing two-byte unsigned big-endian HTTP-style status,
followed by the exact backend JSON response. The two-byte prefix is additional
to the limits above. Oversized responses fail explicitly; no policy or receipt
is truncated. A timeout or gateway acknowledgement is not proof of rollback or
durable source custody. Retry the exact frozen request to obtain its original
committed receipt.

## Principal and replay authority

The webhook's existing authentication proves the broker source. The gateway
resolves the broker username and topic namespace through the existing MQTT
registry and forwards through the private `MqttDeviceApi` service binding.
The private dispatch shape retains the existing operation `ingest` and adds
`v3:{subop,receiptOnly}` beside the unwrapped `Uint8Array` body. These fields are
validated again at the backend; public HTTP headers cannot select this principal.

The principal requires an assigned, verified registry mapping whose node is
enabled. Both nested and compact payload node ownership must match that mapping.
Mandatory SQL authorization assertions reach the internal authenticated V3
control/statistics handlers and are rechecked in final D1 write transactions and
receipt reads. Revocation or reassignment cannot authorize a late successful
commit from an earlier registry lookup.

The Durable Object's RPC digest and byte accounting cover the **whole wire
payload**, including suboperation and flags. Changing any header/body byte under
the same topic boot/RPC conflicts. An identical retry is forwarded again rather
than accepted from a cached outcome. The V3 custody hash covers only the
**original unwrapped JSON bytes**, preserving existing body digests and receipts
across transports and topic-boot changes.

Old frozen statistics may be delivered under their original successful policy,
boot, capture span, source expiry and acceptance deadline. The topic's newer
connection boot does not relabel observations or extend collection authority.
Receipt-only old control recovery likewise cannot renew old capture authority.
The authenticated HTTPS routes remain available with their original bearer
checks; no internal header bypass is added.

## Verification boundary

Relay tests cover framing, flags, size bounds, original-body forwarding,
header-inclusive RPC conflicts, reply limits and real workerd/DO retry behavior.
Backend tests exercise actual relay/DO/service binding/D1 capability/config,
ACK/lease, old-boot receipt-only recovery, MQTT and original-HTTPS authority,
statistics/status custody, public isolation and registry revocation. Separate
SQLite tests inject registry changes immediately before commits and verify
rollback. V3 HTTPS authority remains covered independently; retirement tests
require V1/V2 device HTTP routes and unframed MQTT requests to be rejected.

These are synthetic software tests. Broker deployment, native device MQTT/TLS,
physical checkpoint/reboot recovery, concurrent three-window collection and
post-test legacy-queue preservation are recorded separately in the
[production release record](../notes/v3-production-release-2026-10-31.md).

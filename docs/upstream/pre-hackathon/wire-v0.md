> **赛前历史参考，迁入于 2026-10-23。** 下文的 current、implemented、测试通过与命令路径
> 全部属于旧原型，不描述新仓库现状。本轮未重跑测试、连接设备或重新核验外部规则来源。
> 原 Markdown：`specs/wire.md`；原文件 SHA-256：`5155ece4414fc288075ac8d2d13c75de19cf1f16a91bbed7fc337625c4dd98ab`。
> 原始代码和采集数据继续保留在本地，不随本文迁入。为适配新文档目录，仅更新了两处内部 Markdown 链接。
> 旧实现中的开发/运行命令只适用于旧原型目录。
> 新设计见[上传协议 v1 草案](../../specs/ingest-v1.md)；历史观察见[整理记录](observations.md)。

# BLE record and upload contract

Status: current BLE/telemetry source contract, reviewed 2026-10-14. This is a
source description; device/network acceptance is in the
[status matrix](observations.md). Operator/Passkey route scope is
summarized below; this document does not specify their full WebAuthn messages.

An 80-byte record uses little-endian numbers: magic `CPB1` at 0..3, random
boot session ID (uint32) at 4, per-boot sequence (uint32) at 8, monotonic
microseconds (uint64) at 12, UTC Unix milliseconds (uint64, zero until synchronized)
at 20, NimBLE address bytes at 28..33 (reverse for conventional display), address
type at 34, legacy report event type at 35, signed RSSI at 36, payload length at
37 (0..31), raw payload at 38..68 (zero padded), flags at 69 (bit 0 active scan,
bit 1 synchronized clock), reserved zero bytes at 70..75, IEEE CRC32 over bytes
0..75 at 76..79. Every received report is retained without duplicate filtering;
the scan response remains a separate report.

POST `/v1/ble/batch` with `Content-Type: application/octet-stream`, `X-Node-ID`
(12 hex characters from the board MAC), optional `X-Upload-Token`, and a body of
1..32 concatenated records. A successful transaction returns HTTP 200 JSON
`{"accepted":N}`. N includes identical duplicates already durably saved. Reject
corrupt, invalid, partial, oversized, or conflicting records without accepting
any part of the batch. The key is (node ID, boot ID, sequence). The receiver
commits before replying; the device ACKs only a 200 response with exact N.

Transport retry may duplicate records; the key makes repeated uploads idempotent.
The receiver stores the original binary alongside decoded fields, preserving
unknown AD payloads for later analysis. Local Flash may reclaim only completely
acknowledged sectors. Unsynchronized times are never presented as real UTC.

POST `/v1/status` uses the same node/token headers and `application/json` body
up to 4096 bytes. The receiver durably saves the original diagnostic object and
its reception time; HTTP 200 acknowledges it. Firmware sends a sample every
30 seconds when connected. This best-effort telemetry is not a durable queue.
GET `/v1/stats` reports deduplicated archive totals, per-boot gaps between observed
sequences, and latest node statuses. GET `/v1/export` streams JSONL, optionally
filtered with `node_id`. Health is GET `/health`; dashboard is GET `/`.

For public dashboard deployments, `CP_DASHBOARD_USER` and
`CP_DASHBOARD_PASSWORD` enable browser sign-in. Unauthenticated HTML entry
redirects HTTP 303 to `/login`; GET `/login` returns ordinary HTML with HTTP 200.
POST `/login` accepts username/password URL-encoded fields and exact same-origin
Origin, issues an 8-hour Secure/HttpOnly/SameSite=Strict `__Host-cp_session` cookie,
and redirects home. Wrong credentials stay on the HTML form. POST `/logout`
invalidates the session. Read endpoints accept sessions or explicit Basic CLI
credentials. Set `CP_PUBLIC_ORIGIN` to the HTTPS origin behind a TLS proxy.
`X-Upload-Token` then authorizes POST batch/status and device observations, not
archive reads or the
HTML entry. Browser credentials and sessions do not authorize device writes. Authenticated
operators can create manual observations and manage their Passkeys.
No endpoint sends `WWW-Authenticate`; API failures remain HTTP 401 JSON. Browser
sessions expire, are bounded to 256 entries and are invalidated on logout or
receiver restart. Login/logout reject missing/cross-origin Origin or mismatched
Host. Both browser credential variables must be nonempty together.
If both are absent, local legacy token-only demonstration behavior is retained.

## Additional route scope

| Route | Access and purpose |
| --- | --- |
| `GET /v1/vehicles` | Operator read; node and 60/300/900-second UTC comparison window |
| `GET /v1/observations` | Operator read; saved manual ranges and matching candidate windows |
| `POST /v1/observations` | Same-origin operator write; web manual range |
| `POST /v1/observations/device` | Device token and node header; durable, idempotent manual mark keyed by node/boot/event |
| `GET /v1/passkeys` | Operator read; enrolled credentials |
| `POST /v1/passkeys/register/{begin,finish}` | Same-origin operator enrollment; configured HTTPS origin required |
| `POST /v1/passkeys/revoke` | Same-origin operator revocation |
| `POST /v1/passkeys/login/{begin,finish}` | Public same-origin credential ceremony; successful verification issues a browser session |

Manual kinds are `e_bike`, `car`, `people`, `other`, with
`0 <= min_count <= max_count <= 1000`. Device windows are 60/300/900 seconds.
A device mark with unknown UTC is compared using the same node/boot monotonic
clock; receipt time is not substituted for capture time. Web ranges may use
explicit whole-second intervals of 1..86400 seconds. Source behavior is in
`receiver/observations.go` and `receiver/passkeys.go`. Candidate-address
aggregation is separate from physical counts and individual-report
classification; see the [vehicle rules](vehicle-rules.md).

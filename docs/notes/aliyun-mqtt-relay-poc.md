# Domestic managed MQTT / serverless relay proof of concept

Status (2026-10-28): local relay tests and diagnostic firmware compilation passed;
the domestic FC-to-Cloudflare health leg was measured successfully. The complete
device -> managed MQTT -> FC -> Cloudflare path is **not yet validated**. No
paid MQTT instance or trigger has been created, and no MQTT firmware was flashed.

## Implemented local artifacts

- [`relay/aliyun-mqtt/`](../../relay/aliyun-mqtt/README.md): a bounded exact-byte
  relay with server-controlled principal/topic/node/token/reply bindings.
- [`firmware/diagnostics/mqtt-relay/`](../../firmware/diagnostics/mqtt-relay/README.md):
  temporary C3 MQTT/TLS probe with read-only saved Wi-Fi, synthetic frozen bodies,
  separate PUBACK/application-reply counters and exact v2 receipt validation.
- A fixed-target FC network probe, without an HTTP trigger, privileged cloud
  credentials, production data or arbitrary destination support.

Fifteen relay/network-probe tests and six private-config generator tests passed.
The C3 build and separate-image/protected-layout checks passed using an explicitly
nonfunctional `.invalid` broker and fake credentials; the resulting image is
compile evidence only and must not be flashed as a working cloud configuration.
The build produced a 995,296-byte app, below the protected 3 MiB app limit.

## Verified cloud state and measurement

The configured Alibaba Cloud RAM identity was successfully authenticated.
Project-scoped FC listing worked in Hangzhou and found no existing matching
functions. The initial MQTT list returned `ServiceUnable`. The official free
message-queue service activation API was then invoked; a second MQTT list
succeeded and returned zero instances. No RAM permissions were changed.

An isolated 128 MiB / 0.05-vCPU Node.js 20 FC function was created in Hangzhou,
with no HTTP trigger and no reserved/minimum instance configuration. It made
three authenticated-invocation health probes to the fixed public endpoint
`https://pulse.anend.net/api/v1/health`:

| Sample | Verified upstream status | Function-side elapsed | Host invocation elapsed |
| --- | ---: | ---: | ---: |
| 1 | 200 | 1,023 ms | 1,440 ms |
| 2 | 200 | 430 ms | 519 ms |
| 3 | 200 | 440 ms | 502 ms |

These are **health connectivity** observations, not ingestion or durable batch
receipts. Three samples do not establish reliability, nationwide performance,
MQTT connection reuse, or a latency guarantee. Source, role and endpoint metadata
remain in ignored private captures; no account identifiers or AccessKeys are
recorded in this document.

The temporary network probe was deleted after measurement; a subsequent
GetFunction returned FunctionNotFound. Cleanup is recorded in the ignored
operation manifest.
The free message-queue service activation does not purchase an instance.

## Remaining gates

1. Select a currently purchasable managed MQTT edition/region and confirm the
   test spending limit. The published Serverless reference reserves 500 online
   connections and 5,000 subscriptions, with a Hangzhou example minimum of
   CNY 2.5/day even when idle, plus message traffic. Actual availability and any
   EventBridge/RocketMQ/FC dependency charges must be checked before purchase.
   The user requested a billing explanation instead of approving a spending
   limit; no paid instance purchase is authorized by that reply. At the cited
   reserved capacity, CNY 2.5/day is CNY 75 per 30-day month before message and
   other service charges. Device disconnection does not stop this reservation;
   deleting the instance ends later-day charges, with the deletion day's bill
   potentially issued on the following day. This is not a complete architecture
   quote or confirmation that this edition is currently purchasable for the account.
2. Issue per-device credentials and exact request/reply ACLs. A broker-reported
   client ID alone is insufficient when credentials permit arbitrary client IDs;
   other devices must not be able to publish requests or replies for this node.
3. Configure the real authenticated trigger/role and provider-specific event
   adapter. Do not expose an anonymous HTTP endpoint that trusts JSON fields
   claiming broker identity. IoT Platform and ApsaraMQ event formats differ.
4. Enforce the actual broker message limit, including base64/envelope overhead.
   The relay's 64 KiB HTTP cap is not a guarantee that such a body fits MQTT.
5. Verify the real reply publisher, synthetic health path and then isolated demo
   ingestion. Broker PUBACK, successful function invocation and relay publication
   must never substitute for a verified Cloudflare committed batch receipt.
6. Before any hardware test, verify the newly connected chip/port and Flash
   layout, make a fresh complete backup, write only the app and restore it after
   the temporary experiment. Previous serial-port/device assumptions are stale.

The old Alibaba IoT Platform documentation says new purchases stopped on
2025-02-01, so it must not be treated as an available new free-instance path.
This does not imply existing instances are unavailable. The current account
query did not find a reusable default-instance product.

Sources: [MQTT free activation](https://help.aliyun.com/zh/apsaramq-for-mqtt/mqtt-upgraded/getting-started/activate-apsaramq-for-mqtt-and-authorize-a-ram-user-to-access-apsaramq-for-mqtt-resources),
[Serverless MQTT billing](https://help.aliyun.com/zh/apsaramq-for-mqtt/mqtt-upgraded/product-overview/serverless-instance-billing),
[IoT Platform lifecycle notice](https://help.aliyun.com/zh/iot/product-overview/billing-overview),
[MQTT FC triggers](https://www.alibabacloud.com/help/en/functioncompute/fc/user-guide/apsaramq-for-mqtt-triggers).

## Domestic full-stack development without a custom filed domain

The user also asked about moving frontend/backend/database development to
domestic services. This is a separate prospective migration, not performed here.

| Layer | Development route | Requirements / boundary |
| --- | --- | --- |
| Frontend | Local development or an explicitly supported platform test domain | CloudBase static hosting supplies a default development/test domain, with limits; it is not a permanent production-domain exemption. |
| Backend | FC test endpoint, CloudBase functions/hosting, or private network access | Use platform authorization and appropriate CORS. FC built-in HTTP domains are documented as testing-only; browser attachment behavior differs from API clients. |
| Database | Platform-managed database or a private RDS connection from the backend | Create the instance/environment, database user/schema and network/access controls. No browser-side database secrets or separate website domain are needed for the database connection. |
| Team-only development | Local frontend plus private/VPN-accessible cloud services | Limit access to the intended team; the label "development" alone does not exempt a public website from requirements. |
| Public production website/API | Platform-supported production access and custom domain | Follow the provider's applicable filing/access requirements before formal public deployment. |

A cloud account/identity verification, deploy permissions, a development
environment/quota, backend/database credentials and application access rules
are still needed. These account requirements are distinct from ICP filing.
CloudBase packages several of these layers together; Alibaba FC plus a database
and storage assembles them separately. Do not promise that migrating the current
D1/R2-specific implementation is only a domain change.

Sources: [CloudBase static hosting](https://cloud.tencent.com/document/product/876/46900),
[FC built-in HTTP-domain limits](https://help.aliyun.com/zh/functioncompute/http-triggers-overview),
[Alibaba Cloud RDS network security guidance](https://security.aliyun.com/security-guide).

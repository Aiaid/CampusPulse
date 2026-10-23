# Custom domain and mainland connectivity — 2026-10-23

Status: `https://pulse.anend.net` is bound to the existing `campuspulse` Worker.
Mainland reachability improved substantially, but several probes still report
download anomalies; this is not nationwide availability or device acceptance.
All times below are Asia/Shanghai (UTC+8). These are point-in-time results.

## Binding and deployed application

The owner authorized selecting an unused `anend.net` subdomain and binding it.
Before binding, independent DNS-over-HTTPS returned NXDOMAIN for `pulse.anend.net`.
Cloudflare's Worker domain changeset reported one addition and no conflicts,
updates or removals. Existing credentials could inspect the zone and Worker
domain changeset but could not list DNS records; no DNS permission was expanded.
The attach API created the Custom Domain and certificate. A subsequent domain
listing confirmed `enabled: true` for the production `campuspulse` Worker.

The deployed version remained `a200b452-140c-4902-9f91-f3ded17af3fc` before/after
the binding. No local frontend/backend work was uploaded and no database write,
migration, device provisioning or credential change was performed.
The old `campuspulse.anend.workers.dev` endpoint remains enabled.

The Custom Domain is managed separately through Cloudflare's control plane.
It is deliberately absent from the shared Wrangler config: CI's existing token
does not have DNS/zone write access, and this task did not expand it. The installed
Wrangler 4.152.0 skips Custom Domain synchronization when the configuration has
no custom domains. If future deployment configuration starts managing domains,
include this hostname and review the full domain changeset before applying it.

Via the local machine's existing proxy path, both hostnames returned identical
SHA-256 hashes for HTML, health JSON and the three-place D1 query. New-domain
JavaScript and CSS returned 200. Browser checks rendered the actual application,
loaded all 24 observed map images and fetched health/places successfully. Those
browser/local checks used the existing proxy and are not mainland direct proof.
Production health still reported `ingestion: not_implemented`; the parallel
session's new ingestion code had not been deployed by this operation.

## Independent mainland HTTP probes

17CE GET probes used the complete HTTPS URLs. Each round selected 53 Telecom,
52 Unicom and 59 Mobile probes. Count each probe separately, including multiple
nodes in a city. A response of 200 counts as HTTP success; download anomalies,
connection failures, monitoring-node failures and `*` results are not successes.
`*` means no final result was shown, not a proven target timeout.

| Target / round | Telecom 200 | Unicom 200 | Mobile 200 | Total 200 / selected | Other reported result | No final result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Old workers.dev homepage | 0 | 0 | 0 | 0 / 164 | 153 | 11 |
| Old workers.dev places API | 0 | 0 | 0 | 0 / 164 | 156 | 8 |
| Baidu control | 49 | 47 | 57 | 153 / 164 | 2 | 9 |
| New homepage, initial round | 28 | 26 | 24 | 78 / 164 | 77 | 9 |
| New places API, initial round | 28 | 23 | 25 | 76 / 164 | 79 | 9 |
| New homepage, repeat at 15:49 | 48 | 34 | 52 | 134 / 164 | 18 | 12 |
| New places API, repeat at 15:49 | 48 | 38 | 51 | 137 / 164 | 15 | 12 |
| New production JS asset | 47 | 37 | 53 | 137 / 164 | 19 | 8 |

Repeated-homepage successful-node median times were 1.329 s (Telecom), 2.570 s
(Unicom) and 1.055 s (Mobile). API medians were 1.535 s, 1.673 s and 1.096 s.
These medians exclude failures and unfinished results, so are not full-population
latency estimates. The repeat round improved after the binding had been live
for several minutes, but propagation was not isolated as the cause.
The repeat-round non-200 labels were download anomalies; these included negative
download timing fields on the platform, and do not identify the failing network
stage. They must not be silently counted as successful requests.

Independent Chinaz cross-check at 15:47:12: **26/33** homepage nodes returned 200,
six timed out and one reported a platform system error. The platform displayed
0.957 s average response among successful nodes. Both Hubei Shiyan Telecom
nodes succeeded (0.649 s and 0.609 s). The old workers.dev run had 0/33 successes
(28 timeouts and five system errors). Chinaz's selected sample had Telecom,
Unicom and multiline nodes, not an independently labeled Mobile group.

## DNS evidence and interpretation

The old hostname returned `104.21.24.250` / `172.67.221.63` from Hong Kong/US
and an independent DoH query. Mainland results instead included many unrelated
addresses, consistent with DNS poisoning. The HTTP failures alone cannot prove
whether additional TLS/SNI or routing interference exists.

For the new hostname, 17CE DNS results showed the expected Cloudflare address
pair `104.21.84.80` / `172.67.188.170` on 56 Mobile, 50 Unicom and 46 Telecom
nodes; one additional Telecom node returned only `172.67.188.170`. One Zhengzhou
Telecom node returned a different address set, and some probes did not respond.
Thus this task does not establish that DNS is correct on every mainland network.

The evidence supports using the custom hostname as the usable public entry,
while retaining the remaining anomalies and real demo-network/device checks as
open acceptance work. HTTP URL tests do not prove the entire map, all assets,
manual writes or firmware uploads work from every mainland network.

## Reproducible reports

- [Old homepage](https://www.17ce.com/site/http/20261023_5620a090ceb411f1953a77329f5d57f7:1.html)
- [Old places API](https://www.17ce.com/site/http/20261023_99c166e0ceb411f1953a77329f5d57f7:1.html)
- [Baidu control](https://www.17ce.com/site/http/20261023_9bf11820ceb411f1953a77329f5d57f7:1.html)
- [Old DNS](https://www.17ce.com/site/dns/20261023_e4a24170ceb411f1b92f51700c7f42f4:1.html)
- [New homepage, initial](https://www.17ce.com/site/http/20261023_afca01d0ceb511f1b92f51700c7f42f4:1.html)
- [New API, initial](https://www.17ce.com/site/http/20261023_b11ff4e0ceb511f1b92f51700c7f42f4:1.html)
- [New homepage, repeat](https://www.17ce.com/site/http/20261023_279f3130ceb611f1b92f51700c7f42f4:1.html)
- [New API, repeat](https://www.17ce.com/site/http/20261023_296c9e30ceb611f1953a77329f5d57f7:1.html)
- [New JavaScript asset](https://www.17ce.com/site/http/20261023_f6e548e0ceb511f1953a77329f5d57f7:1.html)
- [New DNS](https://www.17ce.com/site/dns/20261023_d8e3b480ceb511f1953a77329f5d57f7:1.html)
- [Chinaz new hostname](https://tool.chinaz.com/speedtest/https://pulse.anend.net/)
- [Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

Platform report links may expire or show refreshed data. The raw browser-table
snapshots for this run are kept locally at
`/tmp/campuspulse-connectivity-2026-10-23.json` (ephemeral, not committed).
No screenshots or other images were published. These measurements describe the
version and time above; subsequent code deployments require separate validation.

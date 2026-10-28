# Public MQTT trust certificate

`digicert-global-root-g2.crt` contains exactly one **public CA certificate** in
PEM encoding. It contains no private key, password, device identity or upload
token. Public trust certificates can be versioned and redistributed. DigiCert's
[distribution statement](https://knowledge.digicert.com/general-information/community-root-authority-certificates)
does not require a charge or special license for use/distribution of its roots;
the certificate is also listed on its
[official roots page](https://knowledge.digicert.com/general-information/digicert-trusted-root-authority-certificates).

Provenance: downloaded from the EMQX console's official public CA link,
`https://assets.emqx.com/data/emqxsl-ca.crt`, and checked before publication on
2026-10-29. This is a selected public trust artifact, not a runtime capture or
an operator/device credential.

| Field | Value |
| --- | --- |
| Subject / issuer |DigiCert Global Root G2 |
| DER SHA-256 |`cb3ccbb76031e5e0138f8dd39a23f9de47ffc35e43c1144cea27d46a5ab1cb5f` |
| Not before |2013-08-01 12:00:00 UTC |
| Not after |2038-01-15 12:00:00 UTC |

The production firmware currently uses the ESP-IDF full public CA bundle with
strict chain, hostname and date checks. That bundle includes this root and can
accommodate a broker chain rotation to another trusted public root; this file
does not silently replace or narrow that runtime bundle. Check the actual
broker chain and bundle when updating either. A root's lifetime is separate
from the broker leaf/intermediate certificate lifetimes and provider policy.

Only public certificates belong here. Never place a `PRIVATE KEY` block, client
private key, broker password, device token, NVS image or credential-bearing
firmware build in Git. Secret material and provisioning exports stay private
and ignored. No blanket exception to the repository's `*.key`/`*.pem` ignore
rules is required for this explicitly named `.crt` file.

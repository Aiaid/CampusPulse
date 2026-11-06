# V3 signed boot clock

This independent bootstrap component has no device token, MQTT request, queue,
policy, TF or display path. Call it only at boot before any collector or other
network owner. Initialize NVS without erasure first. Success closes its temporary
Wi-Fi/SNTP/HTTP resources and returns an authenticated time anchor for the normal
native MQTT/TLS transport. Failure clears the output; cleanup errors retain the
owner so `cp_v3_clock_stop()` can be retried before another owner starts.

Personal/open Wi-Fi uses `cp_v3_clock_bootstrap()`, which continues to reject
PEAP. An explicit `cp_v3_clock_bootstrap_peap_none()` entry supports profiles
whose caller validated the saved choice of no EAP-server verification. It clears
CA/domain/default-bundle trust, sets the SDK time-check flag for this explicit
NONE mode, selects PEAP and configures identity/username/password before starting
Wi-Fi. The EAP choice never changes cloud HTTPS/MQTT TLS verification. CA-verified
PEAP remains manual USB only; no CA/date bootstrap exception is introduced.
The application must retain a deliberate physical USB recovery path. Missing or
invalid saved keys do not trigger network key discovery or trust-on-first-use.

## Trust boundary

SNTP from `ntp.aliyun.com` supplies only a tentative TLS-date hint. It runs while
this component exclusively owns networking and stops before HTTPS. The probe is
fixed to `https://pulse.anend.net/api/v3/clock`, with the ESP certificate bundle,
hostname and certificate-date verification enabled. Redirects are rejected. No
device token, broker credential, node identity or Wi-Fi credential is put in the
HTTP request. The previous wall-clock mapping is restored before ownership is
released; normal transport subsequently installs the returned trusted anchor.
PEAP credentials and options are cleared only after the temporary radio stops;
enterprise mode is disabled and its time-check flag reset before Wi-Fi deinit.
Any failed stop/reset preserves ownership for an explicit cleanup retry.

The first explicitly trusted USB setup pins a P-256 SPKI public key (91 DER
bytes) and key ID. Boot never replaces this pin from the clock response or the
public key endpoint. Key rotation requires another explicit trusted provisioning
action; a future signed rotation protocol is not implemented. No response under
an unpinned old key is accepted. A compromised signing key is not recoverable by
unauthenticated boot discovery.

Each attempt generates a new 32-byte random nonce while Wi-Fi RF is active. It
posts `{"nonce":"<64 lowercase hex digits>"}`. The seven response fields are
`schema`, `audience`, `key_id`, `nonce`, `unix_ms`, `max_error_ms` and `sig`.
Duplicate/unknown fields, escapes, malformed JSON, trailing content and padded or
noncanonical signatures fail closed. The signed ASCII transcript has a final LF:

```text
cp-v3-signed-clock/1
https://pulse.anend.net
<key_id>
<nonce>
<decimal unix_ms>
<decimal max_error_ms>
```

`sig` is base64url without padding of a 64-byte IEEE-P1363 `r || s` signature,
ECDSA P-256 with SHA-256. The fixed audience, exact pinned key ID and fresh nonce
are all covered. The nonce is consumed on success or failure, including retries.

## Time bounds and continuity

DNS/TLS and headers contain no nonce. The pinned ESP-IDF HTTP client dispatches
`HTTP_EVENT_HEADERS_SENT` immediately before sending `post_data`; that event starts
the sample interval. It ends after the complete response. The portable verifier
places signed UTC at the monotonic interval midpoint with uncertainty:

`signed server error + ceil(RTT/2) + ceil(RTT * 500ppm) + 1ms`.

RTT may not exceed 6 seconds and initial uncertainty may not exceed 4 seconds.
Signed server error must be 1..3000ms. This is an operator-declared clock accuracy
assumption, not something signatures, TLS or this firmware measure. The normal
transport continues to grow uncertainty at 500ppm and rejects above 5000ms.
RTC seconds or previous boot monotonic values are never promoted to a trusted
new-boot anchor. Periodic safe restart/re-registration is application-owned;
neither this component nor successful time verification renews collection policy.

## Validation

With the pinned ESP-IDF 5.5.3 path in `IDF_PATH`:

```sh
uv run firmware/components/cp_v3_clock/tests/run.py
uv run firmware/components/cp_v3_clock/tests/test_bootstrap.py
```

The ASan/UBSan host test creates real Node WebCrypto signatures and verifies them
through OpenSSL, then checks mutations and temporal/parser bounds. SDK compile
checks are separate from the deterministic SDK-double suite, which executes the
actual bootstrap control flow with sanitizers: EAP setup and teardown ordering,
strict HTTPS configuration, fresh challenge retries, signature rejection,
association/SNTP failures, cancellation, partial credential cleanup and retained
ownership after cleanup failures. These host tests do not establish actual SNTP
reachability, HTTPS, PEAP interoperability, Wi-Fi interruption recovery or
untethered hardware acceptance.

Primary references: [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/),
[ESP32-S3 entropy requirements](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32s3/api-reference/system/random.html),
and the installed ESP-IDF 5.5.3 `esp_http_client`, `esp_sntp`, ESP-TLS and mbedTLS
interfaces. SDK libraries are linked, not vendored.

# USB-only device setup

Decision: 2026-10-29. The user requested removal of Bluetooth and device Wi-Fi
hotspot provisioning from both the administrator website and firmware.

## Current contract

Local setup uses a physical USB data connection and a desktop browser exposing
Web Serial in a secure context. The administrator wizard reads the connected
device identity before enrollment or reconfiguration. It sends the target Wi-Fi
settings and required device/MQTT authorization over USB. Browsers without Web
Serial explain the desktop requirement; they do not offer a Bluetooth or hotspot
fallback.

Normal Wi-Fi station networking and passive BLE collection remain part of the
application. Removing setup transports does not remove either capability.
USB session nonces, bounded candidates, identity checks, saved-credential reuse,
network validation, durable settings and independent cloud confirmation remain
required. Opening a serial connection or receiving a candidate acknowledgment
does not prove a successful save or cloud receipt.

The Passport setup action uses USB. An unconfigured device waits for explicit
USB setup instead of advertising a setup service or starting a device hotspot.
No hotspot password or Bluetooth setup PIN is presented by the current UI.

## Historical material

[Short PIN and USB provisioning](../specs/local-provisioning-v2.md),
[firmware platform](../design/firmware-platform.md), and
[firmware chain](firmware-chain.md) retain earlier transport designs and their
acceptance evidence. Their Bluetooth, SRP/Security 2, and local-hotspot sections
are historical, superseded by this decision. Their earlier device tests do not
establish acceptance of a newly built USB-only image.

## Validation and rollout

Local verification on2026-10-29:

- The final USB frontend suites pass, including rejection of legacy BLE
  identities before credential issuance. The production web build passes.
- The complete Chromium regression passes with a Bluetooth API present but no
  wireless controls, unsupported-Web-Serial guidance, new/existing enrollment,
  MQTT/credential reuse, lost responses, retries, diagnostics and separate cloud
  confirmation. Browser fixtures disable Vite watch/HMR to prevent concurrent
  source checks from interrupting an active setup dialog.
- The web suite covers1043 tests in85 files. One full run passed; the final run
  during parallel firmware compilation hit three unrelated timeout limits
  (administrator password, indexed history query and lighting layout). Their
  three files then pass all19 tests with a single worker after compilation.
- Native firmware tests pass for provisioning nonce/expiry, identity, saved
  credentials/MQTT, concurrent submit, removed transport rejection without
  session mutation and rejection of removed chunk operations. The actual USB
  controller, guard tests and113 runtime scenarios pass.
- Passport core/UI/app checks pass across four app configurations, including17
  Python regressions and sequential display pixel comparisons.
- Fresh ESP-IDF5.5.3 C3 and S3 builds pass separate-image/layout verification.
  App sizes are0x147900 (C3) and0x13aaa0 (S3), within each declared0x300000 app
  partition. Neither final ELF contains `protocomm_ble_start`,
  `protocomm_security2`, `esp_srp` or `wifi_prov_mgr` symbols. The S3 configuration
  retains its BLE observer and Wi-Fi networking capabilities.

This change does not itself deploy the website or flash a connected board.
Existing saved Wi-Fi settings, credentials, queues and protected Flash are not
rewritten by a source-code change.

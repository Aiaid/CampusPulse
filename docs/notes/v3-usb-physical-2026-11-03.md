# V3 USB physical retest — 2026-11-03

Status: Waveshare app upgrade, Flash preservation, real Web Serial HELLO,
on-device bearer reuse through START, PEAP without CA and native MQTT capability
registration verified. Generation 6 failed on-device policy application;
new statistics capture/receipts remain unaccepted. The user subsequently limited
this run to Waveshare; the disconnected
T-Energy was not flashed or tested.

## Software and hardware identity

The published source is `14114d7`, including optional PEAP server verification,
same-node saved-credential reuse, default outer identity and send-button
readiness. [Release CI/CD 41583972805](https://github.com/Aiaid/CampusPulse/actions/runs/41583972805)
passed software checks, deployment and online smoke checks. These results do not
establish physical USB or wireless interoperability.

The existing Waveshare hardware session checked the exact official V2 board
documentation and matched the attached unit before writing: ESP32-S3-PICO-1,
8 MiB Flash and 8 MiB PSRAM, with the existing application at `0x10000`.
A full current 8 MiB Flash backup was retained privately. Only the application
was written. Its readback matched the installed image; the bootloader prefix,
partition table, NVS and protected tail were byte-for-byte unchanged. No TF
content, historical records or device bearer was deleted or rotated.

Installed application: 1,709,424 bytes, SHA-256
`4ce3e667928dfc5b6dcfb220de4dd23fc8b6ab23d33693517eda5d9da52680c9`.
This was the board session's rebuilt image; it is distinct from the earlier
candidate image digest. Private backup, readback and HELLO evidence is under
the ignored `captures/v3-usb-physical-20261103/waveshare/` directory.

## Observed credential readiness

The physical device's nonce-bound HELLO returned:

| Field | Result | Meaning |
| --- | --- | --- |
| `credential_state` | `ready` | Same-node saved device bearer is available locally |
| `mqtt_state` | `missing` | Existing node MQTT authorization must be recovered before START |

This verifies the readiness reader against this unit's retained settings. It
does not verify actual START reuse or authorize rotating the bearer. Existing
MQTT authorization should be recovered through the protected administrator
flow, retaining the assigned node identity.

## Browser test and current boundary

The production administrator page opened in a new Chrome tab, preserving the
original provisioning form. Chrome listed the correct already-paired native USB
port, but two connection attempts timed out waiting for the corresponding
HELLO nonce. The application reported that credentials had not been sent.
A subsequent direct host HELLO on the released port succeeded immediately and
again returned `ready` / `missing`.

The host diagnostic log contains `USB_UART_CHIP_RESET` and a normal application
boot, without a panic. Its boot identity differs from the earlier postflash
HELLO. This establishes a reset within those observations; it does not identify
which browser or host control-line transition caused it. Browser and firmware
HELLO framing match, and the firmware flushes its reply. Further browser-side
receive/control-line evidence is required before changing timeouts or signals.

At the user's request, the next test used the Codex in-app browser. A private
loopback diagnostic page imported the unchanged production `openV3Serial`
helper, selected only the actual ESP32 USB vendor/product and enforced a guard
allowing only `HELLO <nonce>\n` writes. The real device passed the first HELLO:
39 transmitted bytes in one write, 4,243 received console bytes, one HELLO line,
one READY line, and a same-node/nonce-validated `ready` / `missing` result. The
helper closed the port; a host ownership check confirmed it was released.
The delayed-retry path was not needed. This establishes actual Web Serial
interoperability for this browser/helper/device combination; the earlier Chrome
failure remains unexplained and does not justify changing signals or timeouts.

The production administrator wizard was then opened in the same Codex browser.
After a separate production-origin USB selection it recognized the registered
unit and offered on-device bearer reuse. The protected existing-MQTT read
required administrator reauthentication and then succeeded, enabling the bounded
START button. This read did not register a new node or rotate the device bearer.
Private network fields remain in the local form and are excluded from this
record. At this checkpoint, PEAP without CA and one bounded window were selected;
START/network/capture acceptance remained separate from successful preparation.

## Actual START, network and policy result

The user reauthenticated and initiated one bounded PEAP run without CA in the
production wizard. It received `V3 START ACCEPTED`. At 19:25:16 Asia/Shanghai,
the production server received fresh capabilities whose boot identity matched
the physical USB identity. This verifies the configured network and native MQTT
control path for this run, including use of the retained device bearer. It does
not establish CA-authenticated PEAP or saved/autonomous PEAP startup.

The administrator prepared, validated and published immutable generation 6 for
the existing unlocated deployment and `controlled_test` dataset. Raw sampling,
archive and local raw recording remained off. The device committed a failed ACK
at 19:28:00.636 Asia/Shanghai: `unsupported_config`, apply sequence 1, with no
open window or segment. The failed assignment and ACK are retained.

The exact rejection is the prepare template's queue reservation layout:

| Reservation | Prepared generation 6 | Installed Waveshare runtime requires |
| --- | --- | --- |
| Window statistics | 2048 bytes / 1 item | 8192 bytes / 4 items |
| Node status | 2048 bytes / 1 item | 4096 bytes / 2 items |
| Control | 2048 bytes / 1 item | 4096 bytes / 2 items |

The total queue still matched 24576 bytes / 12 items. The installed runtime's
fixed partition admission rejected these six differing reserve fields before
RTC, storage and heap admission. Backend negotiation checked advertised total
ceilings, which do not express the firmware's fixed reservations, so its earlier
`valid: true` did not establish device compatibility. The correction belongs in
recognized-profile preparation and prepublication validation, without loosening
the device's actual queue checks or changing historical assignments.

The failed run exits after its durable ACK; it cannot apply a later policy in
that same run. A retest needs a fresh USB start/boot and a new immutable
generation. No new window/statistics success should be inferred from START,
capability registration or the failed ACK. Private policy and ACK evidence is
retained with the browser diagnostic files; private network inputs are excluded.

## Management compatibility repair

The local repair recognizes the existing `cp-v3-small/1` TF geometry
(24576 bytes / 12 items / 2048-byte bodies), prepares the actual 4/2/2 layout,
and rejects incompatible fixed reservations in management validation and new
direct assignment requests. Exact retained assignment retries are handled
before the new guard, preserving the failed generation 6 assignment and ACK.
Unrelated generic producers and T-Energy's three one-slot reservations retain
their existing behavior. Optional event uploads require their separate four-slot
reservation; normal preparation keeps event uploads off.

Scoped management/control checks passed 37 tests and TypeScript checking;
independent review ran 59 overlapping related management/statistics/startup
tests. Release and actual corrected-policy application remain separate gates.
The capability schema still advertises ceilings rather than exact reservation
profiles; the adapter is an explicit compatibility repair, not a schema redesign.
Static review also identified a separate T-Energy prepared-uplink budget mismatch,
recorded in the roadmap; this Wave-only physical run does not validate T-Energy.

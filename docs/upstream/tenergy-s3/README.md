# Historical T-Energy-S3 branch evidence

Status: historical source summary, imported 2026-10-29. Current work is tracked
in [T-Energy integration](../../design/tenergy-s3-integration.md).

Source: `origin/feat/tenergy-s3-port`, commit
`ca7bc9e6f4f1cb276128f9a216f3fdb34f8b3321`. This summary preserves the evidence
boundary without copying device identifiers or machine-specific backup paths.
The original documents remain addressable through Git:

- `docs/design/tenergy-s3-port.md`: chronological compile, Flash, boot and USB
  setup records from 2026-10-25, plus the original port design.
- `docs/research/t-energy-s3-hardware.md`: 2026-10-23 vendor-fact research, pinned
  to vendor revision `68a74854ce0443377d186786bf3478484a0813e0`; it is not a
  schematic or battery-calibration measurement.

Original document SHA-256 values at that commit:

| Source | SHA-256 |
| --- | --- |
| Port design and records | `fadc8a702b193d0c5d62e6fe7d4ea2ef281847c341c9b8a78676b609883cda70` |
| Hardware research | `29ce4317f6781350087fdb967e633699f99b633f446f667754893a30324ef122` |

The port records describe ESP32-S3 rev 0.2, 16 MB quad Flash and 8 MB Octal PSRAM;
the first board booted the shared chain, opened its journal and answered USB
setup. A later section records flashing a second board with a different factory
layout. Some earlier tables and the final verification section were not updated
after that second-board section. Do not repeat their claims that all S3 support
or the second-board flash are still missing.

These records do not establish current MQTT enrollment, BLE capture, sustained
durable upload, battery calibration or recovery acceptance. The historical
advice to erase regions is specific to those factory-to-chain migrations, not
an instruction to erase a currently enrolled device.

Selected code is consolidated under `firmware/t-energy-s3/`; active shared
components come from current main. The source branch also contains unrelated
shared-file snapshots that are deliberately not copied into this integration.

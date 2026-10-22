# Prior work and reuse

## Initial public baseline

This baseline contains newly written project documentation and Git exclusions,
plus adapted project development rules. It contains no firmware, receiver, UI,
tests, runtime data, or third-party implementation code.

Pre-hackathon prototypes are design references. Useful lessons include preserving
the board's protected Flash regions, keeping BLE callbacks nonblocking, reporting
data loss, and distinguishing activity observations from exact people counts.
These lessons do not establish that the new implementation works.

Local pre-hackathon material is kept under the ignored `local-reference/`
directory. It must never be force-added or published as part of this baseline.

## Future reuse entries

Before committing reused code, add an entry with:

- Source repository or vendor, exact revision, and source paths.
- Destination paths and the reason for reuse.
- Applicable license, required notices, and modifications made.
- Validation performed for the new implementation and remaining limitations.

Reused board drivers must retain their upstream copyright and license. Record
any permitted reuse transparently; do not relabel prior code as newly written.

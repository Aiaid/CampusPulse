# CampusPulse project instructions

- Work directly in this directory; do not create worktrees.
- This repository starts the hackathon implementation from a fresh baseline.
  `local-reference/` contains pre-hackathon material for local reference only;
  never stage or publish it. Do not copy the previous application wholesale.
- Read `docs/design/ROADMAP.md` before implementation; record new directions there
  and archive completed work. Record any actual code reuse and its license in
  `docs/notes/reuse.md` before committing it.
- Treat the neighboring `aipassport` repositories as read-only references and
  preserve their local work.
- Target the FoloToy AI Passport ESP32-C3, 8 MB Flash, no PSRAM, ESP-IDF 5.5.3.
- If board drivers are reused from `aipassport/ai-passport/components/bsp`, preserve
  their pin mapping, copyright, and license. Do not initialize unused audio.
- Preserve the 3 MB application partition and `cardid` at 0x356000. Never erase
  the entire Flash. Deliver separate bootloader, partition, and app images;
  do not flash a padded merged image across protected device data.
- Keep BLE callbacks nonblocking. Storage and upload run in worker tasks.
- Never claim radio completeness or device validation from a passing build.
- Report queue losses, storage exhaustion, sequence gaps, and upload failures.
- Keep Python operations under `uv`; use English commits when requested.
- Place documents in category directories and index them in `docs/README.md`.
- Maintain a P0-P4 roadmap and archive completed work. No credentials in tracked
  files or logs. Runtime captures and receiver databases are ignored.
- Distinguish simulated data, live observations, builds, and device validation.
  BLE-visible identifiers are not an exact count of people.

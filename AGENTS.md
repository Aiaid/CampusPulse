# CampusPulse agent instructions

Shared working rules are synchronized from the user's global instructions and
adapted for this repository. Keep this file self-contained and portable; do not
import machine-specific configuration. Higher-priority and current user
instructions take precedence.

## Shared working rules

### Collaboration

- Work in the current directory. Do not create worktrees unless the user
  explicitly requests a worktree, including for background work.
- For substantial implementation, prefer an agent team for independent tasks
  when the platform and higher-priority instructions allow it. The primary agent
  integrates and validates the result; handle small fixes directly.
- Select subagents from the runtime's actually available models, without guessing
  names or pinning historical versions: latest fast/lightweight model with medium
  reasoning for simple low-risk tasks; latest main coding/balanced model with high
  reasoning for normal implementation, tests, review and debugging; latest
  frontier model with xhigh or the highest practical reasoning for architecture,
  difficult debugging, large refactors and security-critical or uncertain work.
  Explicitly set supported overrides when possible. If overrides prevent context
  inheritance, provide only the context needed; otherwise inherit and disclose
  that limitation. Honor explicit user cost/model/latency preferences and explain
  any necessary unavailable-model substitution.
- Treat unfamiliar modified/untracked files or unexpected concurrent edits as
  another session's work. Before touching them, use available session/message
  tools to coordinate paths, intended commits and ports. Preserve their work,
  processes and ports; do not reset, repair or terminate them without agreement.
- Stage only owned paths. For shared files, stage only owned hunks with patch
  staging or an index patch. Never use `git add -A` or `git commit -a`.

### Project instructions

- Keep cross-agent project rules in this root `AGENTS.md`. Only Claude-specific
  content belongs in `CLAUDE.md` or `.claude/CLAUDE.md`.
- During an authorized editing task, if either Claude instruction file exists,
  audit it against AGENTS without another approval step. Merge applicable shared
  rules without blindly overwriting AGENTS; retain Claude-only rules and import
  `@AGENTS.md` from the root Claude file or `@../AGENTS.md` from the nested one.
  If a Claude file contains only shared rules, replace its body with that import.
  Do not migrate local/private instructions, machine paths or secrets. Report
  which files changed. Read-only review/diagnosis does not authorize this cleanup.

### Python toolchain

- Use `uv` for every Python operation. Run scripts/tests with `uv run`, including
  `uv run python ...`; do not use bare Python, `pip`, or `python -m venv`.
- With `pyproject.toml`, use `uv add` / `uv add --dev` for dependencies and
  `uv sync` (plus required extras) to synchronize. Otherwise use `uv pip install`.
  Use `uv venv`, `uv tool install`, and `uvx` for their respective environment,
  global-tool and one-off-tool tasks.
- If a module is missing, resolve the dependency with uv rather than switching
  interpreters or bypassing validation.

### Documentation

- Organize docs under category directories such as `specs/`, `design/`,
  `upstream/`, `notes/` and `research/`; maintain the complete index in
  `docs/README.md`. Move/update paired language documents together.
- Maintain the P0-P4 roadmap. Record new directions before implementation and
  move completed items into its archive instead of deleting them.
- After major changes and periodically, audit factual documentation against code
  and tests. Mark superseded documents prominently and preserve them; correct or
  annotate partially outdated claims, and reflect status in the index.

### Images prepared for external use

- Before sending, uploading or publishing any image (including screenshots,
  generated images, converted assets, docs, commits and PRs), inspect metadata
  using ExifTool or a tool with reliable support for the format. Check EXIF, GPS,
  XMP, IPTC, MakerNotes, thumbnails and comments for identity, location, embedded
  timestamps, device/serial, author/contact and path information. Do not print
  private values in logs or chat.
- Preserve originals. Strip unnecessary metadata from the external-use copy,
  honoring fields explicitly requested by the user. Apply correct orientation
  before removing its tag, then verify orientation, color and readability.
- Recheck the actual final file after conversion/compression/editing and match
  it to the version being committed/uploaded. Filesystem times are not embedded
  capture times. If the format cannot be checked reliably, convert to a verifiable
  copy and inspect it; do not claim an unverified pass. Briefly report the result.

### Git commits

- Write commit messages primarily in English. Use an English imperative subject
  no longer than 72 characters; English-first bilingual messages are allowed,
  purely Chinese messages are not.

## CampusPulse project constraints

- This repository starts the hackathon implementation from a fresh baseline.
  `local-reference/` contains pre-hackathon material for local reference only;
  never stage or publish it. Do not copy the previous application wholesale.
- The user explicitly authorized migrating the selected 2026-10-21 frontend on
  2026-10-23. Preserve its overview/local maps, search, replay, independent layers,
  directional moving/parked actors, occlusion and optional building transparency.
  This exception covers selected UI modules and generated visual assets, with
  reuse provenance recorded; it does not include old backend, firmware, captures,
  credentials or deployments. Load school raster tiles from their official
  source rather than bundling the historical snapshot. Keep live API observations
  separate from all synthetic activity, waits, replay and illustrative lighting.
- User-requested historical Markdown has selected copies/summaries under
  `docs/upstream/pre-hackathon/`, with hashes and explicit historical status.
  This does not authorize publishing raw captures or invited private repositories.
- Read `docs/design/ROADMAP.md` before implementation; record new directions there
  and archive completed work. Record any actual code reuse and its license in
  `docs/notes/reuse.md` before committing it.
- Treat the neighboring `aipassport` repositories as read-only references and
  preserve their local work.
- Hardware inventory: FoloToy AI Passport x2 (ESP32-C3, 8 MB Flash, no PSRAM),
  LILYGO T-Energy-S3 x2, and one Waveshare 1.54-inch ESP32-S3 ePaper board.
  Verify each board revision before selecting drivers or partition layouts.
  ESP-IDF 5.5.3 is the existing Passport reference toolchain; validate S3 targets
  separately. See `docs/design/hackathon-plan.md` for the proposed roles.
- Host the frontend, API, and database on Cloudflare. GitHub stores source only.
  The proposed baseline is Workers Static Assets + Workers API + D1.
- The upload design is `docs/specs/ingest-v1.md`: separate window/raw/status
  streams; research raw batches use private R2 and independent durable receipts.
  It is a design draft, not an implemented or hardware-validated protocol.
- If board drivers are reused from `aipassport/ai-passport/components/bsp`, preserve
  their pin mapping, copyright, and license. Do not initialize unused audio.
- On the AI Passport, preserve the 3 MB application partition and `cardid` at
  0x356000; do not apply that layout to other boards. Never erase the entire
  Flash. Deliver separate bootloader, partition, and app images;
  do not flash a padded merged image across protected device data.
- Keep BLE callbacks nonblocking. Storage and upload run in worker tasks.
- Never claim radio completeness or device validation from a passing build.
- Report queue losses, storage exhaustion, sequence gaps, and upload failures.
- No credentials in tracked files or logs. Runtime captures and receiver
  databases are ignored.
- Distinguish simulated data, live observations, builds, and device validation.
  BLE-visible identifiers are not an exact count of people.

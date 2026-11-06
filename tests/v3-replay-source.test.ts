import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadV3Replay } from '../scripts/lib/v3-replay-source.mjs';

let directory: string;
beforeAll(async () => { directory = await mkdtemp(path.join(tmpdir(), 'v3-replay-loader-')); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
const fixture = () => ({ schema: 'campuspulse-cpraw-replay/1', window_ms: 1000, bin_ms: 1000,
  provenance: { source_sha256: ['a'.repeat(64)], total_reports: 4, private_unrecognized_field: 'must-not-be-exposed' },
  windows: [{ source_start_mono_us: 0, source_end_mono_us: 1000000,
    item: { d: 1000, b: 1000, c: [0, 0, 0, 0, 2, 0], r: [4, 4, 4, 0], x: [[4, 2, 4, -240]],
      s: [4, -240, -60, -60], l: [0, 0, 0, 0], f: 4, v: ['cp-v3-stats/1', 'unclassified-v1'] } }] });
async function load(value: unknown) {
  const file = path.join(directory, 'replay.json');
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  return loadV3Replay(file);
}
it('validates aggregate conservation and exposes only selected provenance', async () => {
  const replay = await load(fixture());
  expect(replay.windows[0].item).toEqual(fixture().windows[0].item);
  expect(JSON.stringify(replay)).not.toContain('must-not-be-exposed');
  expect(replay.provenance.replay_sha256).toMatch(/^[0-9a-f]{64}$/);
});
it('rejects hidden raw fields, broken report sums, unavailable rules and overlapping source windows', async () => {
  const raw = fixture(); (raw.windows[0].item as any).address = 'forbidden';
  await expect(load(raw)).rejects.toThrow('shape');
  const broken = fixture(); broken.windows[0].item.r[1] = 5;
  await expect(load(broken)).rejects.toThrow();
  const flags = fixture(); flags.windows[0].item.f = 4.5;
  await expect(load(flags)).rejects.toThrow('shape');
  const rules = fixture(); rules.windows[0].item.v[1] = 'unreviewed-classifier';
  await expect(load(rules)).rejects.toThrow();
  const overlap = fixture(); overlap.windows.push(structuredClone(overlap.windows[0]));
  await expect(load(overlap)).rejects.toThrow('contiguous');
});

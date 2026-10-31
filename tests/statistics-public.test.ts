import { afterEach, beforeEach, expect, it } from 'vitest';
import { readPlaceStatistics } from '../worker/statistics-public';
import { handleDeviceV3Statistics } from '../worker/device-v3-statistics';
import { sha256 } from '../worker/ingest';
import { setup, DEVICE_TOKEN } from './helpers/ingestion';
import { statisticsFixture, seedStatistics, statisticsBatch, STATISTICS_FLAGS } from './helpers/v3-statistics-fixtures';

let state: Awaited<ReturnType<typeof setup>>;
let env: typeof state.env & typeof STATISTICS_FLAGS;
let fixture: Awaited<ReturnType<typeof statisticsFixture>>;
beforeEach(async () => {
  state = await setup(); env = { ...state.env, ...STATISTICS_FLAGS };
  fixture = await statisticsFixture(state.config.node_id, state.config.placement_id);
  fixture.policy.custody.dataset = 'field'; fixture.policy.custody.purpose = 'site_observation';
});
afterEach(() => { state.db.close(); });
async function ingest(seq = 1, partial = false, source = fixture, token = DEVICE_TOKEN, visible = 2, uncertainty = 0) {
  const b = await statisticsBatch(source, seq);
  b.x[0].c[4] = visible; b.x[0].x[0][1] = visible;
  if (uncertainty) { b.x[0].t[3] = uncertainty; b.x[0].f |= 2; }
  if (partial) { b.x[0].l[3] = 1; b.x[0].f = 8; }
  const body = JSON.stringify(b);
  const response = await handleDeviceV3Statistics(new Request('https://synthetic.test/api/v3/statistics/ingest', {
    method: 'POST', body, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-Body-SHA256': await sha256(new TextEncoder().encode(body)) },
  }), env);
  expect(response?.status, await response?.clone().text()).toBe(200);
}
it('returns an explicit disabled state without touching missing statistics tables', async () => {
  expect(await readPlaceStatistics(state.env, 'library')).toMatchObject({ state: 'unavailable', reason: 'disabled', estimated_total: null });
});
it('projects only small aggregate units and causal activity, with no identifiers or wait prediction', async () => {
  await seedStatistics(env.DB, fixture); await ingest(); await ingest(2);
  const result = await readPlaceStatistics(env, 'library');
  expect(result).toMatchObject({ state: 'observed', unit: 'observed_address_type_keys', visible_identifiers: 2,
    candidates: { unknown: 2, phone_candidate: 0 }, estimated_total: null, activity: { value: 2, windows: 2 } });
  expect(JSON.stringify(result)).not.toMatch(/"(?:node_id|boot_id|policy_id|event_id|address|token|wait_seconds|payload)"\s*:/);
});
it('does not sum windows or receivers into a population and stops smoothing across a missing window', async () => {
  await seedStatistics(env.DB, fixture); await ingest(); await ingest(3);
  expect(await readPlaceStatistics(env, 'library')).toMatchObject({ visible_identifiers: 2, activity: { windows: 1 }, estimated_total: null });
});
it('keeps a stable active receiver even when another receiver uploads newer data', async () => {
  await seedStatistics(env.DB, fixture); await ingest();
  const token = 'synthetic-other-device-token';
  state.db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)')
    .run('synthetic-other', await sha256(new TextEncoder().encode(token)));
  state.db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,0)')
    .run('zz-secondary', 'synthetic-other', 'library');
  const other = await statisticsFixture('synthetic-other', 'zz-secondary', Date.now() + 10);
  other.policy.custody.dataset = 'field'; other.policy.custody.purpose = 'site_observation';
  await seedStatistics(env.DB, other); await ingest(1, false, other, token, 1);
  expect(await readPlaceStatistics(env, 'library')).toMatchObject({ visible_identifiers: 2,
    source: { receivers: 1, selection: 'stable-active-placement-order/1' } });
});
it('does not smooth across an inconsistent UTC mapping even when monotonic windows touch', async () => {
  await seedStatistics(env.DB, fixture); await ingest(); await ingest(2);
  // Emulate an old/imported corrupt row; the public read must defend itself too.
  state.db.prepare(`UPDATE statistics_windows_v3 SET end_utc_ms=end_utc_ms-5000,
    item_json=json_set(item_json,'$.time.utc_ms',end_utc_ms-5000) WHERE seq=1`).run();
  expect(await readPlaceStatistics(env, 'library')).toMatchObject({ visible_identifiers: 2, activity: { windows: 1 } });
});
it('retains explicit overflow quality but withholds activity smoothing', async () => {
  await seedStatistics(env.DB, fixture); await ingest(1, true);
  expect(await readPlaceStatistics(env, 'library')).toMatchObject({ state: 'partial_observation', visible_identifiers: 2,
    activity: null, quality: { flags: ['identifier_overflow'], address_overflow_reports: 1 } });
});
it('keeps measured bounded clock uncertainty without disabling all real-world activity', async () => {
  await seedStatistics(env.DB, fixture); await ingest(1, false, fixture, DEVICE_TOKEN, 2, 50);
  expect(await readPlaceStatistics(env, 'library')).toMatchObject({ state: 'observed', activity: { value: 2 },
    quality: { flags: ['uncertain_clock'] }, estimated_total: null });
});
it('withholds controlled-test and mobile research from public reads', async () => {
  fixture.policy.custody.dataset = 'controlled_test'; fixture.policy.custody.purpose = 'controlled_test';
  await seedStatistics(env.DB, fixture); await ingest();
  expect(await readPlaceStatistics(env, 'library')).toMatchObject({ reason: 'no_field_statistics', visible_identifiers: null });
});
it('marks delayed old windows stale rather than refreshing them to receive time', async () => {
  await seedStatistics(env.DB, fixture); await ingest();
  expect(await readPlaceStatistics(env, 'library', Date.now() + 100000)).toMatchObject({ reason: 'stale_statistics', visible_identifiers: null });
});
it('withholds a closed placement immediately and preserves manual observations', async () => {
  await seedStatistics(env.DB, fixture); await ingest();
  state.db.prepare('UPDATE places SET observation_kinds_json=? WHERE id=?').run('["activity","elevator"]', 'library');
  state.db.prepare(`INSERT INTO observations(id,place_id,kind,observed_at,valid_until,received_at,wait_seconds)
    VALUES('synthetic-manual','library','elevator',?,?,?,45)`)
    .run(new Date(fixture.now - 1000).toISOString(), new Date(fixture.now + 60000).toISOString(), new Date(fixture.now).toISOString());
  const before = state.db.prepare('SELECT * FROM observations').all();
  state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
    .run(fixture.policy.custody.placement_id, fixture.policy.node_id, Date.now() - 1, new Date().toISOString());
  expect(await readPlaceStatistics(env, 'library')).toMatchObject({ reason: 'no_active_receiver' });
  expect(state.db.prepare('SELECT * FROM observations').all()).toEqual(before);
});
it('propagates storage errors instead of reporting zero or no observations', async () => {
  state.db.exec('DROP TABLE statistics_windows_v3');
  await expect(readPlaceStatistics(env, 'library')).rejects.toThrow(/statistics_windows_v3/);
});

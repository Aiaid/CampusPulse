import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker, { handleApi } from '../worker/index';
import { readPublicWindows, readLastReportedSensor } from '../worker/sensors';
import { readAutomaticObservations } from '../worker/place-inference';
import { sha256 } from '../worker/http';
import type { Place } from '../worker/types';
import { setup, fixture, seedConfig, sqliteD1, DEVICE_TOKEN } from './helpers/ingestion';
import { statisticsFixture, seedStatistics, statisticsBatch, STATISTICS_FLAGS } from './helpers/v3-statistics-fixtures';

let state: Awaited<ReturnType<typeof setup>>;
let env: typeof state.env & typeof STATISTICS_FLAGS;
let source: Awaited<ReturnType<typeof statisticsFixture>>;
beforeEach(async () => {
  state = await setup(); env = { ...state.env, ...STATISTICS_FLAGS };
  source = await statisticsFixture(state.config.node_id, state.config.placement_id);
  source.policy.custody.dataset = 'field'; source.policy.custody.purpose = 'site_observation';
});
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });
const place: Place = { id: 'library', name: 'Synthetic site', kind: 'parking', observation_kinds: ['activity','parking','elevator'], anchor: { x: 0, y: 0 }, coverage: 'unconfigured' };
async function upload(partial = false) {
  await seedStatistics(env.DB, source);
  const batch = await statisticsBatch(source);
  if (partial) { batch.x[0].l[3] = 1; batch.x[0].f = 8; }
  const body = JSON.stringify(batch);
  const response = await handleApi(new Request('https://synthetic.test/api/v3/statistics/ingest', { method: 'POST', body,
    headers: { Authorization: `Bearer ${DEVICE_TOKEN}`, 'Content-Type': 'application/json', 'X-Body-SHA256': await sha256(new TextEncoder().encode(body)) } }), env);
  expect(response?.status, await response?.clone().text()).toBe(200);
  return response!.json() as Promise<{ expires_at: string; retain_until: string }>;
}
function seedHistorical(version: 1 | 2) {
  const config = fixture(version === 1 ? 'capture-config.fixture' : 'capture-config-v2.fixture');
  Object.assign(config, { capture_config_id: `historical-v${version}`, dataset: 'field', accept_until: new Date(Date.now() + 100000).toISOString() });
  seedConfig(state.db, config);
  const node = config.node_id, boot = crypto.randomUUID(), batch = crypto.randomUUID(), now = Date.now(), received = new Date(now - 1000).toISOString();
  const table = version === 1 ? 'ingestion_batches' : 'ingestion_batches_v2';
  const insert = (id: string, stream: string, key: string | null) => state.db.prepare(`INSERT INTO ${table}(node_id,batch_id,receipt_id,body_sha256,boot_id,stream,seq_first,seq_last,accepted_count,
    placement_id,capture_config_id,dataset,firmware_version,raw_object_key,received_at,expires_at_ms,retain_until_ms) VALUES(?,?,?,?,?,?,1,1,1,?,?,?,'historical-only',?,?,?,?)`)
    .run(node,id,crypto.randomUUID(),'0'.repeat(64),boot,stream,config.placement_id,config.capture_config_id,'field',key,received,now+60000,now+100000);
  insert(batch, 'ble_windows', null);
  const item = fixture('ble-windows.request').items[0]; item.time.utc_ms = now - 1000;
  const args = [node, boot, batch, config.placement_id, config.capture_config_id, 'field', item.time.utc_ms, item.duration_ms, JSON.stringify(item), received, now+60000];
  if (version === 1) state.db.prepare(`INSERT INTO sensor_windows(node_id,boot_id,seq,batch_id,placement_id,capture_config_id,dataset,utc_ms,duration_ms,item_json,received_at,expires_at_ms)
    VALUES(?,?,1,?,?,?,?,?,?,?,?,?)`).run(...args);
  else state.db.prepare(`INSERT INTO ingestion_items_v2(node_id,boot_id,stream,seq,batch_id,placement_id,capture_config_id,dataset,utc_ms,duration_ms,item_json,received_at,expires_at_ms)
    VALUES(?,?,'ble_windows',1,?,?,?,?,?,?,?,?,?)`).run(...args);
  const key = `historical/v${version}/private-evidence.json`;
  insert(crypto.randomUUID(), 'ble_reports', key); state.raw.objects.set(key, new Uint8Array([1,2,3]));
}
const historicalTables = ['ingestion_batches','sensor_windows','node_status','ingestion_batches_v2','ingestion_items_v2','public_sensor_projection_v2','capture_configs'];
const history = () => Object.fromEntries(historicalTables.map(t => [t, state.db.prepare(`SELECT * FROM ${t}`).all()]));

it.each([1, 2])('retires every v%i device/research route without touching storage', async version => {
  const sql = vi.spyOn(env.DB, 'prepare');
  const routes = version === 1 ? ['/ingest','/device/config','/device/config/ack','/research/batches/33333333-3333-4333-8333-333333333333']
    : ['/ingest','/device/config','/device/config/ack','/device/contact','/research/batches/33333333-3333-4333-8333-333333333333'];
  for (const path of routes) for (const method of ['GET','POST']) {
    const response = await handleApi(new Request(`https://synthetic.test/api/v${version}${path}`, { method }), env);
    expect(response?.status).toBe(404);
  }
  expect(sql).not.toHaveBeenCalled();
});
it('retains upgraded V1/V2 source rows and private objects through the scheduled V3 cleanup', async () => {
  seedHistorical(1); seedHistorical(2); const ack = await upload();
  const before = history(), objects = [...state.raw.objects.entries()];
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(ack.expires_at) + 1);
  await worker.scheduled({ scheduledTime: Date.now(), cron: 'synthetic', noRetry() {} }, env);
  expect(history()).toEqual(before); expect([...state.raw.objects.entries()]).toEqual(objects);
  expect(state.db.prepare('SELECT item_json FROM statistics_windows_v3').get()?.item_json).toBeNull();
  expect(state.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it('never falls back to retained legacy public projections', async () => {
  seedHistorical(1); seedHistorical(2);
  expect(state.db.prepare('SELECT COUNT(*) AS n FROM public_sensor_projection_v2').get()?.n).toBeGreaterThan(0);
  const before = history();
  const response = await handleApi(new Request('https://synthetic.test/api/v1/places/library/summary'), env);
  expect(response?.status).toBe(200);
  expect(await response!.json()).toMatchObject({ sensor: null, last_reported_sensor: null, freshness: 'no_data' });
  expect(await readLastReportedSensor(env, 'library')).toBeNull(); expect(history()).toEqual(before);
});
it('serves V3 native policy identity and actual statistics through summary and history', async () => {
  await upload(); const now = Date.now();
  const windows = await readPublicWindows(env, 'library', now - 60000, now);
  expect(windows).toHaveLength(1);
  expect(windows[0]).toMatchObject({ protocol: 'campuspulse/3', policy_id: source.policy.policy_id, assignment_generation: 1,
    visible_identifiers: 2, reports_aggregated: 4, aggregation_drops: 0, freshness: 'fresh' });
  expect(windows[0]).not.toHaveProperty('capture_config_id');
  for (const route of ['summary','history']) {
    const response = await handleApi(new Request(`https://synthetic.test/api/v1/places/library/${route}`), env);
    expect(response?.status).toBe(200); expect(response?.headers.get('X-CampusPulse-Projection')).toBe('statistics-v3');
    const result = await response!.json() as any;
    expect(route === 'summary' ? result.sensor : result.sensor_windows[0]).toEqual(windows[0]);
  }
});
it('preserves V3 loss quality and never presents unclassified categories as zero vehicles', async () => {
  await upload(true);
  const windows = await readPublicWindows(env, 'library', Date.now() - 60000);
  expect(windows[0]).toMatchObject({ unique_table_overflow: true, quality_flags: ['identifier_overflow'] });
  const auto = await readAutomaticObservations(env, place, windows, Date.now());
  expect(auto.vehicles).toMatchObject({ status: 'unavailable', reason: 'classification_unavailable', candidate_count: null,
    car_related_count: null, ecosystem_count: null, model_version: 'unclassified-v1' });
  expect(auto.elevator).toMatchObject({ status: 'unavailable', reason: 'no_manual_samples' });
});
it('withholds controlled-test data from both public API families', async () => {
  source.policy.custody.dataset = 'controlled_test'; source.policy.custody.purpose = 'controlled_test';
  await upload(); expect(await readPublicWindows(env, 'library', 0)).toEqual([]);
  const response = await handleApi(new Request('https://synthetic.test/api/v3/places/library/statistics'), env);
  expect(await response!.json()).toMatchObject({ state: 'unavailable', visible_identifiers: null });
});
it.each(['lease','disabled_node','uncertain_clock'])('withholds V3 windows after invalid %s source authority', async kind => {
  await upload();
  if (kind === 'lease') state.db.prepare('DELETE FROM device_statistics_lease_spans_v3').run();
  if (kind === 'disabled_node') state.db.prepare('UPDATE device_nodes SET enabled=0').run();
  if (kind === 'uncertain_clock') state.db.prepare('UPDATE statistics_windows_v3 SET uncertainty_ms=5001').run();
  expect(await readPublicWindows(env, 'library', 0)).toEqual([]);
});
it('rejects inconsistent stored payload instead of returning a plausible aggregate', async () => {
  await upload(); state.db.prepare("UPDATE statistics_windows_v3 SET item_json=json_set(item_json,'$.seq',999)").run();
  await expect(readPublicWindows(env, 'library', 0)).rejects.toThrow('Inconsistent source');
});
it('does not access any retired source table for V3 public reads', async () => {
  await upload(); const prepare = env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB, 'prepare').mockImplementation(sql => {
    if (/\b(?:ingestion_batches(?:_v2)?|ingestion_items_v2|sensor_windows|node_status|public_sensor_projection_v2|capture_configs)\b/.test(sql)) throw new Error('Retired source read');
    return prepare(sql);
  });
  expect((await readPublicWindows(env, 'library', 0))).toHaveLength(1);
});

it('upgrades a populated pre-V3 database without changing retained V1/V2 history', async () => {
  state.db.close(); const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  const names = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  const migrate = (name: string) => db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  names.filter(name => Number(name.slice(0, 4)) <= 12).forEach(migrate);
  state = { ...state, db, env: { ...state.env, DB: sqliteD1(db) } }; env = { ...state.env, ...STATISTICS_FLAGS };
  db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').run(state.config.node_id, await sha256(new TextEncoder().encode(DEVICE_TOKEN)));
  db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,0)').run(state.config.placement_id, state.config.node_id, 'library');
  seedConfig(db, state.config); seedHistorical(1); seedHistorical(2);
  const before = history(), objects = [...state.raw.objects.entries()];
  names.filter(name => Number(name.slice(0, 4)) > 12).forEach(migrate);
  expect(history()).toEqual(before); expect([...state.raw.objects.entries()]).toEqual(objects);
  await upload(); expect((await readPublicWindows(env, 'library', 0))).toHaveLength(1);
  expect(history()).toEqual(before); expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

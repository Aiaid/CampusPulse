import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { expireIngestion, expirePublicProjections } from '../worker/retention';
import { commitBatchV2 } from '../worker/device-v2-store';
import { validateEnvelopeV2 } from '../worker/device-v2-validation';
import { fixture, setup } from './helpers/ingestion';

let state: Awaited<ReturnType<typeof setup>>;
const NOW = Date.parse('2026-10-29T05:00:00.000Z');
beforeEach(async () => {
  state = await setup();
  const config = fixture('capture-config-v2.fixture');
  config.dataset = 'field'; config.accept_until = new Date(NOW + 10 * 86400000).toISOString();
  state.db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)')
    .run(config.capture_config_id, config.node_id, config.placement_id, 'field', JSON.stringify(config), Date.parse(config.accept_until));
  const source = fixture('ble-windows-v2.request'); source.dataset = 'field';
  source.items[0].time.utc_ms = NOW - 1000; source.items[0].time.uncertainty_ms = 10;
  await commitBatchV2(state.env.DB, validateEnvelopeV2(source), 'a'.repeat(64), null, 24, 1,
    Date.parse(config.accept_until), NOW);
});
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });
const count = (table: string) => state.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n;

it('prunes the derived sensor cache without deleting source items, receipts or stale manual evidence', async () => {
  state.db.prepare(`INSERT INTO observations(id,place_id,kind,observed_at,valid_until,received_at,wait_seconds)
    VALUES('synthetic-stale','teaching-elevator','elevator',?,?,?,30)`)
    .run(new Date(NOW - 86400000).toISOString(), new Date(NOW - 3600000).toISOString(), new Date(NOW).toISOString());
  const canonical = state.db.prepare('SELECT * FROM ingestion_items_v2').all();
  expect(await expirePublicProjections(state.env, NOW + 86400000)).toBe(1);
  expect(count('public_sensor_projection_v2')).toBe(0);
  expect(state.db.prepare('SELECT * FROM ingestion_items_v2').all()).toEqual(canonical);
  expect(count('ingestion_batches_v2')).toBe(1);
  expect(count('public_observation_projection')).toBe(1);
  expect(state.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('retains unexpired candidates and uses the expiry index', async () => {
  expect(await expirePublicProjections(state.env, NOW)).toBe(0);
  expect(count('public_sensor_projection_v2')).toBe(1);
  const plan = state.db.prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM public_sensor_projection_v2
    WHERE expires_at_ms<=? LIMIT 5000`).all(NOW).map(row => String(row.detail)).join('\n');
  expect(plan).toContain('public_sensor_projection_v2_expiry');
});

it('bounds each cache cleanup and resumes without deleting canonical history', async () => {
  // Synthetic retained-storage load; ingestion/replay correctness is exercised
  // by the real-envelope suites, not inferred from this maintenance fixture.
  state.db.exec(`WITH RECURSIVE counter(n) AS (VALUES(2) UNION ALL SELECT n+1 FROM counter WHERE n<5002)
    INSERT INTO ingestion_items_v2(node_id,boot_id,stream,seq,batch_id,placement_id,capture_config_id,dataset,
      utc_ms,duration_ms,window_seq,item_json,received_at,expires_at_ms)
    SELECT w.node_id,w.boot_id,w.stream,counter.n,w.batch_id,w.placement_id,w.capture_config_id,w.dataset,
      w.utc_ms,w.duration_ms,NULL,json_set(w.item_json,'$.seq',counter.n),w.received_at,w.expires_at_ms
    FROM ingestion_items_v2 w CROSS JOIN counter WHERE w.seq=1`);
  expect(count('public_sensor_projection_v2')).toBe(5002);
  expect(await expirePublicProjections(state.env, NOW + 86400000)).toBe(5000);
  expect(count('public_sensor_projection_v2')).toBe(2);
  expect(await expirePublicProjections(state.env, NOW + 86400000)).toBe(2);
  expect(count('ingestion_items_v2')).toBe(5002);
  expect(count('ingestion_batches_v2')).toBe(1);
});

it('continues authoritative retention when the derived-cache maintenance fails', async () => {
  const original = state.env.DB.prepare.bind(state.env.DB);
  state.env.DB.prepare = ((sql: string) => {
    if (sql.startsWith('DELETE FROM public_sensor_projection_v2')) throw new Error('synthetic cache unavailable');
    return original(sql);
  }) as typeof state.env.DB.prepare;
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expireIngestion(state.env, NOW + 2 * 86400000);
  expect(count('ingestion_items_v2')).toBe(0);
  expect(count('public_sensor_projection_v2')).toBe(0);
  expect(log).toHaveBeenCalledWith('{"event":"public_projection_retention_failed"}');
});

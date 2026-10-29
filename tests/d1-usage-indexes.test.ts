import { afterEach, beforeEach, expect, it } from 'vitest';
import { commitBatchV2 } from '../worker/device-v2-store';
import { validateEnvelopeV2, type CaptureConfigV2 } from '../worker/device-v2-validation';
import { fixture, setup } from './helpers/ingestion';

let state: Awaited<ReturnType<typeof setup>>;
let config: CaptureConfigV2;
let boot: string;
beforeEach(async () => {
  state = await setup(); config = fixture('capture-config-v2.fixture');
  config.accept_until = new Date(Date.now() + 86400000).toISOString();
  state.db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)')
    .run(config.capture_config_id, config.node_id, config.placement_id, config.dataset, JSON.stringify(config), Date.parse(config.accept_until));
  boot = crypto.randomUUID();
});
afterEach(() => state.db.close());
const commit = (sequences: number[]) => {
  const source = fixture('ble-windows-v2.request');
  const batch = validateEnvelopeV2({ ...source, boot_id: boot, batch_id: crypto.randomUUID(),
    items: sequences.map(seq => ({ ...structuredClone(source.items[0]), seq })) });
  return commitBatchV2(state.env.DB, batch, 'a'.repeat(64), null, 24, 30,
    Date.parse(config.accept_until), Date.now());
};

it('preserves out-of-order backfill, gaps and inclusive overlap rejection', async () => {
  await commit([100, 110]); await commit([10, 20]); await commit([21]); await commit([99]);
  for (const sequences of [[20], [100], [110], [9, 11], [90, 120]])
    await expect(commit(sequences)).rejects.toMatchObject({ code: 'seq_range_overlap' });
  await commit([111]);
  expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v2').get()?.n).toBe(5);
  expect(state.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('uses sequence ends for overlap probes and a batch key for child retention', () => {
  const range = state.db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ingestion_batches_v2
    WHERE node_id=? AND boot_id=? AND stream=? AND seq_first<=? AND seq_last>=?`)
    .all(config.node_id, boot, 'ble_windows', 200, 190).map(row => String(row.detail)).join('\n');
  expect(range).toMatch(/ingestion_v2_range.*seq_last>/);
  const children = state.db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ingestion_items_v2
    WHERE node_id=? AND batch_id=?`).all(config.node_id, 'synthetic-batch')
    .map(row => String(row.detail)).join('\n');
  expect(children).toMatch(/ingestion_items_v2_batch.*node_id=\? AND batch_id=\?/);
});

it('keeps private identity uniqueness and limits partial indexes to their streams', () => {
  const schema = state.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index'").all();
  const sql = (name: string) => String(schema.find(row => row.name === name)?.sql);
  expect(sql('ingestion_items_v2_admin_latest')).toContain("WHERE stream='node_status'");
  expect(sql('ingestion_items_v2_place')).toContain("WHERE stream='ble_windows'");
  expect(sql('ingestion_v2_expiry')).toContain('WHERE raw_object_key IS NOT NULL');
  for (const name of ['ingestion_items_v2_window', 'ingestion_items_v2_received', 'ingestion_v2_received'])
    expect(schema.some(row => row.name === name)).toBe(false);
  expect(state.db.prepare('PRAGMA index_list(ingestion_items_v2)').all()
    .filter(row => row.origin === 'u' || row.origin === 'pk')).toHaveLength(2);
});

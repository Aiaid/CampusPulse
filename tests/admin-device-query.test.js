import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEVICE_SELECT, DEVICE_PLACEMENTS_SELECT } from '../worker/admin-device-query';
import { fixture, seedConfig, setup } from './helpers/ingestion';

let state, v2, sequence;
beforeEach(async () => {
  state = await setup(); v2 = fixture('capture-config-v2.fixture');
  v2.accept_until = state.config.accept_until; seedConfig(state.db, v2); sequence = 0;
});
afterEach(() => state.db.close());
const read = () => state.db.prepare(`${DEVICE_SELECT} WHERE n.id=?`).all(state.config.node_id);

function insertBatch(version, id, received, items = [{}], stream = 'node_status', boot = 'synthetic-query-boot') {
  const config = version === 1 ? state.config : v2, first = sequence + 1;
  sequence += items.length;
  const table = version === 1 ? 'ingestion_batches' : 'ingestion_batches_v2';
  state.db.prepare(`INSERT INTO ${table}(node_id,batch_id,receipt_id,body_sha256,boot_id,stream,seq_first,seq_last,accepted_count,placement_id,capture_config_id,dataset,firmware_version,received_at,expires_at_ms,retain_until_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(config.node_id,id,`receipt-${id}`,'a'.repeat(64),boot,stream,first,sequence,items.length,config.placement_id,config.capture_config_id,config.dataset,`synthetic-v${version}`,received,2100000000000,2100000000000);
  items.forEach((item, index) => {
    const values = [config.node_id,boot,first+index,id,config.placement_id,config.capture_config_id,config.dataset,item.utc_ms ?? null,JSON.stringify({ ...item, seq: first+index }),received,2100000000000];
    if (version === 1) {
      const itemTable = stream === 'node_status' ? 'node_status' : 'sensor_windows';
      state.db.prepare(`INSERT INTO ${itemTable}(node_id,boot_id,seq,batch_id,placement_id,capture_config_id,dataset,utc_ms,item_json,received_at,expires_at_ms${stream === 'ble_windows' ? ',duration_ms' : ''}) VALUES(?,?,?,?,?,?,?,?,?,?,?${stream === 'ble_windows' ? ',?' : ''})`)
        .run(...values,...(stream === 'ble_windows' ? [item.duration_ms ?? 30000] : []));
    } else state.db.prepare('INSERT INTO ingestion_items_v2(node_id,boot_id,seq,batch_id,placement_id,capture_config_id,dataset,utc_ms,item_json,received_at,expires_at_ms,stream,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(...values,stream,item.duration_ms ?? 30000);
  });
}

it('returns a single registry row before history exists', () => {
  expect(read()).toHaveLength(1);
  expect(read()[0]).toMatchObject({ last_seen_at: null, ingestion_batch_id: null, status_json: null });
});

it('preserves cross-version receive-time and batch-id order and chooses one status item', () => {
  insertBatch(1, 'v1-a', '2026-10-29T00:00:02.000Z', [{ marker: 'v1-first' }, { marker: 'v1-last' }]);
  insertBatch(2, 'v2-older', '2026-10-29T00:00:01.000Z', [{ marker: 'older' }]);
  let rows = read(); expect(rows).toHaveLength(1);
  expect(rows[0].ingestion_batch_id).toBe('v1-a'); expect(JSON.parse(rows[0].status_json).marker).toBe('v1-last');
  insertBatch(2, 'v2-z', '2026-10-29T00:00:02.000Z', [{ marker: 'v2-first' }, { marker: 'v2-last' }]);
  rows = read(); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ingestion_batch_id: 'v2-z', firmware_version: 'synthetic-v2', status_batch_id: 'v2-z' });
  expect(JSON.parse(rows[0].status_json).marker).toBe('v2-last');
  insertBatch(1, 'zz-v1', '2026-10-29T00:00:02.000Z', [{ marker: 'tie-v1' }]);
  expect(read()[0]).toMatchObject({ ingestion_batch_id: 'zz-v1', status_batch_id: 'zz-v1' });
  insertBatch(2, 'new-window', '2026-10-29T00:00:03.000Z', [{}], 'ble_windows');
  expect(read()[0]).toMatchObject({ ingestion_batch_id: 'new-window', status_batch_id: 'zz-v1', status_received_at: '2026-10-29T00:00:02.000Z' });
});

it('keeps placement incompatibility counts across versions, null timestamps, and closed intervals', () => {
  state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
    .run(state.config.placement_id,state.config.node_id,100000,'2026-10-29T00:00:00.000Z');
  for (const version of [1,2]) insertBatch(version, `window-${version}`, '2026-10-29T00:00:00.000Z', [
    { utc_ms: 1000, duration_ms: 30000 }, { utc_ms: 90000, duration_ms: 30000 }, { utc_ms: null, duration_ms: 30000 },
  ], 'ble_windows');
  const placements = state.db.prepare(DEVICE_PLACEMENTS_SELECT).all(state.config.node_id);
  expect(placements).toHaveLength(1);
  expect(placements[0]).toMatchObject({ incompatible_window_count: 2, effective_valid_until_ms: 100000 });
});

it('uses bounded indexed latest-record probes with 6000 historical batches and tied timestamps', () => {
  state.db.exec('BEGIN');
  for (let i=0; i<6000; i++) insertBatch(2, `history-${String(i).padStart(6,'0')}`, '2026-10-29T00:00:00.000Z', [{ marker: i }], i%10 ? 'ble_windows' : 'node_status', `boot-${i}`);
  state.db.exec('COMMIT');
  const rows = read(); expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ingestion_batch_id: 'history-005999', status_batch_id: 'history-005990' });
  expect(JSON.parse(rows[0].status_json).marker).toBe(5990);
  const plans = state.db.prepare(`EXPLAIN QUERY PLAN ${DEVICE_SELECT} WHERE n.id=?`).all(state.config.node_id).map(row => row.detail).join('\n');
  expect(plans).not.toMatch(/MATERIALIZE|SCAN (?:ingestion|node_status|[bs][12])|USE TEMP B-TREE/);
  for (const index of ['ingestion_batches_received','ingestion_v2_admin_latest','node_status_admin_latest','ingestion_items_v2_admin_latest']) expect(plans).toContain(index);
  expect(state.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

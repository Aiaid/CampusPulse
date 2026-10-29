import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { commitBatchV2 } from '../worker/device-v2-store';
import { validateEnvelopeV2 } from '../worker/device-v2-validation';
import { fixture, sqliteD1 } from './helpers/ingestion';

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const migration = readFileSync(new URL('../migrations/0011_public_projections.sql', import.meta.url), 'utf8');
let db: DatabaseSync;
let serial: number;
const node = 'projection-test-node', placement = 'projection-test-placement', fieldConfig = 'projection-field-config';

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 10).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  serial = 0;
  db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').run(node, 'b'.repeat(64));
  db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,?)').run(placement, node, 'library', NOW - 7 * 86400000);
  registerConfig(fieldConfig, 'field');
});
afterEach(() => db.close());

function registerConfig(id: string, dataset: 'field' | 'demo' | 'controlled_test', placementId = placement) {
  const config = { ...fixture('capture-config-v2.fixture'), capture_config_id: id, node_id: node,
    placement_id: placementId, dataset, accept_until: iso(NOW + 30 * 86400000) };
  db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)')
    .run(id, node, placementId, dataset, JSON.stringify(config), Date.parse(config.accept_until));
}

function insertItem(options: {
  stream?: 'ble_windows' | 'node_status' | 'address_summaries'; dataset?: 'field' | 'demo' | 'controlled_test';
  config?: string; placement?: string; boot?: string; seq?: number; utc?: number | null;
  uncertainty?: number | null; received?: number; expiry?: number; flags?: string[];
} = {}) {
  serial++;
  const stream = options.stream ?? 'ble_windows', seq = options.seq ?? serial, boot = options.boot ?? 'synthetic-projection-boot';
  const dataset = options.dataset ?? 'field', config = options.config ?? fieldConfig, location = options.placement ?? placement;
  const item = fixture(stream === 'ble_windows' ? 'ble-windows-v2.request' : stream === 'node_status' ? 'node-status-v2.request' : 'address-summaries-v2.request').items[0];
  const utc = options.utc === undefined ? NOW - 1000 : options.utc;
  Object.assign(item, { seq, quality_flags: options.flags ?? [] });
  Object.assign(item.time, { utc_ms: utc, uncertainty_ms: options.uncertainty === undefined ? utc === null ? null : 20 : options.uncertainty });
  const received = iso(options.received ?? NOW), expiry = options.expiry ?? NOW + 86400000, batch = `synthetic-batch-${serial}`;
  db.prepare(`INSERT INTO ingestion_batches_v2(node_id,batch_id,receipt_id,body_sha256,boot_id,stream,seq_first,seq_last,
    accepted_count,placement_id,capture_config_id,dataset,firmware_version,received_at,expires_at_ms,retain_until_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(node, batch, `receipt-${serial}`, 'a'.repeat(64), boot, stream, seq, seq, 1, location, config, dataset, 'synthetic', received, expiry, Math.max(expiry, NOW + 37 * 86400000));
  db.prepare(`INSERT INTO ingestion_items_v2(node_id,boot_id,stream,seq,batch_id,placement_id,capture_config_id,dataset,
    utc_ms,duration_ms,window_seq,address,address_type,item_json,received_at,expires_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(node, boot, stream, seq, batch, location, config, dataset, utc, item.duration_ms ?? null, item.window_seq ?? null,
      item.address ?? null, item.address_type ?? null, JSON.stringify(item), received, expiry);
  return { node, boot, stream, seq, batch, item };
}

function insertObservation(id: string, observed: number, status = 'active') {
  db.prepare(`INSERT INTO observations(id,place_id,kind,status,observed_at,valid_until,received_at,wait_seconds)
    VALUES(?,'teaching-elevator','elevator',?,?,?,?,?)`)
    .run(id, status, iso(observed), iso(observed + 60000), iso(NOW), 30);
}
const projected = (seq: number, boot = 'synthetic-projection-boot') => db.prepare('SELECT * FROM public_sensor_projection_v2 WHERE node_id=? AND boot_id=? AND seq=?').get(node, boot, seq);
const sourceRows = () => db.prepare('SELECT * FROM ingestion_items_v2 ORDER BY node_id,boot_id,stream,seq').all();

it('bootstraps eligible candidates without changing any canonical rows or source constraints', () => {
  insertItem(); insertItem({ utc: null }); insertItem({ flags: ['unknown_quality_flag'] });
  insertItem({ stream: 'address_summaries' }); insertItem({ stream: 'node_status' });
  registerConfig('projection-demo', 'demo'); insertItem({ config: 'projection-demo', dataset: 'demo' });
  insertObservation('active-stale', NOW - 86400000); insertObservation('cancelled', NOW - 1000, 'cancelled');
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => String(row.name));
  const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]));
  const before = snapshot();
  const constraints = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all();
  db.exec(migration);
  expect(snapshot()).toEqual(before);
  for (const trigger of constraints) expect(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(trigger.name)?.sql).toBe(trigger.sql);
  expect(db.prepare('SELECT seq,timed_eligible,unverified_eligible FROM public_sensor_projection_v2 ORDER BY seq').all()).toEqual([
    { seq: 1, timed_eligible: 1, unverified_eligible: 0 }, { seq: 2, timed_eligible: 0, unverified_eligible: 1 },
    { seq: 3, timed_eligible: 0, unverified_eligible: 0 },
  ]);
  expect(db.prepare('SELECT id FROM public_observation_projection').all()).toEqual([{ id: 'active-stale' }]);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('processes delayed measurements and tied receipt times incrementally by complete source identity', () => {
  insertItem({ seq: 1, utc: NOW - 1000, received: NOW });
  db.exec(migration);
  const before = projected(1);
  insertItem({ seq: 2, utc: NOW - 3600000, received: NOW });
  insertItem({ seq: 1, boot: 'second-boot', utc: NOW - 2000, received: NOW });
  expect(projected(1)).toEqual(before);
  expect(db.prepare('SELECT COUNT(*) AS n FROM public_sensor_projection_v2').get()?.n).toBe(3);
  expect(projected(2)).toMatchObject({ utc_ms: NOW - 3600000, received_at: iso(NOW), timed_eligible: 1 });
  expect(projected(1, 'second-boot')).toMatchObject({ boot_id: 'second-boot', seq: 1 });
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('updates classification and receipt metadata and leaves expiry filtering dynamic until source deletion', () => {
  db.exec(migration);
  const source = insertItem({ utc: null });
  expect(projected(source.seq)).toMatchObject({ timed_eligible: 0, unverified_eligible: 1 });
  source.item.time = { ...source.item.time, utc_ms: NOW - 1000, uncertainty_ms: 20 };
  db.prepare('UPDATE ingestion_items_v2 SET utc_ms=?,item_json=?,received_at=?,expires_at_ms=? WHERE node_id=? AND boot_id=? AND stream=? AND seq=?')
    .run(NOW - 1000, JSON.stringify(source.item), iso(NOW + 1), NOW, node, source.boot, source.stream, source.seq);
  expect(projected(source.seq)).toMatchObject({ timed_eligible: 1, unverified_eligible: 0, received_at: iso(NOW + 1), expires_at_ms: NOW });
  expect(db.prepare('SELECT COUNT(*) AS n FROM public_sensor_projection_v2 WHERE timed_eligible=1 AND expires_at_ms>?').get(NOW)?.n).toBe(0);
  expect(projected(source.seq)).toBeDefined();
  db.prepare('DELETE FROM ingestion_items_v2 WHERE node_id=? AND boot_id=? AND stream=? AND seq=?').run(node, source.boot, source.stream, source.seq);
  expect(projected(source.seq)).toBeUndefined();
  expect(db.prepare('SELECT COUNT(*) AS n FROM ingestion_batches_v2').get()?.n).toBe(1);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('fails closed for missing, scalar, null or non-string quality flags at bootstrap and update', () => {
  const malformed: unknown[] = [undefined, null, 'partial_window', 0, [null], [1], [{ flag: 'partial_window' }]];
  for (const qualityFlags of malformed) {
    for (const utc of [NOW - 1000, null]) {
      const source = insertItem({ utc });
      if (qualityFlags === undefined) delete source.item.quality_flags;
      else source.item.quality_flags = qualityFlags;
      db.prepare('UPDATE ingestion_items_v2 SET item_json=? WHERE batch_id=?').run(JSON.stringify(source.item), source.batch);
    }
  }
  const original = sourceRows();
  db.exec(migration);
  expect(sourceRows()).toEqual(original);
  expect(db.prepare('SELECT COUNT(*) AS n FROM public_sensor_projection_v2').get()?.n).toBe(malformed.length * 2);
  expect(db.prepare('SELECT COUNT(*) AS n FROM public_sensor_projection_v2 WHERE timed_eligible=1 OR unverified_eligible=1').get()?.n).toBe(0);
  const fresh = insertItem({ utc: null });
  expect(projected(fresh.seq)?.unverified_eligible).toBe(1);
  fresh.item.quality_flags = [null];
  db.prepare('UPDATE ingestion_items_v2 SET item_json=? WHERE batch_id=?').run(JSON.stringify(fresh.item), fresh.batch);
  expect(projected(fresh.seq)).toMatchObject({ timed_eligible: 0, unverified_eligible: 0 });
});

it('can rebuild both disposable projections exactly from canonical data without deleting history', () => {
  db.exec(migration);
  insertItem(); insertItem({ utc: null }); insertItem({ flags: ['unknown_quality_flag'] });
  insertObservation('stale-active', NOW - 86400000); insertObservation('cancelled-source', NOW, 'cancelled');
  const windows = db.prepare('SELECT * FROM public_sensor_projection_v2 ORDER BY node_id,boot_id,stream,seq').all();
  const manual = db.prepare('SELECT * FROM public_observation_projection ORDER BY id').all();
  const originalWindows = sourceRows(), originalManual = db.prepare('SELECT * FROM observations ORDER BY id').all();
  db.exec(`BEGIN;
    DELETE FROM public_sensor_projection_v2;
    DELETE FROM public_observation_projection;
    INSERT INTO public_sensor_projection_v2 SELECT * FROM public_sensor_projection_source_v2;
    INSERT INTO public_observation_projection
      SELECT id,place_id,kind,source,status,observed_at,valid_until,received_at,cancelled_at,parking_min,parking_max,wait_seconds
      FROM observations WHERE status='active';
    COMMIT;`);
  expect(db.prepare('SELECT * FROM public_sensor_projection_v2 ORDER BY node_id,boot_id,stream,seq').all()).toEqual(windows);
  expect(db.prepare('SELECT * FROM public_observation_projection ORDER BY id').all()).toEqual(manual);
  expect(sourceRows()).toEqual(originalWindows);
  expect(db.prepare('SELECT * FROM observations ORDER BY id').all()).toEqual(originalManual);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('does not rewrite either projection when source UPDATE values are unchanged, including null fields', () => {
  db.exec(migration);
  insertItem({ utc: null });
  insertObservation('unchanged-manual', NOW - 1000);
  const beforeSource = sourceRows(), beforeManual = db.prepare('SELECT * FROM observations').all();
  const beforeProjection = db.prepare('SELECT * FROM public_sensor_projection_v2').all();
  const beforeManualProjection = db.prepare('SELECT * FROM public_observation_projection').all();
  const changes = () => Number(db.prepare('SELECT total_changes() AS n').get()?.n);
  let before = changes();
  db.exec(`UPDATE ingestion_items_v2 SET node_id=node_id,boot_id=boot_id,stream=stream,seq=seq,batch_id=batch_id,
    placement_id=placement_id,capture_config_id=capture_config_id,dataset=dataset,utc_ms=utc_ms,
    duration_ms=duration_ms,item_json=item_json,received_at=received_at,expires_at_ms=expires_at_ms`);
  expect(changes() - before).toBe(1); // Canonical UPDATE only; no projection DELETE/INSERT.
  before = changes();
  db.exec(`UPDATE observations SET id=id,place_id=place_id,kind=kind,source=source,status=status,
    observed_at=observed_at,valid_until=valid_until,received_at=received_at,cancelled_at=cancelled_at,
    parking_min=parking_min,parking_max=parking_max,wait_seconds=wait_seconds`);
  expect(changes() - before).toBe(1);
  expect(sourceRows()).toEqual(beforeSource);
  expect(db.prepare('SELECT * FROM observations').all()).toEqual(beforeManual);
  expect(db.prepare('SELECT * FROM public_sensor_projection_v2').all()).toEqual(beforeProjection);
  expect(db.prepare('SELECT * FROM public_observation_projection').all()).toEqual(beforeManualProjection);
});

it('reclassifies closure boundaries without altering historical windows and retains immutable closure guards', () => {
  db.exec(migration);
  insertItem({ seq: 1, utc: NOW - 1000 });
  insertItem({ seq: 2, utc: NOW - 2000 });
  insertItem({ seq: 3, utc: null, received: NOW - 1000 });
  insertItem({ seq: 4, utc: null, received: NOW - 1001 });
  const original = sourceRows();
  db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
    .run(placement, node, NOW - 1000, iso(NOW));
  expect(projected(1)?.timed_eligible).toBe(0); // uncertainty extends beyond the inclusive timed boundary
  expect(projected(2)?.timed_eligible).toBe(1);
  expect(projected(3)?.unverified_eligible).toBe(0); // receipt end is exclusive
  expect(projected(4)?.unverified_eligible).toBe(1);
  expect(() => db.prepare('UPDATE placement_closures SET valid_until_ms=?').run(NOW)).toThrow(/placement_closure_immutable/);
  expect(() => db.exec('DELETE FROM placement_closures')).toThrow(/placement_closure_immutable/);
  expect(sourceRows()).toEqual(original);

  // Exercise defensive projection maintenance independently of the unchanged
  // production immutability guards; the migration itself never removes them.
  db.exec('DROP TRIGGER placement_closures_immutable_update; DROP TRIGGER placement_closures_immutable_delete');
  db.prepare('UPDATE placement_closures SET valid_until_ms=?').run(NOW + 1000);
  expect(projected(1)?.timed_eligible).toBe(1);
  expect(projected(3)?.unverified_eligible).toBe(1);
  db.exec('DELETE FROM placement_closures');
  expect(sourceRows()).toEqual(original);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('does not resurrect pruned expired cache rows on closure changes but recreates genuinely changed sources', () => {
  db.exec(migration);
  const expired = insertItem({ expiry: NOW });
  insertItem({ expiry: NOW + 86400000 });
  const original = sourceRows();
  db.prepare('DELETE FROM public_sensor_projection_v2 WHERE expires_at_ms<=?').run(NOW);
  expect(projected(expired.seq)).toBeUndefined();
  db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
    .run(placement, node, NOW - 2000, iso(NOW));
  expect(projected(expired.seq)).toBeUndefined();
  expect(projected(2)?.timed_eligible).toBe(0);
  db.exec('DROP TRIGGER placement_closures_immutable_update; DROP TRIGGER placement_closures_immutable_delete');
  db.prepare('UPDATE placement_closures SET valid_until_ms=?').run(NOW + 1000);
  expect(projected(expired.seq)).toBeUndefined();
  expect(projected(2)?.timed_eligible).toBe(1);
  db.exec('DELETE FROM placement_closures');
  expect(projected(expired.seq)).toBeUndefined();
  expect(sourceRows()).toEqual(original);
  db.prepare('UPDATE ingestion_items_v2 SET expires_at_ms=? WHERE node_id=? AND boot_id=? AND stream=? AND seq=?')
    .run(NOW + 86400000, node, expired.boot, expired.stream, expired.seq);
  expect(projected(expired.seq)).toMatchObject({ timed_eligible: 1, expires_at_ms: NOW + 86400000 });
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('maintains active manual history across late inserts, cancellation, recovery, updates and deletion', () => {
  insertObservation('older', NOW - 86400000);
  db.exec(migration);
  insertObservation('latest', NOW - 1000);
  insertObservation('late-backfill', NOW - 2 * 86400000);
  const latest = () => db.prepare("SELECT id FROM public_observation_projection WHERE place_id='teaching-elevator' ORDER BY observed_at DESC,id DESC LIMIT 1").get()?.id;
  expect(latest()).toBe('latest');
  db.prepare("UPDATE observations SET status='cancelled',cancelled_at=? WHERE id='latest'").run(iso(NOW));
  expect(latest()).toBe('older');
  expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get()?.n).toBe(3);
  db.exec("UPDATE observations SET status='active',cancelled_at=NULL,wait_seconds=50 WHERE id='latest'");
  expect(latest()).toBe('latest');
  expect(db.prepare("SELECT wait_seconds FROM public_observation_projection WHERE id='latest'").get()?.wait_seconds).toBe(50);
  db.exec("DELETE FROM observations WHERE id='latest'");
  expect(latest()).toBe('older');
  expect(db.prepare("SELECT id FROM public_observation_projection WHERE valid_until<? ORDER BY id").all(iso(NOW)))
    .toEqual([{ id: 'late-backfill' }, { id: 'older' }]);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('keeps projection changes atomic with receipts and exact retries perform no additional writes', async () => {
  db.exec(migration);
  const batch = fixture('ble-windows-v2.request');
  Object.assign(batch, { node_id: node, placement_id: placement, capture_config_id: fieldConfig, dataset: 'field' });
  batch.items[0].time.utc_ms = NOW - 1000;
  const validated = validateEnvelopeV2(batch), d1 = sqliteD1(db);
  db.exec("CREATE TRIGGER synthetic_projection_failure AFTER INSERT ON public_sensor_projection_v2 BEGIN SELECT RAISE(ABORT,'synthetic projection failure'); END;");
  await expect(commitBatchV2(d1, validated, 'a'.repeat(64), null, 24, 7, NOW + 86400000, NOW)).rejects.toThrow();
  expect(db.prepare('SELECT COUNT(*) AS n FROM ingestion_batches_v2').get()?.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM ingestion_items_v2').get()?.n).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS n FROM public_sensor_projection_v2').get()?.n).toBe(0);
  db.exec('DROP TRIGGER synthetic_projection_failure');
  const ack = await commitBatchV2(d1, validated, 'a'.repeat(64), null, 24, 7, NOW + 86400000, NOW);
  const changes = db.prepare('SELECT total_changes() AS n').get()?.n;
  expect(await commitBatchV2(d1, validated, 'a'.repeat(64), null, 24, 7, NOW + 86400000, NOW + 1)).toEqual(ack);
  expect(db.prepare('SELECT total_changes() AS n').get()?.n).toBe(changes);
  expect(db.prepare('SELECT COUNT(*) AS n FROM public_sensor_projection_v2').get()?.n).toBe(1);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('excludes unlocated or corrupt config scope and never projects other streams or datasets', () => {
  db.exec(migration);
  insertItem({ stream: 'address_summaries' }); insertItem({ stream: 'node_status' });
  registerConfig('projection-controlled', 'controlled_test');
  insertItem({ config: 'projection-controlled', dataset: 'controlled_test' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM public_sensor_projection_v2').get()?.n).toBe(0);
  const source = insertItem();
  expect(projected(source.seq)).toBeDefined();
  db.exec('PRAGMA foreign_keys=OFF');
  db.prepare('UPDATE ingestion_items_v2 SET capture_config_id=? WHERE batch_id=?').run('missing-scope', source.batch);
  expect(projected(source.seq)).toBeUndefined();
  db.prepare('UPDATE ingestion_items_v2 SET capture_config_id=? WHERE batch_id=?').run(fieldConfig, source.batch);
  db.exec('PRAGMA foreign_keys=ON');
  expect(projected(source.seq)).toBeDefined();
  db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
    .run(placement, node, NOW + 1000, iso(NOW));
  db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,NULL,?)')
    .run('projection-unlocated', node, NOW + 1000);
  registerConfig('projection-unlocated-config', 'field', 'projection-unlocated');
  const unlocated = insertItem({ config: 'projection-unlocated-config', placement: 'projection-unlocated', utc: null, received: NOW + 2000 });
  expect(projected(unlocated.seq)).toBeUndefined();
  expect(db.prepare('SELECT COUNT(*) AS n FROM ingestion_items_v2 WHERE batch_id=?').get(unlocated.batch)?.n).toBe(1);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('uses full source identity for incremental maintenance and bounded public indexes for reads', () => {
  db.exec(migration);
  insertItem(); insertItem({ utc: null });
  const maintenance = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM public_sensor_projection_source_v2 WHERE node_id=? AND boot_id=? AND stream=? AND seq=?')
    .all(node, 'synthetic-projection-boot', 'ble_windows', 1).map(row => String(row.detail)).join('\n');
  expect(maintenance).toContain('sqlite_autoindex_ingestion_items_v2_1 (node_id=? AND boot_id=? AND stream=? AND seq=?)');
  expect(maintenance).not.toMatch(/SCAN w|SCAN (?:placements|capture_configs)/);
  // Also verify the post-deployment schema, after legacy readers' named public
  // indexes can safely be removed by the separate cleanup migration.
  db.exec('DROP INDEX ingestion_items_v2_public_time; DROP INDEX ingestion_items_v2_public_receipt');
  const closure = db.prepare(`EXPLAIN QUERY PLAN UPDATE public_sensor_projection_v2
    SET timed_eligible=source.timed_eligible,unverified_eligible=source.unverified_eligible
    FROM public_sensor_projection_source_v2 AS source
    WHERE source.placement_id=? AND source.node_id=?
      AND public_sensor_projection_v2.node_id=source.node_id AND public_sensor_projection_v2.boot_id=source.boot_id
      AND public_sensor_projection_v2.stream=source.stream AND public_sensor_projection_v2.seq=source.seq
      AND (public_sensor_projection_v2.timed_eligible!=source.timed_eligible OR public_sensor_projection_v2.unverified_eligible!=source.unverified_eligible)`)
    .all(placement, node).map(row => String(row.detail)).join('\n');
  expect(closure).toContain('ingestion_items_v2_place (placement_id=?)');
  expect(closure).toContain('sqlite_autoindex_public_sensor_projection_v2_1 (node_id=? AND boot_id=? AND stream=? AND seq=?)');
  expect(closure).not.toMatch(/SCAN w|SCAN public_sensor_projection_v2/);
  const timed = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM public_sensor_projection_v2 WHERE place_id='library' AND timed_eligible=1 AND utc_ms>=? AND utc_ms<=? AND expires_at_ms>? ORDER BY utc_ms DESC,node_id,seq DESC LIMIT 201")
    .all(NOW - 86400000, NOW, NOW).map(row => String(row.detail)).join('\n');
  const fallback = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM public_sensor_projection_v2 WHERE place_id='library' AND unverified_eligible=1 AND received_at<=? AND expires_at_ms>? ORDER BY received_at DESC,seq DESC,node_id,boot_id,capture_config_id LIMIT 1")
    .all(iso(NOW), NOW).map(row => String(row.detail)).join('\n');
  expect(timed).toContain('public_sensor_projection_v2_time');
  expect(fallback).toContain('public_sensor_projection_v2_receipt');
  expect(timed + fallback).not.toMatch(/SCAN |TEMP B-TREE/);
});

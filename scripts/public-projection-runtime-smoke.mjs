// Backend incremental-cache acceptance on isolated real workerd/D1 only.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const hash = value => createHash('sha256').update(value).digest('hex');
const fixture = name => JSON.parse(readFileSync(`docs/specs/examples/${name}.json`, 'utf8'));
const migrations = readdirSync('migrations').filter(name => /^\d+.*\.sql$/.test(name)).sort();
const entry = await build({ stdin: { contents: `
  export { commitBatchV2 } from './worker/device-v2-store';
  export { validateEnvelopeV2,validateConfigBatchV2,validateCaptureConfigV2 } from './worker/device-v2-validation';
  export { readPublicWindows,readLastReportedSensor } from './worker/sensors';
  export { expirePublicProjections } from './worker/retention';
  export { WINDOW_SOURCE_SQL,FALLBACK_SOURCE_SQL } from './tests/helpers/public-projection-oracle';`,
  resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022' });
const api = await import(`data:text/javascript;base64,${Buffer.from(entry.outputFiles[0].text).toString('base64')}`);
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'public-projection-smoke', modules: true,
  script: 'export default {fetch(){return new Response("synthetic incremental projection")}}',
  compatibilityDate: '2026-10-23', d1Databases: ['BEFORE', 'AFTER'] }] }));
const now = Date.now(), iso = ms => new Date(ms).toISOString();
const config = fixture('capture-config-v2.fixture');
Object.assign(config, { dataset: 'field', accept_until: iso(now + 86400000), summary: { ...config.summary, max_addresses: 16 } });
api.validateCaptureConfigV2(config);
const bodies = [], boot = randomUUID(); let sequence = 0;
function envelope(source, items, received = now) {
  return { body: { ...source, protocol: 'campuspulse/2', batch_id: randomUUID(), boot_id: boot,
    node_id: config.node_id, placement_id: config.placement_id, capture_config_id: config.capture_config_id,
    dataset: 'field', items }, received };
}
for (let window = 1; window <= 40; window++) {
  const time = { utc_ms: now - (41 - window) * 30000, mono_ms: window * 30000, clock_epoch: 1, uncertainty_ms: 20 };
  const source = fixture('ble-windows-v2.request');
  bodies.push(envelope(source, [{ ...source.items[0], seq: window, time, visible_identifiers: 16,
    unique_table_capacity: 16, reports_seen: 96, reports_aggregated: 96, adv_reports: 96,
    rssi: { ...source.items[0].rssi, samples: 96 } }]));
  const summary = fixture('address-summaries-v2.request');
  const items = Array.from({ length: 16 }, (_, n) => ({ ...structuredClone(summary.items[0]), seq: ++sequence,
    window_seq: window, time, address: `02:00:00:00:00:${(n + 1).toString(16).padStart(2, '0')}` }));
  for (let start = 0; start < items.length; start += 6) bodies.push(envelope(summary, items.slice(start, start + 6)));
  const status = fixture('node-status-v2.request');
  bodies.push(envelope(status, [{ ...status.items[0], seq: window, time, uptime_ms: time.mono_ms }]));
}
const unknown = fixture('ble-windows-v2.request');
const unknownUpload = envelope(unknown, [{ ...unknown.items[0], unique_table_capacity: 16 }], now - 1000);
unknownUpload.body.boot_id = randomUUID(); bodies.push(unknownUpload);

function instrument(raw) {
  let totals = { rows_read: 0, rows_written: 0, executions: 0 };
  const originals = new WeakMap();
  const record = result => {
    totals.rows_read += result.meta.rows_read; totals.rows_written += result.meta.rows_written; totals.executions++;
    return result;
  };
  function wrap(original) {
    const statement = {
      bind(...values) { return wrap(original.bind(...values)); },
      async all() { return record(await original.all()); },
      async run() { return record(await original.run()); },
      async first(column) {
        const result = record(await original.all()), row = result.results[0];
        return row ? column === undefined ? row : row[column] : null;
      },
    };
    originals.set(statement, original); return statement;
  }
  const db = { prepare: sql => wrap(raw.prepare(sql)), async batch(statements) {
    return (await raw.batch(statements.map(statement => originals.get(statement)))).map(record);
  } };
  return { db, async measure(action) {
    totals = { rows_read: 0, rows_written: 0, executions: 0 };
    const value = await action(); return { value, usage: { ...totals } };
  } };
}
const apply = async (db, names) => {
  for (const name of names) await db.exec(readFileSync(`migrations/${name}`, 'utf8').replace(/^[\t ]*--.*$/gm, '').replace(/\n/g, ' '));
};
async function seed(db) {
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(config.node_id, hash('synthetic-projection-device')).run();
  await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,?)').bind(config.placement_id, config.node_id, 'library', 0).run();
  await db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)')
    .bind(config.capture_config_id, config.node_id, config.placement_id, 'field', JSON.stringify(config), Date.parse(config.accept_until)).run();
}
const commit = (db, entry) => api.commitBatchV2(db, api.validateEnvelopeV2(entry.body), hash(JSON.stringify(entry.body)),
  null, 24, 30, Date.parse(config.accept_until), entry.received);
const identity = row => [row.node_id, row.boot_id, row.seq];
async function sourceFingerprint(db) {
  const rows = [];
  for (const table of ['ingestion_items_v2', 'ingestion_batches_v2', 'ingestion_window_budgets_v2'])
    rows.push((await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results);
  return hash(JSON.stringify(rows));
}
try {
  for (const entry of bodies) api.validateConfigBatchV2(api.validateEnvelopeV2(entry.body), config);
  const before = await mf.getD1Database('BEFORE'), after = await mf.getD1Database('AFTER');
  await apply(before, migrations.filter(name => Number(name.slice(0, 4)) < 11));
  await apply(after, migrations); await seed(before); await seed(after);
  const oldMeter = instrument(before), meter = instrument(after);
  const ingestBefore = await oldMeter.measure(async () => { for (const entry of bodies) await commit(oldMeter.db, entry); });
  const ingestAfter = await meter.measure(async () => { for (const entry of bodies) await commit(meter.db, entry); });
  const env = { DB: meter.db };
  const oldWindows = await oldMeter.measure(() => oldMeter.db.prepare(api.WINDOW_SOURCE_SQL).bind('library', now - 86400000, now, now).all());
  const windows = await meter.measure(() => api.readPublicWindows(env, 'library', now - 86400000, now));
  assert.deepEqual(windows.value.map(identity), oldWindows.value.results.map(identity));
  const oldFallback = await oldMeter.measure(() => oldMeter.db.prepare(api.FALLBACK_SOURCE_SQL).bind('library', now, now, iso(now)).first());
  const fallback = await meter.measure(() => api.readLastReportedSensor(env, 'library', now));
  assert.deepEqual(identity(fallback.value), identity(oldFallback.value));
  const retry = await meter.measure(async () => {
    const first = await commit(meter.db, bodies[0]); assert.deepEqual(await commit(meter.db, bodies[0]), first);
  });
  assert.equal(retry.usage.rows_written, 0);
  const pristine = await sourceFingerprint(before);
  await apply(before, migrations.filter(name => Number(name.slice(0, 4)) >= 11));
  assert.equal(await sourceFingerprint(before), pristine, 'bootstrap must preserve every source byte');
  const projection = await before.prepare('SELECT node_id,boot_id,stream,seq,item_json FROM public_sensor_projection_v2 ORDER BY node_id,boot_id,seq').all();
  const incremental = await after.prepare('SELECT node_id,boot_id,stream,seq,item_json FROM public_sensor_projection_v2 ORDER BY node_id,boot_id,seq').all();
  assert.deepEqual(projection.results, incremental.results, 'bootstrap must match incremental materialization');
  const beforeFailure = await sourceFingerprint(after);
  await after.exec("CREATE TRIGGER synthetic_projection_failure BEFORE INSERT ON public_sensor_projection_v2 BEGIN SELECT RAISE(ABORT,'synthetic_projection_failure'); END;");
  const failure = structuredClone(bodies[0]); failure.body.batch_id = randomUUID(); failure.body.boot_id = randomUUID();
  await assert.rejects(commit(meter.db, failure));
  assert.equal(await sourceFingerprint(after), beforeFailure, 'failed cache write must not produce a false durable receipt');
  await after.exec('DROP TRIGGER synthetic_projection_failure');
  await after.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
    .bind(config.placement_id, config.node_id, now - 300000, iso(now)).run();
  const closedSource = await after.prepare(api.WINDOW_SOURCE_SQL).bind('library', now - 86400000, now, now).all();
  assert.deepEqual((await api.readPublicWindows(env, 'library', now - 86400000, now)).map(identity), closedSource.results.map(identity));
  assert.equal(await api.readLastReportedSensor(env, 'library', now), null);
  await after.prepare("UPDATE places SET observation_kinds_json='[\"activity\",\"parking\",\"elevator\"]' WHERE id='library'").run();
  for (const [id, age] of [['older', 600000], ['latest', 10000]])
    await after.prepare("INSERT INTO observations(id,place_id,kind,observed_at,valid_until,received_at,parking_min,parking_max) VALUES(?,'library','parking',?,?,?,1,2)")
      .bind(id, iso(now - age), iso(now + 1000), iso(now)).run();
  await after.prepare("UPDATE observations SET status='cancelled',cancelled_at=? WHERE id='latest'").bind(iso(now)).run();
  assert.equal((await after.prepare("SELECT id FROM public_observation_projection WHERE place_id='library' ORDER BY observed_at DESC,id DESC LIMIT 1").first()).id, 'older');
  assert.equal((await after.prepare('SELECT COUNT(*) n FROM observations').first()).n, 2);
  const later = now + 31 * 86400000;
  assert.deepEqual(await api.readPublicWindows(env, 'library', later - 86400000, later), []);
  assert.equal(await api.readLastReportedSensor(env, 'library', later), null);
  const sourceBeforeGC = await sourceFingerprint(after);
  const gc = await meter.measure(() => api.expirePublicProjections(env, later));
  assert.equal(gc.value, 41);
  assert.equal(await sourceFingerprint(after), sourceBeforeGC, 'cache expiry must preserve canonical history');
  assert.equal((await after.prepare('SELECT COUNT(*) n FROM public_sensor_projection_v2').first()).n, 0);
  await after.prepare("DELETE FROM ingestion_items_v2 WHERE stream='ble_windows' AND expires_at_ms<=?").bind(later).run();
  assert.equal((await after.prepare('SELECT COUNT(*) n FROM public_sensor_projection_v2').first()).n, 0);
  assert.deepEqual((await after.prepare('PRAGMA foreign_key_check').all()).results, []);
  console.log(JSON.stringify({ runtime: 'workerd', storage: 'real ephemeral D1',
    workload: 'synthetic 40 timed windows, 640 summaries, 40 statuses and one earlier unknown-clock receipt',
    accounting: 'all first/all/run/batch executions within commit/read measurements; excludes setup, migration, HTTP authentication and validation',
    ingest_before: ingestBefore.usage, ingest_after: ingestAfter.usage,
    canonical_oracle_windows: oldWindows.usage, projected_windows: windows.usage,
    canonical_oracle_fallback: oldFallback.usage, projected_fallback: fallback.usage,
    exact_retry: retry.usage, projection_expiry_cleanup: { removed: gc.value, ...gc.usage }, bootstrap_matches_incremental: true, source_bytes_preserved: true,
    cache_failure_rolls_back_source: true, placement_closure_reclassifies: true,
    manual_cancellation_restores_older: true, dynamic_expiry_and_retention_cascade: true }));
} catch (error) {
  console.error('Incremental projection smoke failed:', error.message); process.exitCode = 1;
} finally { await mf.dispose(); }

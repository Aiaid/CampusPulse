// Local workerd/D1/R2 verification with synthetic data and ephemeral storage.
// Uses Wrangler's locked development dependencies; never deploys or uses secrets.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { buildProvisioningSql } from './provision-device.mjs';

const source = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*','cloudflare:*'] });
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{
  name: 'ingestion-smoke',
  modules: true, script: source.outputFiles[0].text, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'], r2Buckets: ['RAW_BUCKET'],
  bindings: { RESEARCH_TOKEN: 'synthetic-runtime-research-token', OPERATOR_TOKEN: 'synthetic-runtime-operator-token' },
  }],
}));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fixture = name => JSON.parse(readFileSync(`docs/specs/examples/${name}.json`, 'utf8'));
try {
  const db = await mf.getD1Database('DB');
  for (const name of readdirSync('migrations').filter(name => name.endsWith('.sql')).sort()) {
    // D1.exec accepts SQL on one line, including complete trigger bodies.
    const sql = readFileSync(`migrations/${name}`, 'utf8').replace(/^--.*$/gm, '');
    await db.exec(sql.replace(/\n/g, ' '));
  }
  const config = fixture('capture-config.fixture');
  config.accept_until = new Date(Date.now() + 86_400_000).toISOString();
  const token = 'synthetic-runtime-device-token';
  const provision = buildProvisioningSql(config, { id: config.placement_id, node_id: config.node_id, place_id: 'library', valid_from_ms: 0, valid_until_ms: null }, token);
  await db.exec(provision.replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  const upload = value => {
    const body = JSON.stringify(value);
    return mf.dispatchFetch('https://runtime.test/api/v1/ingest', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Body-SHA256': hash(body) }, body });
  };
  for (const name of ['ble-windows.request', 'ble-reports.request', 'node-status.request']) {
    const batch = fixture(name);
    const replies = await Promise.all([upload(batch), upload(batch)]);
    const payloads = await Promise.all(replies.map(r => r.json()));
    assert.deepEqual(replies.map(r => r.status), [200, 200], JSON.stringify(payloads));
    assert.deepEqual(payloads[0], payloads[1]);
    assert.equal(payloads[0].durability, 'committed');
    assert.equal('raw_object_key' in payloads[0], false);
    assert.equal((await upload({ ...batch, batch_id: crypto.randomUUID() })).status, 409);
  }
  const raw = fixture('ble-reports.request');
  const research = await mf.dispatchFetch(`https://runtime.test/api/v1/research/batches/${raw.batch_id}?node_id=${raw.node_id}`, { headers: { Authorization: 'Bearer synthetic-runtime-research-token' } });
  assert.equal(research.status, 200);
  assert.equal((await research.json()).derived[0].parse_status, 'ok');
  const summary = await mf.dispatchFetch('https://runtime.test/api/v1/places/library/summary');
  assert.equal((await summary.json()).sensor, null, 'Synthetic demo data must stay out of field summaries');
  const objectList = await (await mf.getR2Bucket('RAW_BUCKET')).list();
  const referenced = await db.prepare('SELECT raw_object_key FROM ingestion_batches WHERE raw_object_key IS NOT NULL').all();
  assert.equal(referenced.results.length, 1, 'Concurrent retries commit one raw reference');
  assert.equal(objectList.objects.length, 2, 'The rejected overlapping batch leaves one unreferenced object; automatic orphan cleanup is disabled');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM ingestion_batches').first()).n, 3);
  // Exercise a configured 32-record D1 transaction, beyond single-item fixtures.
  const bulkConfig = structuredClone(config);
  bulkConfig.capture_config_id = 'demo-bulk'; bulkConfig.upload_policy.max_body_bytes = 65536;
  await db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES (?,?,?,?,?,?)')
    .bind(bulkConfig.capture_config_id, config.node_id, config.placement_id, config.dataset, JSON.stringify(bulkConfig), Date.parse(config.accept_until)).run();
  const bulk = fixture('ble-windows.request');
  bulk.batch_id = crypto.randomUUID(); bulk.boot_id = crypto.randomUUID(); bulk.capture_config_id = bulkConfig.capture_config_id;
  bulk.items = Array.from({ length: 32 }, (_, i) => ({ ...structuredClone(bulk.items[0]), seq: i + 1,
    time: { ...bulk.items[0].time, mono_ms: 45000 + i * 30000 } }));
  const bulkResponse = await upload(bulk);
  assert.equal(bulkResponse.status, 200);
  assert.equal((await bulkResponse.json()).accepted_count, 32);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sensor_windows').first()).n, 33);
  console.log('Workerd ingestion smoke passed: real local D1/R2, three streams, concurrent retries, overlap rejection, private research parsing, demo isolation.');
} finally { await mf.dispose(); }

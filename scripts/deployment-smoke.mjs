import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const base = new URL(process.env.DEPLOYMENT_URL || '');
assert.equal(base.protocol, 'https:', 'DEPLOYMENT_URL must use HTTPS');
assert.ok(!base.username && !base.password, 'Do not put credentials in the URL');
const expectedHtml = await readFile('dist/index.html', 'utf8');
function gate(name) {
  const value = process.env[name] ?? 'true';
  assert.ok(value === 'true' || value === 'false', `${name} must be exactly true or false`);
  return value === 'true';
}
const controlEnabled = gate('DEVICE_V3_CONTROL_ENABLED');
const statisticsEnabled = gate('DEVICE_V3_STATISTICS_ENABLED');
assert.ok(controlEnabled || !statisticsEnabled, 'Statistics requires control; shutdown must disable both gates');
assert.ok(process.env.DEVICE_V3_INGEST_ENABLED === undefined || process.env.DEVICE_V3_INGEST_ENABLED === 'false',
  'Historical V3 feature ingestion must remain disabled');
assert.ok(process.env.CPRAW_ARCHIVE_ENABLED === undefined || process.env.CPRAW_ARCHIVE_ENABLED === '0',
  'CPRAW ingestion must remain disabled');

async function checkError(path, method, enabled, disabledCode) {
  // No authorization, body, device identity or operator session is sent. Even
  // POST probes stop at the gate/auth boundary and cannot admit a source row.
  const response = await fetch(new URL(path, base), { method,
    headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, enabled ? 401 : 503, `${path} must enforce its gate/auth boundary`);
  const body = await response.json();
  assert.ok(body && Object.keys(body).length === 1 && Object.hasOwn(body, 'error'), `${path} must return only an error`);
  assert.ok(body.error && body.error.code === (enabled ? 'unauthorized' : disabledCode), `${path} must return the expected error code`);
  assert.ok(Object.keys(body.error).every(key => ['code', 'message', 'retryable'].includes(key)), `${path} must not expose private fields`);
}

async function checkV3Gates() {
  await Promise.all([
    checkError('/api/v3/device/config', 'GET', controlEnabled, 'v3_control_disabled'),
    checkError('/api/v3/statistics/ingest', 'POST', statisticsEnabled, 'v3_statistics_disabled'),
    checkError('/api/v3/ingest', 'POST', false, 'v3_ingest_disabled'),
    checkError('/api/v1/cpraw/uploads/00000000-0000-4000-8000-000000000000', 'POST', false, 'archive_disabled'),
  ]);
  const response = await get('/api/v3/places/deployment-smoke-unknown-8f2c97/statistics');
  const body = await response.json();
  assert.ok(body?.schema === 'public-statistics/3' && body.state === 'unavailable' &&
    body.reason === (statisticsEnabled ? 'place_not_found' : 'disabled'), 'Unknown-place V3 statistics must remain unavailable');
  assert.ok(['observed_at', 'valid_until', 'visible_identifiers', 'candidates', 'activity', 'estimated_total'].every(key => body[key] === null),
    'Unknown-place statistics must not expose observations');
  const publicKeys = ['schema', 'state', 'reason', 'as_of', 'observed_at', 'valid_until', 'visible_identifiers', 'candidates', 'activity', 'estimated_total'];
  assert.ok(Object.keys(body).length === publicKeys.length && Object.keys(body).every(key => publicKeys.includes(key)),
    'Unknown-place statistics must not expose private fields');
}

async function get(path) {
  const response = await fetch(new URL(path, base), {
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200, `${path} must return 200`);
  return response;
}

// Allow a brief interval for the newly published deployment to propagate.
for (let attempt = 0; attempt < 6; attempt++) {
  try {
    const [html, health, data] = await Promise.all([
      get('/').then(response => response.text()),
      get('/api/v1/health').then(response => response.json()),
      get('/api/v1/places').then(response => response.json()),
    ]);
    assert.equal(html, expectedHtml, 'Published frontend must match this build');
    assert.equal(health.status, 'ok');
    assert.equal(health.ingestion, 'implemented', 'Published Worker must implement ingestion');
    assert.equal(health.raw_storage, 'configured', 'Published Worker must bind the private raw archive');
    assert.ok(Array.isArray(data.places) && data.places.some(place => place.id === 'library'), 'D1 must return seeded places');
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]);
    assert.ok(assets.length > 0, 'The frontend must reference its built assets');
    await Promise.all(assets.map(async asset => { await (await get(asset)).arrayBuffer(); }));
    await checkV3Gates();
    console.log('Deployment smoke passed: frontend matches build, assets load, Worker health/D1 reads and unauthenticated V3 gate checks succeed.');
    break;
  } catch (error) {
    if (attempt === 5) throw error;
    await setTimeout(5_000);
  }
}

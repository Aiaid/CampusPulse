import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const base = new URL(process.env.DEPLOYMENT_URL || '');
assert.equal(base.protocol, 'https:', 'DEPLOYMENT_URL must use HTTPS');
assert.ok(!base.username && !base.password, 'Do not put credentials in the URL');
const expectedHtml = await readFile('dist/index.html', 'utf8');

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
    console.log('Deployment smoke passed: frontend matches build, assets load, Worker health and D1 reads succeed.');
    break;
  } catch (error) {
    if (attempt === 5) throw error;
    await setTimeout(5_000);
  }
}

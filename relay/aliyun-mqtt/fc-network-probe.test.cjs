'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('./fc-network-probe.cjs');
const request = Buffer.from(JSON.stringify({ op: 'health', request_id: '7eca5347-8a54-4d71-9702-77774b7c780e' }));

test('probe is fixed-target, unauthenticated health only and never an ingestion receipt', async () => {
  const handler = createHandler(async (url, options) => {
    assert.equal(url, 'https://pulse.anend.net/api/v1/health');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ status: 'ok', ingestion: 'implemented' });
  });
  const value = JSON.parse(await handler(request));
  assert.equal(value.verified, true);
  assert.equal(value.stage, 'fc_to_cf_health');
  assert.equal(value.receipt_id, undefined);
});

test('unknown input cannot become an open proxy', async () => {
  let called = false;
  const handler = createHandler(async () => { called = true; });
  const value = JSON.parse(await handler(Buffer.from('{"op":"health","request_id":"bad","url":"https://elsewhere.invalid"}')));
  assert.equal(value.verified, false);
  assert.equal(called, false);
});

test('upstream failures never claim a successful probe or expose error contents', async () => {
  const handler = createHandler(async () => { throw new Error('private-diagnostic-text'); });
  const value = await handler(request);
  assert.equal(JSON.parse(value).verified, false);
  assert.equal(value.includes('private-diagnostic-text'), false);
});

test('oversized or incompatible upstream response fails', async () => {
  const handler = createHandler(async () => new Response('x'.repeat(4097)));
  assert.equal(JSON.parse(await handler(request)).verified, false);
});

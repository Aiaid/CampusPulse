import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, MAX_BODY_BYTES, MAX_ENVELOPE_BYTES, MAX_RESPONSE_BYTES, PROTOCOL, ROUTES, RelayFault, sha256 } from './relay.mjs';
import { createHandler } from './adapter-interface.mjs';

const node = 'synthetic-relay-node';
const binding = { principal: 'synthetic-principal', topic: 'synthetic/request', reply_topic: 'synthetic/reply', node_id: node, device_token: 'fixture-token-not-a-secret-0001' };
const requestId = 'b0c7e118-64ae-4d48-9cac-7508bc09fe77';
function envelope(op = 'ingest', body = Buffer.from(`{ "node_id": "${node}", "fixture": true }\n`), patch = {}) {
  return { protocol: PROTOCOL, request_id: requestId, op, body_base64: body.toString('base64'), body_sha256: sha256(body), ...patch };
}
const ingress = (request, patch = {}) => ({ principal: binding.principal, topic: binding.topic, payload: JSON.stringify(request), ...patch });
const relayWith = (fetchImpl = async () => new Response('{}'), options = {}) => createRelay({ bindings: [binding], fetchImpl, ...options });
async function rejected(relay, request, code, patch) {
  await assert.rejects(relay(ingress(request, patch)), (error) => error instanceof RelayFault && (!code || error.code === code));
}

test('only trusted principal AND exact input topic select credentials/reply topic', async () => {
  let calls = 0; const relay = relayWith(async () => { calls++; return new Response('{}'); });
  await rejected(relay, envelope(), 'unauthorized_transport', { principal: 'other-principal' });
  await rejected(relay, envelope(), 'unauthorized_transport', { topic: binding.reply_topic });
  await rejected(relay, envelope(), 'unauthorized_transport', { principal: undefined });
  await rejected(relay, envelope('ingest', undefined, { node_id: node }));
  await rejected(relay, envelope('ingest', undefined, { reply_topic: 'attacker/reply' }));
  await rejected(relay, envelope('ingest', Buffer.from('{"node_id":"other-node"}')), 'node_not_allowed');
  await rejected(relay, envelope('contact', Buffer.from('{"node_id":"other-node"}')), 'node_not_allowed');
  assert.equal(calls, 0);
  assert.equal((await relay(ingress(envelope()))).replyTopic, binding.reply_topic);
});

test('exact request bytes/hash and original reply bytes/status are preserved', async () => {
  const body = Buffer.from(` {"node_id":"${node}","sample":"雪\\n", "n":1e2}\r\n`);
  const ack = Buffer.from(' {"batch_id":"synthetic","duplicate":true}\n');
  let calls = 0;
  const relay = relayWith(async (url, init) => {
    calls++;
    assert.equal(url, 'https://pulse.anend.net/api/v2/ingest');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, `Bearer ${binding.device_token}`);
    assert.equal(init.headers['X-Body-SHA256'], sha256(body));
    assert.deepEqual(init.body, body);
    return new Response(ack, { status: 201 });
  });
  const request = envelope('ingest', body);
  for (let retry = 0; retry < 2; retry++) {
    const { reply } = await relay(ingress(request));
    assert.deepEqual(reply, { protocol: PROTOCOL, request_id: requestId, op: 'ingest', request_sha256: sha256(body), kind: 'upstream_response', status: 201, body_base64: ack.toString('base64'), response_sha256: sha256(ack) });
  }
  assert.equal(calls, 2, 'no RAM dedup success on redelivery');
});

test('only enumerated fixed routes/methods; GET is empty and sends no body', async () => {
  for (const [op, route] of Object.entries(ROUTES)) {
    const body = Buffer.from(route.method === 'GET' ? '' : `{"node_id":"${node}"}`);
    const relay = relayWith(async (url, init) => {
      assert.equal(url, `https://pulse.anend.net${route.path}`);
      assert.equal(init.method, route.method);
      if (route.method === 'GET') assert.equal(Object.hasOwn(init, 'body'), false);
      return new Response('{}');
    });
    assert.equal((await relay(ingress(envelope(op, body)))).reply.kind, 'upstream_response');
  }
  const relay = relayWith(() => assert.fail('invalid request was fetched'));
  for (const op of ['https://attacker.invalid/', '../ingest', '__proto__', 'constructor', 'config?x=y']) await rejected(relay, envelope(op));
  for (const field of ['url', 'path', 'method', 'headers', 'device_token']) await rejected(relay, envelope('ingest', undefined, { [field]: 'untrusted' }));
  await rejected(relay, envelope('health', Buffer.from('{}')), 'unexpected_get_body');
});

test('canonical base64, exact SHA, UUID/protocol and size limits are enforced', async () => {
  const relay = relayWith(() => assert.fail('invalid request was fetched'));
  await rejected(relay, envelope('ingest', undefined, { body_sha256: '0'.repeat(64) }), 'body_hash_mismatch');
  for (const body_base64 of ['Zg', 'Zg==\n', 'Zh==', '-_==', '====']) await rejected(relay, envelope('contact', undefined, { body_base64 }), 'invalid_base64');
  for (const patch of [{ request_id: '../../reply' }, { request_id: requestId.toUpperCase() }, { protocol: 'unknown/1' }, { body_sha256: 'A'.repeat(64) }]) await rejected(relay, envelope('ingest', undefined, patch));
  await rejected(relay, envelope('contact', Buffer.alloc(MAX_BODY_BYTES + 1, 32)), 'body_too_large');
  await rejected(relay, envelope(), 'envelope_too_large', { payload: ' '.repeat(MAX_ENVELOPE_BYTES + 1) });
});

test('duplicate decoded JSON keys, invalid UTF8/nonfinite values and JSON limits are rejected', async () => {
  const relay = relayWith(() => assert.fail('invalid request was fetched'));
  const request = envelope('health', Buffer.alloc(0));
  await rejected(relay, request, 'duplicate_json_key', { payload: JSON.stringify(request).replace('"op":', '"op":"health","\\u006fp":') });
  for (const body of [Buffer.from('{"a":1,"\\u0061":2}'), Buffer.from('{"x":1e9999}'), Buffer.from('{"x":01}'), Buffer.from([0xff]), Buffer.from('['.repeat(18) + '0' + ']'.repeat(18))]) await rejected(relay, envelope('contact', body));
  const manyKeys = Buffer.from(JSON.stringify(Object.fromEntries(Array.from({ length: 8193 }, (_, i) => [String.fromCodePoint(0x100 + i), 0]))));
  assert.ok(manyKeys.length <= MAX_BODY_BYTES);
  await rejected(relay, envelope('contact', manyKeys), 'json_limits');
  await rejected(relay, envelope('contact', Buffer.from(JSON.stringify({ ['x'.repeat(129)]: 0 }))), 'json_limits');
  await rejected(relay, envelope('contact', Buffer.from('[]')), 'invalid_body');
  await rejected(relay, envelope('ingest', Buffer.from('{}')), 'node_not_allowed');
});

test('upstream 401, 429, duplicate receipts and redirects remain exact non-invented responses', async () => {
  for (const status of [200, 302, 401, 429, 500]) {
    const bytes = Buffer.from(status === 200 ? '{"receipt":"synthetic-durable-receipt","duplicate":true}' : '{"error":"synthetic rejection"}');
    const relay = relayWith(async (_, init) => {
      assert.equal(init.redirect, 'manual');
      return new Response(bytes, { status, headers: { Location: 'https://attacker.invalid/', 'Retry-After': '3' } });
    });
    const { reply } = await relay(ingress(envelope()));
    assert.equal(reply.kind, 'upstream_response'); assert.equal(reply.status, status);
    assert.deepEqual(Buffer.from(reply.body_base64, 'base64'), bytes);
    assert.equal(reply.response_sha256, sha256(bytes));
    assert.equal(Object.hasOwn(reply, 'headers'), false);
  }
  const followed = relayWith(async () => ({ redirected: true }));
  assert.equal((await followed(ingress(envelope()))).reply.code, 'upstream_redirect');
});

test('network errors and timeout never claim upstream HTTP success', async () => {
  const network = relayWith(async () => { throw new Error('secret-like upstream diagnostics must not escape'); });
  const timeout = relayWith(async () => new Promise(() => {}), { timeoutMs: 10 });
  const bodyTimeout = relayWith(async () => new Response(new ReadableStream({ start() {} })), { timeoutMs: 10 });
  for (const [relay, code] of [[network, 'upstream_network_error'], [timeout, 'upstream_timeout'], [bodyTimeout, 'upstream_timeout']]) {
    const { reply } = await relay(ingress(envelope()));
    assert.deepEqual(reply, { protocol: PROTOCOL, request_id: requestId, op: 'ingest', request_sha256: envelope().body_sha256, kind: 'relay_error', code });
    assert.equal(Object.hasOwn(reply, 'status'), false);
    assert.equal(Object.hasOwn(reply, 'body_base64'), false);
  }
});

test('bounded response stream including misleading Content-Length fails without ACK', async () => {
  for (const headers of [{}, { 'Content-Length': '1' }, { 'Content-Length': String(MAX_RESPONSE_BYTES + 1) }]) {
    const relay = relayWith(async () => new Response(Buffer.alloc(MAX_RESPONSE_BYTES + 1), { headers }));
    const { reply } = await relay(ingress(envelope()));
    assert.equal(reply.kind, 'relay_error'); assert.equal(reply.code, 'upstream_response_too_large');
    assert.equal(Object.hasOwn(reply, 'status'), false);
  }
});

test('exact documented HTTP size boundaries are accepted by core', async () => {
  const prefix = Buffer.from(`{"node_id":"${node}","padding":"`), suffix = Buffer.from('"}');
  const body = Buffer.concat([prefix, Buffer.alloc(MAX_BODY_BYTES - prefix.length - suffix.length, 32), suffix]);
  const response = Buffer.alloc(MAX_RESPONSE_BYTES, 32);
  const relay = relayWith(async (_, init) => { assert.deepEqual(init.body, body); return new Response(response); });
  const { reply } = await relay(ingress(envelope('ingest', body)));
  assert.equal(reply.kind, 'upstream_response');
  assert.equal(Buffer.from(reply.body_base64, 'base64').length, MAX_RESPONSE_BYTES);
});

test('production origin cannot be overridden except explicit localhost fixture origin', async () => {
  for (const testOrigin of ['https://attacker.invalid', 'http://localhost.attacker.invalid', 'http://user@localhost/', 'http://localhost/path', 'http://localhost/?q=1']) assert.throws(() => relayWith(undefined, { testOrigin }));
  const relay = relayWith(async (url) => { assert.equal(url, 'http://127.0.0.1:8787/api/v1/health'); return new Response('{}'); }, { testOrigin: 'http://127.0.0.1:8787' });
  await relay(ingress(envelope('health', Buffer.alloc(0))));
  for (const timeoutMs of [0, 8001, NaN]) assert.throws(() => relayWith(undefined, { timeoutMs }));
  assert.throws(() => createRelay({ bindings: [binding, binding] }));
  assert.throws(() => createRelay({ bindings: [{ ...binding, reply_topic: 'synthetic/#' }] }));
});

test('adapter requires trusted normalization and publishes only bound topic; publish failure throws', async () => {
  const calls = [];
  const handler = createHandler({ relay: relayWith(), authenticateAndNormalize: async (event, context) => {
    assert.equal(context.authenticatedFixture, true); assert.equal(event.untrusted, true);
    return ingress(envelope());
  }, publishReply: async (topic, bytes) => calls.push({ topic, reply: JSON.parse(bytes) }) });
  assert.deepEqual(await handler({ untrusted: true }, { authenticatedFixture: true }), { kind: 'reply_published', request_id: requestId });
  assert.equal(calls[0].topic, binding.reply_topic);
  const failed = createHandler({ relay: relayWith(), authenticateAndNormalize: async () => ingress(envelope()), publishReply: async () => { throw new Error('synthetic broker failure'); } });
  await assert.rejects(failed({}, {}), /synthetic broker failure/);
  const unauthorized = createHandler({ relay: relayWith(), authenticateAndNormalize: async () => { throw new Error('untrusted invocation'); }, publishReply: () => assert.fail('must not publish') });
  await assert.rejects(unauthorized({}, {}), /untrusted invocation/);
});

import { createHash } from 'node:crypto';

export const PROTOCOL = 'campuspulse-mqtt-relay/1';
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 12 * 1024;
export const MAX_ENVELOPE_BYTES = 4 * Math.ceil(MAX_BODY_BYTES / 3) + 1024;
export const ROUTES = Object.freeze({
  health: Object.freeze({ method: 'GET', path: '/api/v1/health' }),
  contact: Object.freeze({ method: 'POST', path: '/api/v2/device/contact' }),
  config: Object.freeze({ method: 'GET', path: '/api/v2/device/config' }),
  config_ack: Object.freeze({ method: 'POST', path: '/api/v2/device/config/ack' }),
  ingest: Object.freeze({ method: 'POST', path: '/api/v2/ingest' }),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const REQUEST_KEYS = ['protocol', 'request_id', 'op', 'body_base64', 'body_sha256'];

export class RelayFault extends Error {
  constructor(code) { super(code); this.name = 'RelayFault'; this.code = code; }
}
const fail = (code) => { throw new RelayFault(code); };
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Duplicate decoded keys, excessive nesting/key counts, invalid UTF-8 and
// nonfinite numbers must not acquire different meanings in different runtimes.
// This parser is validation only: the decoded original bytes are sent unchanged.
function parseBoundedJson(bytes, { maxKeys = 8192, maxDepth = 16 } = {}) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('invalid_json'); }
  let offset = 0, keyCount = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(source[offset] ?? '\0')) offset++; };
  function string() {
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === '"') {
        try { return JSON.parse(source.slice(start, offset)); } catch { fail('invalid_json'); }
      }
      if (char === '\\') offset++;
    }
    fail('invalid_json');
  }
  function value(depth) {
    if (depth > maxDepth) fail('json_limits');
    whitespace();
    if (source[offset] === '"') return string();
    if (source[offset] === '{') {
      offset++; whitespace(); const object = Object.create(null), seen = new Set();
      if (source[offset] === '}') { offset++; return object; }
      while (true) {
        whitespace(); if (source[offset] !== '"') fail('invalid_json');
        const key = string();
        if (++keyCount > maxKeys || key.length > 128) fail('json_limits');
        if (seen.has(key)) fail('duplicate_json_key');
        seen.add(key); whitespace();
        if (source[offset++] !== ':') fail('invalid_json');
        object[key] = value(depth + 1); whitespace();
        const delimiter = source[offset++];
        if (delimiter === '}') return object;
        if (delimiter !== ',') fail('invalid_json');
      }
    }
    if (source[offset] === '[') {
      offset++; whitespace(); const array = [];
      if (source[offset] === ']') { offset++; return array; }
      while (true) {
        if (array.length >= 8192) fail('json_limits');
        array.push(value(depth + 1)); whitespace();
        const delimiter = source[offset++];
        if (delimiter === ']') return array;
        if (delimiter !== ',') fail('invalid_json');
      }
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(offset));
    if (!literal) fail('invalid_json');
    offset += literal[0].length;
    const result = JSON.parse(literal[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) fail('invalid_json');
    return result;
  }
  const result = value(0); whitespace();
  if (offset !== source.length) fail('invalid_json');
  return result;
}
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function decodeRequest(payload) {
  if (!(typeof payload === 'string' || payload instanceof Uint8Array)) fail('invalid_payload');
  if (Buffer.byteLength(payload) > MAX_ENVELOPE_BYTES) fail('envelope_too_large');
  const bytes = Buffer.from(payload);
  if (bytes.length > MAX_ENVELOPE_BYTES) fail('envelope_too_large');
  const request = parseBoundedJson(bytes, { maxKeys: REQUEST_KEYS.length, maxDepth: 1 });
  if (!isObject(request) || Object.keys(request).length !== REQUEST_KEYS.length ||
      REQUEST_KEYS.some((key) => !Object.hasOwn(request, key))) fail('invalid_envelope');
  if (request.protocol !== PROTOCOL || typeof request.request_id !== 'string' || !UUID.test(request.request_id) ||
      typeof request.op !== 'string' || !Object.hasOwn(ROUTES, request.op) ||
      typeof request.body_base64 !== 'string' || typeof request.body_sha256 !== 'string' ||
      !HASH.test(request.body_sha256)) fail('invalid_envelope');
  const encoded = request.body_base64;
  if (encoded.length > 4 * Math.ceil(MAX_BODY_BYTES / 3)) fail('body_too_large');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail('invalid_base64');
  const body = Buffer.from(encoded, 'base64');
  if (body.length > MAX_BODY_BYTES) fail('body_too_large');
  if (body.toString('base64') !== encoded) fail('invalid_base64');
  if (sha256(body) !== request.body_sha256) fail('body_hash_mismatch');
  return { request, body };
}
function safeTopic(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f+#]/.test(value);
}
function originFor(testOrigin) {
  if (testOrigin === undefined) return 'https://pulse.anend.net';
  const url = new URL(testOrigin);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid local test origin');
  return url.origin;
}
async function responseBytes(response) {
  const size = response.headers.get('content-length');
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_RESPONSE_BYTES)) fail('upstream_response_too_large');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        fail('upstream_response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

/**
 * Input principal/topic MUST be authenticated transport metadata, never values
 * extracted from the device JSON. Returns only the server-configured reply topic.
 * Throws RelayFault for rejected ingress; do not publish unvalidated correlation.
 * No cache/dedup: every at-least-once delivery retries the exact original bytes.
 */
export function createRelay({ bindings, fetchImpl = globalThis.fetch, testOrigin, timeoutMs = 8000 }) {
  if (!Array.isArray(bindings) || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) throw new Error('Invalid relay configuration');
  const origin = originFor(testOrigin), identities = new Map();
  for (const binding of bindings) {
    if (!isObject(binding) || typeof binding.principal !== 'string' || !binding.principal || binding.principal.length > 256 ||
        !safeTopic(binding.topic) || !safeTopic(binding.reply_topic) ||
        typeof binding.node_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(binding.node_id) ||
        typeof binding.device_token !== 'string' || !/^[!-~]{16,256}$/.test(binding.device_token)) throw new Error('Invalid relay binding');
    const key = JSON.stringify([binding.principal, binding.topic]);
    if (identities.has(key)) throw new Error('Duplicate relay binding');
    identities.set(key, Object.freeze({ ...binding }));
  }
  return async function relay({ principal, topic, payload }) {
    if (typeof principal !== 'string' || typeof topic !== 'string') fail('unauthorized_transport');
    const binding = identities.get(JSON.stringify([principal, topic]));
    if (!binding) fail('unauthorized_transport');
    const { request, body } = decodeRequest(payload), route = ROUTES[request.op];
    if (route.method === 'GET') {
      if (body.length !== 0) fail('unexpected_get_body');
    } else {
      const json = parseBoundedJson(body);
      if (!isObject(json)) fail('invalid_body');
      if (Object.hasOwn(json, 'node_id') && json.node_id !== binding.node_id) fail('node_not_allowed');
      if (request.op === 'ingest' && json.node_id !== binding.node_id) fail('node_not_allowed');
    }
    const correlation = { protocol: PROTOCOL, request_id: request.request_id, op: request.op, request_sha256: request.body_sha256 };
    const controller = new AbortController(); let timer, timedOut = false;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new RelayFault('upstream_timeout')); }, timeoutMs);
    });
    const operation = async () => {
      const response = await fetchImpl(origin + route.path, {
        method: route.method, redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bearer ${binding.device_token}`, 'Content-Type': 'application/json', 'X-Body-SHA256': request.body_sha256 },
        ...(route.method === 'POST' ? { body } : {}),
      });
      if (response.redirected) fail('upstream_redirect');
      if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) fail('upstream_network_error');
      const bytes = await responseBytes(response);
      return { ...correlation, kind: 'upstream_response', status: response.status, body_base64: bytes.toString('base64'), response_sha256: sha256(bytes) };
    };
    try { return { replyTopic: binding.reply_topic, reply: await Promise.race([operation(), deadline]) }; }
    catch (error) {
      controller.abort();
      const code = timedOut ? 'upstream_timeout' : error instanceof RelayFault ? error.code : 'upstream_network_error';
      return { replyTopic: binding.reply_topic, reply: { ...correlation, kind: 'relay_error', code } };
    } finally { clearTimeout(timer); }
  };
}

// Isolated synthetic transport diagnostic. Receipts never authorize queue deletion.
const PROTOCOL = 'cp-link-probe/1';
const LIMITS = Object.freeze({
  maxBytes: 8192,
  sizes: Object.freeze([1024, 8192]),
  maxMessages: 256,
  lifetimeMs: 15 * 60 * 1000,
  bodyTimeoutMs: 10_000,
});

const encoder = new TextEncoder();
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

function json(value, status = 200, extra = {}) {
  const body = encoder.encode(JSON.stringify(value));
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.byteLength),
      'Content-Encoding': 'identity',
      'Cache-Control': 'no-store, no-cache, must-revalidate, no-transform',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

async function authorized(request, token) {
  const header = request.headers.get('Authorization') ?? '';
  if (typeof token !== 'string' || token.length === 0 || token.length > 256 ||
      header.length > 263 || !header.startsWith('Bearer ')) return false;
  // Equal fixed-size digests avoid a secret-dependent string/length comparison.
  const [expected, supplied] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(token)),
    crypto.subtle.digest('SHA-256', encoder.encode(header.slice(7))),
  ]);
  return crypto.subtle.timingSafeEqual(expected, supplied);
}

async function boundedBody(request) {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^(1024|8192)$/.test(length))) {
    throw new HttpError(Number(length) > LIMITS.maxBytes ? 413 : 400, 'invalid_size');
  }
  if (!request.body) throw new HttpError(400, 'invalid_size');
  const reader = request.body.getReader();
  const bytes = new Uint8Array(LIMITS.maxBytes);
  let used = 0;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(408, 'body_timeout')), LIMITS.bodyTimeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (used + value.byteLength > LIMITS.maxBytes) throw new HttpError(413, 'invalid_size');
      bytes.set(value, used);
      used += value.byteLength;
    }
    if (!LIMITS.sizes.includes(used) || (length !== null && Number(length) !== used)) {
      throw new HttpError(400, 'invalid_size');
    }
    return bytes.slice(0, used);
  } finally {
    clearTimeout(timer);
    // Do not await an attacker-controlled source's cancel promise.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function receipt(bytes, connectionId, colo) {
  return {
    protocol: PROTOCOL,
    kind: 'transport_received',
    run_id: hex(bytes.subarray(0, 16)),
    seq: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16, false),
    bytes: bytes.byteLength,
    sha256: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))),
    connection_id: connectionId,
    colo,
  };
}

function websocket(colo) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  const connectionId = crypto.randomUUID();
  let closed = false;
  let processing = false;
  let messages = 0;
  const stop = (code, reason) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    try { server.close(code, reason); } catch { /* Already disconnected. */ }
  };
  const timer = setTimeout(() => stop(1000, 'lifetime_limit'), LIMITS.lifetimeMs);
  server.binaryType = 'arraybuffer';
  server.accept();
  server.addEventListener('close', () => { closed = true; clearTimeout(timer); });
  server.addEventListener('error', () => stop(1011, 'transport_error'));
  server.addEventListener('message', (event) => {
    if (closed) return;
    if (processing) { stop(1008, 'pipelining_not_allowed'); return; }
    if (messages >= LIMITS.maxMessages) { stop(1008, 'message_limit'); return; }
    if (typeof event.data === 'string') {
      if (event.data !== 'close-for-test') { stop(1003, 'binary_required'); return; }
      server.send(JSON.stringify({ protocol: PROTOCOL, kind: 'closing', connection_id: connectionId }));
      stop(1000, 'close-for-test');
      return;
    }
    if (!(event.data instanceof ArrayBuffer) || !LIMITS.sizes.includes(event.data.byteLength)) {
      stop(event.data?.byteLength > LIMITS.maxBytes ? 1009 : 1008, 'invalid_size');
      return;
    }
    processing = true;
    messages += 1;
    // No queue: a second message while hashing immediately closes the session.
    void receipt(new Uint8Array(event.data), connectionId, colo).then((ack) => {
      if (!closed) server.send(JSON.stringify(ack));
      processing = false;
      if (messages === LIMITS.maxMessages) stop(1000, 'message_limit');
    }).catch(() => stop(1011, 'receipt_failed'));
  });
  return new Response(null, { status: 101, webSocket: client });
}

/** @satisfies {ExportedHandler<Env>} */
export default {
  async fetch(request, env) {
    try {
      if (!(await authorized(request, env.PROBE_TOKEN))) {
        return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
      }
      const url = new URL(request.url);
      if (url.search) return json({ error: 'query_not_allowed' }, 400);
      const colo = typeof request.cf?.colo === 'string' ? request.cf.colo : 'LOCAL';
      if (url.pathname === '/benchmark') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
        if (request.headers.get('Content-Encoding') || request.headers.get('Content-Type') !== 'application/octet-stream') {
          return json({ error: 'binary_content_required' }, 415);
        }
        const bytes = await boundedBody(request);
        return json(await receipt(bytes, crypto.randomUUID(), colo));
      }
      if (url.pathname === '/ws') {
        if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          return json({ error: 'websocket_upgrade_required' }, 426, { Upgrade: 'websocket' });
        }
        return websocket(colo);
      }
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      return json({ error: error instanceof HttpError ? error.message : 'request_failed' },
        error instanceof HttpError ? error.status : 500);
    }
  },
};

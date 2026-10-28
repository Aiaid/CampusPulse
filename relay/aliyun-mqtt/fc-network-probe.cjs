'use strict';

// Authenticated FC invocation only. No HTTP trigger and no MQTT/cloud ACK claim.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TARGET = 'https://pulse.anend.net/api/v1/health';

function createHandler(fetchImpl = globalThis.fetch) {
  return async function handler(event) {
    let request;
    try {
      const bytes = Buffer.isBuffer(event) ? event : Buffer.from(event);
      if (bytes.length > 256) throw new Error();
      request = JSON.parse(bytes.toString('utf8'));
      if (!request || Array.isArray(request) || Object.keys(request).length !== 2 ||
          request.op !== 'health' || !UUID.test(request.request_id)) throw new Error();
    } catch {
      return JSON.stringify({ stage: 'fc_to_cf_health', verified: false, code: 'invalid_probe' });
    }
    const start = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let reader;
    try {
      const response = await fetchImpl(TARGET, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks = [];
      let length = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 4096) throw new Error();
        chunks.push(Buffer.from(next.value));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const verified = response.status === 200 && body.status === 'ok' &&
        body.ingestion === 'implemented';
      return JSON.stringify({ stage: 'fc_to_cf_health', request_id: request.request_id,
        verified, upstream_status: response.status, elapsed_ms: Math.round(performance.now() - start) });
    } catch {
      return JSON.stringify({ stage: 'fc_to_cf_health', request_id: request.request_id,
        verified: false, code: controller.signal.aborted ? 'timeout' : 'upstream_failure',
        elapsed_ms: Math.round(performance.now() - start) });
    } finally {
      clearTimeout(timer);
      try { await reader?.cancel(); } catch { /* No diagnostic body/error logs. */ }
    }
  };
}

module.exports = { createHandler, handler: createHandler() };

/** Native MQTT/TLS CPV3 transport. PUBACK never reclaims a device batch. */
import { randomUUID } from 'node:crypto';

// Pinned to worker/mqtt-credentials.ts and docs/specs/device-v3-mqtt.md.
export const PRODUCTION_MQTT_URI = 'mqtts://q9a692f8.ala.cn-hangzhou.emqxsl.cn:8883';
const check = (ok, message) => { if (!ok) throw new Error(message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const operations = Object.freeze({ '/api/v3/device/capabilities': 1, '/api/v3/device/config': 2,
  '/api/v3/device/config/ack': 3, '/api/v3/device/lease': 4, '/api/v3/statistics/ingest': 5 });

export function validateMqttCredentials(value) {
  check(value && Object.keys(value).every(k => ['uri', 'username', 'password', 'namespace'].includes(k)) &&
    value.uri === PRODUCTION_MQTT_URI && typeof value.username === 'string' && /^[a-z0-9_-]{1,15}$/.test(value.username) &&
    typeof value.namespace === 'string' && /^[a-z0-9_-]{1,15}$/.test(value.namespace) && typeof value.password === 'string' &&
    value.password.length >= 8 && value.password.length <= 256 && !/[\r\n\0]/.test(value.password),
  'Invalid pinned MQTT configuration.');
  return value;
}

export async function createMqttV3DeviceClient({ mqtt, nodeId, bootId, timeoutMs = 15000, initialRpc = 0 }, dependencies = {}) {
  validateMqttCredentials(mqtt);
  check(typeof nodeId === 'string' && /^sim-live-[a-z0-9_-]+$/.test(nodeId) && nodeId.length <= 64 &&
    typeof bootId === 'string' && uuid.test(bootId), 'Invalid virtual device identity.');
  check(Number.isInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 30000, 'Invalid MQTT timeout.');
  check(Number.isSafeInteger(initialRpc) && initialRpc >= 0 && initialRpc <= 4294967295, 'Invalid MQTT RPC high-water mark.');
  const connectFn = dependencies.connectFn ?? (await import('mqtt')).connect;
  const client = connectFn(PRODUCTION_MQTT_URI, { username: mqtt.username, password: mqtt.password,
    clientId: `cp-sim-${randomUUID()}`, protocolVersion: 4, clean: true, keepalive: 30,
    rejectUnauthorized: true, reconnectPeriod: 0, connectTimeout: timeoutMs, resubscribe: false,
    queueQoSZero: false });
  const prefix = `cp/v1/${mqtt.namespace}/${bootId}`, subscription = `${prefix}/rep/ingest/+`;
  const pending = new Map(); let rpc = initialRpc, closed = false, transportFailed = false;
  const counters = { requests: 0, replies: 0, timeouts: 0, rejectedReplies: 0 };
  const failPending = () => {
    transportFailed = true;
    for (const entry of pending.values()) entry.fail(new Error('MQTT connection ended before a matching receipt.'));
  };
  client.on('error', failPending);
  client.on('close', failPending);
  client.on('message', (topic, payload, packet = {}) => {
    const entry = pending.get(topic);
    if (!entry) return;
    const wire = Buffer.from(payload), max = entry.operation === 2 ? 8192 : 2048;
    if (packet.retain || wire.length < 4 || wire.length > max + 2) { counters.rejectedReplies++; entry.fail(new Error('Invalid MQTT reply.')); return; }
    const status = wire.readUInt16BE(0), body = wire.subarray(2);
    try {
      check(status >= 200 && status <= 599, 'Invalid MQTT reply.');
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      check(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'Invalid MQTT reply.');
      counters.replies++;
      entry.finish(new Response(body, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
    } catch { counters.rejectedReplies++; entry.fail(new Error('Invalid MQTT reply.')); }
  });
  async function close() {
    if (closed) return;
    closed = true; failPending();
    await new Promise(resolve => {
      const timer = setTimeout(resolve, Math.min(timeoutMs, 2000));
      client.end(true, {}, () => { clearTimeout(timer); resolve(); });
    });
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('MQTT connection timed out.')), timeoutMs);
      const finish = error => {
        clearTimeout(timer); client.removeListener('connect', connected); client.removeListener('error', failed); client.removeListener('close', failed);
        error ? reject(error) : resolve();
      };
      const failed = () => finish(new Error('MQTT connection failed.'));
      const connected = () => client.subscribe(subscription, { qos: 0 }, (error, granted) => {
        finish(error || !granted?.some(g => g.topic === subscription && g.qos === 0) ? new Error('MQTT reply subscription failed.') : undefined);
      });
      client.once('connect', connected); client.once('error', failed); client.once('close', failed);
    });
    check(!transportFailed, 'MQTT connection failed.');
  } catch { await close(); throw new Error('MQTT connection or reply subscription failed.'); }

  async function request(pathname, init = {}) {
    check(!closed && !transportFailed && client.connected, 'MQTT device connection is unavailable.');
    const url = new URL(pathname, 'https://pulse.anend.net'), operation = operations[url.pathname];
    check(url.origin === 'https://pulse.anend.net' && operation && !url.hash &&
      (operation === 2 ? url.search === `?boot_id=${bootId}` && init.method === 'GET' && init.body === undefined :
        !url.search && init.method === 'POST' && typeof init.body === 'string'), 'Unsupported MQTT device request.');
    const body = Buffer.from(init.body ?? '', 'utf8');
    check(body.length <= 8192 && (operation === 2 || body.length > 0), 'MQTT device body exceeds bounds.');
    check(pending.size === 0 && rpc < 4294967295, 'Serialize MQTT device requests.');
    const topic = `${prefix}/req/ingest/${++rpc}`, replyTopic = topic.replace('/req/', '/rep/');
    const frame = Buffer.concat([Buffer.from([67, 80, 86, 51, 1, operation, 0, 0]), body]);
    counters.requests++;
    return new Promise((resolve, reject) => {
      const done = (value, error = false) => { clearTimeout(timer); pending.delete(replyTopic); error ? reject(value) : resolve(value); };
      const timer = setTimeout(() => { counters.timeouts++; done(new Error('MQTT matching receipt timed out; outcome remains unknown.'), true); }, timeoutMs);
      pending.set(replyTopic, { operation, finish: value => done(value), fail: error => done(error, true) });
      client.publish(topic, frame, { qos: 1, retain: false }, error => {
        if (error) pending.get(replyTopic)?.fail(new Error('MQTT publication failed; outcome remains unknown.'));
      });
    });
  }
  return { request, close, status: () => ({ ...counters, lastRpc: rpc, connected: !closed && !transportFailed && client.connected }) };
}

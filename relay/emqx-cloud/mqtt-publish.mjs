// Worker entry points inject connect from cloudflare:sockets. Keeping that import
// out of this module also allows the same protocol code to run in host tests.
const MAX_TIMEOUT_MS = 8_000;
const MAX_PAYLOAD_BYTES = 2_050;
const encoder = new TextEncoder();

const messages = {
  INVALID_INPUT: 'Invalid MQTT publish configuration',
  TIMEOUT: 'MQTT publish deadline exceeded',
  TRANSPORT: 'MQTT TLS transport failed',
  CONNECTION_REFUSED: 'MQTT connection refused',
  INVALID_PACKET: 'Invalid MQTT acknowledgement',
  PACKET_TOO_LARGE: 'MQTT acknowledgement exceeds its size limit',
  UNEXPECTED_PACKET: 'Unexpected MQTT acknowledgement',
  PACKET_ID_MISMATCH: 'MQTT acknowledgement packet identifier mismatch',
};

export class MqttPublishError extends Error {
  constructor(code) {
    super(messages[code]);
    this.name = 'MqttPublishError';
    this.code = code;
  }
}

function fail(code) {
  throw new MqttPublishError(code);
}

function mqttString(value, maxBytes) {
  if (typeof value !== 'string' || !value.length || value.length > maxBytes) fail('INVALID_INPUT');
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point < 0x20 || (point >= 0x7f && point <= 0x9f)
      || (point >= 0xd800 && point <= 0xdfff)
      || (point >= 0xfdd0 && point <= 0xfdef) || (point & 0xffff) >= 0xfffe) fail('INVALID_INPUT');
  }
  const bytes = encoder.encode(value);
  if (bytes.length > maxBytes) fail('INVALID_INPUT');
  return join(Uint8Array.of(bytes.length >> 8, bytes.length & 255), bytes);
}

function join(...parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function packet(header, body) {
  let remaining = body.length;
  const length = [];
  do {
    let digit = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining) digit |= 128;
    length.push(digit);
  } while (remaining);
  return join(Uint8Array.of(header, ...length), body);
}

async function until(promise, deadline) {
  const pending = Promise.resolve(promise);
  const remaining = deadline - performance.now();
  if (remaining <= 0) {
    void pending.catch(() => {});
    fail('TIMEOUT');
  }
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new MqttPublishError('TIMEOUT')), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class Acknowledgements {
  constructor(reader, deadline) {
    this.reader = reader;
    this.deadline = deadline;
    this.chunk = new Uint8Array();
    this.offset = 0;
    this.reads = 0;
  }

  async byte() {
    while (this.offset === this.chunk.length) {
      // Both expected replies are four bytes. Bound even empty-chunk attacks.
      if (++this.reads > 16) fail('INVALID_PACKET');
      const { value, done } = await until(this.reader.read(), this.deadline);
      if (done) fail('TRANSPORT');
      if (!(value instanceof Uint8Array)) fail('INVALID_PACKET');
      if (value.length > 8) fail('PACKET_TOO_LARGE');
      this.chunk = value;
      this.offset = 0;
    }
    return this.chunk[this.offset++];
  }

  async read(header) {
    if (await this.byte() !== header) fail('UNEXPECTED_PACKET');
    // MQTT 3.1.1 CONNACK and PUBACK both have a canonical remaining length of
    // exactly two. Reject continuation/oversize before reading any body.
    const length = await this.byte();
    if (length > 2) fail('PACKET_TOO_LARGE');
    if (length !== 2) fail('INVALID_PACKET');
    const body = Uint8Array.of(await this.byte(), await this.byte());
    if (this.offset !== this.chunk.length) fail('UNEXPECTED_PACKET');
    return body;
  }
}

/**
 * Publish one already-validated binary RPC reply, with no retries or retained
 * messages. Credentials must be a scoped broker account, never a deployment API
 * key. Worker handlers provide `connect` from `cloudflare:sockets`.
 *
 * Success means only that this broker returned a matching MQTT 3.1.1 PUBACK;
 * it says nothing about device delivery or upstream ingestion durability.
 * `timeoutMs` bounds the entire operation including opening and final cleanup.
 * @param {{connect?: typeof import('cloudflare:sockets').connect, hostname?: string,
 * username?: string, password?: string, topic?: string, payload?: Uint8Array,
 * timeoutMs?: number}} options
 */
export async function publishMqttReply({
  connect, hostname, username, password, topic, payload, timeoutMs = MAX_TIMEOUT_MS,
} = {}) {
  if (typeof connect !== 'function' || typeof hostname !== 'string' || hostname.length > 253
    || !hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS
    || !(payload instanceof Uint8Array) || payload.length > MAX_PAYLOAD_BYTES
    || typeof topic !== 'string' || /[+#]/.test(topic)) fail('INVALID_INPUT');
  const topicField = mqttString(topic, 256);
  const userField = mqttString(username, 256);
  const passwordField = mqttString(password, 512);
  const body = payload.slice();
  const deadline = performance.now() + timeoutMs;
  const workDeadline = deadline - Math.min(250, Math.max(1, timeoutMs / 8));
  let socket;
  let writer;
  let reader;
  let connected = false;
  let writePending = false;
  let failure;
  let acknowledged = false;
  try {
    // 23 ASCII characters keeps the client ID within MQTT 3.1.1's mandatory
    // supported range. Each one-shot clean session has a fresh 84-bit ID.
    const random = crypto.getRandomValues(new Uint8Array(11));
    const clientId = `cp${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 21)}`;
    const connectPacket = packet(0x10, join(
      Uint8Array.of(0, 4, 77, 81, 84, 84, 4, 0xc2, 0, 30),
      mqttString(clientId, 23), userField, passwordField,
    ));
    socket = connect({ hostname, port: 8883 }, { secureTransport: 'on', allowHalfOpen: false });
    // Observe the independent lifecycle rejection even if opening/reading fails.
    void Promise.resolve(socket.closed).catch(() => {});
    await until(socket.opened, workDeadline);
    writer = socket.writable.getWriter();
    reader = socket.readable.getReader();
    const replies = new Acknowledgements(reader, workDeadline);
    writePending = true;
    await until(writer.write(connectPacket), workDeadline);
    writePending = false;
    const connack = await replies.read(0x20);
    if (connack[0] !== 0 || connack[1] > 5) fail('INVALID_PACKET');
    if (connack[1] !== 0) fail('CONNECTION_REFUSED');
    connected = true;
    writePending = true;
    await until(writer.write(packet(0x32, join(topicField, Uint8Array.of(0, 1), body))), workDeadline);
    writePending = false;
    const puback = await replies.read(0x40);
    if (puback[0] !== 0 || puback[1] !== 1) fail('PACKET_ID_MISMATCH');
    acknowledged = true;
  } catch (error) {
    // Never expose arbitrary socket errors, their causes, endpoint or credentials.
    failure = error instanceof MqttPublishError ? error : new MqttPublishError('TRANSPORT');
  } finally {
    if (connected && writer && !writePending) {
      try {
        // Reserve half the remaining cleanup time for the mandatory socket close.
        await until(writer.write(Uint8Array.of(0xe0, 0)),
          performance.now() + Math.max(0, (deadline - performance.now()) / 2));
      } catch (error) {
        failure ??= error instanceof MqttPublishError ? error : new MqttPublishError('TRANSPORT');
      }
    }
    if (socket) {
      try {
        // Invoke even after expiry: initiating close must never depend on a peer.
        await until(socket.close(), deadline);
      } catch (error) {
        failure ??= error instanceof MqttPublishError ? error : new MqttPublishError('TRANSPORT');
      }
    }
    try { reader?.releaseLock(); } catch { /* Closing can invalidate a lock. */ }
    try { writer?.releaseLock(); } catch { /* Closing can invalidate a lock. */ }
  }
  if (failure) throw failure;
  if (!acknowledged) fail('TRANSPORT');
  return { acknowledged: true, packetId: 1 };
}

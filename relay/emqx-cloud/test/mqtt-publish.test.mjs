import assert from 'node:assert/strict';
import test from 'node:test';
import { MqttPublishError, publishMqttReply } from '../mqtt-publish.mjs';

const never = () => new Promise(() => {});
const bytes = (...values) => Uint8Array.from(values);
const connack = bytes(0x20, 2, 0, 0);
const puback = bytes(0x40, 2, 0, 1);

function broker(options = {}) {
  const writes = [];
  const connections = [];
  let controller;
  let closed = false;
  let closeCalls = 0;
  let resolveClosed;
  const socket = {
    opened: options.hangOpened ? never() : options.openError
      ? Promise.reject(new Error('private-password in upstream error')) : Promise.resolve({}),
    closed: new Promise((resolve) => { resolveClosed = resolve; }),
    readable: new ReadableStream({ start(value) { controller = value; } }),
    writable: new WritableStream({
      async write(value) {
        writes.push(value.slice());
        if (options.hangWriteAt === writes.length) return never();
        if (options.throwWriteAt === writes.length) throw new Error('private-password');
        let reply;
        if (value[0] === 0x10) reply = options.connack ?? connack;
        if (value[0] === 0x32) reply = options.puback ?? puback;
        if (reply && !options.hangRead && !(options.hangPuback && value[0] === 0x32) && !closed) {
          if (options.eof) controller.close();
          else if (options.emptyChunks) {
            for (let count = 0; count < 17; count++) controller.enqueue(bytes());
          }
          else if (options.fragmented) {
            for (const byte of reply) controller.enqueue(bytes(byte));
          } else controller.enqueue(reply);
        }
      },
    }),
    close() {
      closeCalls++;
      closed = true;
      if (!options.eof) controller.error(new Error('Socket closed'));
      resolveClosed();
      if (options.hangClose) return never();
      if (options.closeError) return Promise.reject(new Error('private-password'));
      return Promise.resolve();
    },
  };
  return {
    socket, writes, connections,
    get closeCalls() { return closeCalls; },
    connect(address, config) {
      connections.push({ address, config });
      return socket;
    },
  };
}

function input(mock, overrides = {}) {
  return {
    connect: mock.connect,
    hostname: 'example.emqxsl.cn',
    username: 'scoped-publisher',
    password: 'private-password',
    topic: 'cp/v1/node/reply',
    payload: bytes(0, 200, 123, 125),
    ...overrides,
  };
}

function readPacket(data) {
  let length = 0;
  let multiplier = 1;
  let offset = 1;
  let digit;
  do {
    digit = data[offset++];
    length += (digit & 127) * multiplier;
    multiplier *= 128;
  } while (digit & 128);
  assert.equal(data.length, offset + length);
  return { header: data[0], body: data.slice(offset) };
}

function stringField(data, offset) {
  const size = data[offset] * 256 + data[offset + 1];
  return {
    value: new TextDecoder().decode(data.slice(offset + 2, offset + 2 + size)),
    next: offset + 2 + size,
  };
}

function assertReleased(mock) {
  assert.equal(mock.closeCalls, 1);
  assert.equal(mock.socket.readable.locked, false);
  assert.equal(mock.socket.writable.locked, false);
}

async function rejects(mock, code, overrides = {}) {
  await assert.rejects(publishMqttReply(input(mock, overrides)), (error) => {
    assert.ok(error instanceof MqttPublishError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes('private-password'));
    assert.ok(!error.stack.includes('private-password'));
    return true;
  });
}

test('TLS clean-session CONNECT, exact QoS1 bytes, matching PUBACK and cleanup', async () => {
  const mock = broker();
  const payload = bytes(0, 200, 0, 255, 123, 125);
  assert.deepEqual(await publishMqttReply(input(mock, { payload })), { acknowledged: true, packetId: 1 });
  assert.deepEqual(mock.connections, [{
    address: { hostname: 'example.emqxsl.cn', port: 8883 },
    config: { secureTransport: 'on', allowHalfOpen: false },
  }]);
  assert.equal(mock.writes.length, 3);
  const connect = readPacket(mock.writes[0]);
  assert.equal(connect.header, 0x10);
  assert.deepEqual(connect.body.slice(0, 10), bytes(0, 4, 77, 81, 84, 84, 4, 0xc2, 0, 30));
  const clientId = stringField(connect.body, 10);
  assert.match(clientId.value, /^cp[0-9a-f]{21}$/);
  const user = stringField(connect.body, clientId.next);
  assert.equal(user.value, 'scoped-publisher');
  const password = stringField(connect.body, user.next);
  assert.equal(password.value, 'private-password');
  assert.equal(password.next, connect.body.length);
  const publish = readPacket(mock.writes[1]);
  assert.equal(publish.header, 0x32); // QoS1, DUP false, retained false.
  const topic = stringField(publish.body, 0);
  assert.equal(topic.value, 'cp/v1/node/reply');
  assert.deepEqual(publish.body.slice(topic.next, topic.next + 2), bytes(0, 1));
  assert.deepEqual(publish.body.slice(topic.next + 2), payload);
  assert.deepEqual(mock.writes[2], bytes(0xe0, 0));
  assertReleased(mock);
});

test('accepts single-byte fragmented acknowledgements and maximum binary payload', async () => {
  const mock = broker({ fragmented: true });
  const payload = new Uint8Array(2050).fill(255);
  await publishMqttReply(input(mock, { payload }));
  const publish = readPacket(mock.writes[1]);
  const topic = stringField(publish.body, 0);
  assert.deepEqual(publish.body.slice(topic.next + 2), payload);
  assertReleased(mock);
});

test('client IDs are fresh and payload is snapshotted before opening', async () => {
  const first = broker();
  const second = broker();
  const payload = bytes(0, 1, 2);
  const result = publishMqttReply(input(first, { payload }));
  payload.fill(0xff);
  await result;
  await publishMqttReply(input(second));
  const firstClient = stringField(readPacket(first.writes[0]).body, 10).value;
  const secondClient = stringField(readPacket(second.writes[0]).body, 10).value;
  assert.notEqual(firstClient, secondClient);
  const publish = readPacket(first.writes[1]);
  assert.deepEqual(publish.body.slice(stringField(publish.body, 0).next + 2), bytes(0, 1, 2));
});

test('refuses invalid or oversized inputs before opening a socket', async () => {
  const invalid = [
    { payload: new Uint8Array(2051) }, { payload: 'binary required' },
    { topic: 'cp/+/reply' }, { topic: 'cp/#' }, { topic: '' },
    { topic: 'a'.repeat(257) }, { topic: '\ud800' }, { topic: 'cp/\0/reply' },
    { username: '' }, { password: '' }, { hostname: 'mqtt://broker.example' },
    { hostname: 'broker.example:1883' }, { hostname: '-invalid.example' },
    { timeoutMs: 8001 }, { timeoutMs: 0 }, { timeoutMs: Number.NaN },
  ];
  for (const overrides of invalid) {
    const mock = broker();
    await rejects(mock, 'INVALID_INPUT', overrides);
    assert.equal(mock.connections.length, 0);
    assert.equal(mock.writes.length, 0);
  }
});

test('rejects an endless sequence of empty chunks with bounded work', async () => {
  const mock = broker({ emptyChunks: true });
  await rejects(mock, 'INVALID_PACKET');
  assertReleased(mock);
});

for (const code of [1, 2, 3, 4, 5]) {
  test(`rejects MQTT connection refusal ${code} without publishing`, async () => {
    const mock = broker({ connack: bytes(0x20, 2, 0, code) });
    await rejects(mock, 'CONNECTION_REFUSED');
    assert.equal(mock.writes.length, 1);
    assertReleased(mock);
  });
}

for (const [name, response, code] of [
  ['session-present on clean session', bytes(0x20, 2, 1, 0), 'INVALID_PACKET'],
  ['reserved CONNACK flags', bytes(0x20, 2, 2, 0), 'INVALID_PACKET'],
  ['invalid CONNACK return code', bytes(0x20, 2, 0, 6), 'INVALID_PACKET'],
  ['incorrect CONNACK fixed flags', bytes(0x21, 2, 0, 0), 'UNEXPECTED_PACKET'],
  ['unexpected packet type', bytes(0xd0, 0), 'UNEXPECTED_PACKET'],
  ['oversized length declaration', bytes(0x20, 127), 'PACKET_TOO_LARGE'],
  ['overlong remaining length', bytes(0x20, 0x82, 0, 0, 0), 'PACKET_TOO_LARGE'],
  ['undersized length', bytes(0x20, 1, 0), 'INVALID_PACKET'],
  ['coalesced unsolicited packet', bytes(0x20, 2, 0, 0, 0xd0, 0), 'UNEXPECTED_PACKET'],
  ['oversized input chunk', new Uint8Array(9), 'PACKET_TOO_LARGE'],
]) {
  test(`rejects ${name}`, async () => {
    const mock = broker({ connack: response });
    await rejects(mock, code);
    assert.equal(mock.writes.length, 1);
    assertReleased(mock);
  });
}

for (const [name, response, code] of [
  ['different PUBACK packet ID', bytes(0x40, 2, 0, 2), 'PACKET_ID_MISMATCH'],
  ['zero PUBACK packet ID', bytes(0x40, 2, 0, 0), 'PACKET_ID_MISMATCH'],
  ['incorrect PUBACK fixed flags', bytes(0x41, 2, 0, 1), 'UNEXPECTED_PACKET'],
  ['MQTT5 negative PUBACK extension', bytes(0x40, 3, 0, 1, 0x87), 'PACKET_TOO_LARGE'],
  ['server DISCONNECT instead of PUBACK', bytes(0xe0, 0), 'UNEXPECTED_PACKET'],
]) {
  test(`rejects ${name} and closes the clean session`, async () => {
    const mock = broker({ puback: response });
    await rejects(mock, code);
    assert.deepEqual(mock.writes.at(-1), bytes(0xe0, 0));
    assertReleased(mock);
  });
}

for (const [name, options] of [
  ['TLS open', { hangOpened: true }],
  ['CONNECT write', { hangWriteAt: 1 }],
  ['CONNACK read', { hangRead: true }],
  ['PUBLISH write', { hangWriteAt: 2 }],
  ['PUBACK read', { hangPuback: true }],
  ['DISCONNECT write', { hangWriteAt: 3 }],
  ['socket close', { hangClose: true }],
]) {
  test(`total deadline bounds a stalled ${name} including cleanup`, async () => {
    const mock = broker(options);
    const start = performance.now();
    await rejects(mock, 'TIMEOUT', { timeoutMs: 60 });
    assert.ok(performance.now() - start < 200, 'deadline must include cleanup');
    assertReleased(mock);
    assert.equal(mock.connections.length, 1, 'never reconnect');
  });
}

test('closing remains bounded after an earlier read timeout', async () => {
  const mock = broker({ hangRead: true, hangClose: true });
  const start = performance.now();
  await rejects(mock, 'TIMEOUT', { timeoutMs: 60 });
  assert.ok(performance.now() - start < 200);
  assertReleased(mock);
});

for (const options of [{ openError: true }, { throwWriteAt: 1 }, { throwWriteAt: 2 }, { closeError: true }, { eof: true }]) {
  test(`sanitizes transport errors and releases resources ${JSON.stringify(options)}`, async () => {
    const mock = broker(options);
    await rejects(mock, 'TRANSPORT');
    assertReleased(mock);
  });
}

test('sanitizes synchronous connect failure without exposing endpoint/credentials', async () => {
  const mock = broker();
  await rejects(mock, 'TRANSPORT', { connect() { throw new Error('private-password'); } });
  assert.equal(mock.closeCalls, 0);
});

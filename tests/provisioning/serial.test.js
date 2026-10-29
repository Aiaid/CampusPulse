import { describe, it, expect } from 'vitest';
import { SerialFrames, serialFrame, SERIAL_PREFIX, openSerialClient, connectSerialProvisioning, connectSerialDiagnostics, selectProvisioningPort, serialSupport } from '../../src/admin/provisioning/serial.js';
import { TEST_NODE, TEST_NONCE, TEST_TOKEN } from './constants.mjs';
const encoder = new TextEncoder(), id = '11111111-2222-4333-8444-555555555555', other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const info = { v: 1, ok: true, node_id: TEST_NODE, board: 'Synthetic headless board', transport: 'usb', security: 'physical-usb', nonce: TEST_NONCE };
function fakePort(respond) {
  let controller, opened = false, closed = false;
  const calls = [];
  const port = { calls, get closed() { return closed; }, async open(options) { expect(options.baudRate).toBe(115200); opened = true; }, async close() { closed = true; },
    readable: new ReadableStream({ start(c) { controller = c; } }),
    writable: new WritableStream({ async write(data) {
      expect(opened).toBe(true);
      const text = new TextDecoder().decode(data), requestId = text.slice(SERIAL_PREFIX.length, SERIAL_PREFIX.length + 36), body = JSON.parse(text.slice(SERIAL_PREFIX.length + 37)); calls.push(body);
      const result = await respond(body, requestId);
      if (result) { controller.enqueue(encoder.encode('unrelated boot log\n')); const frame = serialFrame(requestId, result); controller.enqueue(frame.subarray(0, 7)); controller.enqueue(frame.subarray(7)); }
    } }),
    emit(bytes) { controller.enqueue(bytes); }, unplug() { controller.close(); },
  }; return port;
}
describe('bounded USB provisioning framing', () => {
  it('parses arbitrarily fragmented UTF-8 and multiple frames while discarding console logs', () => {
    const frames = [], parser = new SerialFrames((...frame) => frames.push(frame));
    parser.push(encoder.encode('boot log\n'.repeat(4000)));
    const body = { v: 1, ok: true, board: '测试板' }, data = serialFrame(id, body);
    for (const byte of data) parser.push(new Uint8Array([byte]));
    parser.push(serialFrame(other, { v: 1, ok: true }));
    expect(frames).toEqual([[id, body], [other, { v: 1, ok: true }]]); expect(parser.length).toBe(0);
  });
  it('recovers only at RS after malformed/oversize lines and never retains unbounded logs', () => {
    const frames = [], parser = new SerialFrames((...frame) => frames.push(frame));
    parser.push(encoder.encode(`${SERIAL_PREFIX}${id} ${'x'.repeat(10000)}`)); expect(parser.length).toBe(0);
    parser.push(serialFrame(id, { v: 1, ok: true }));
    parser.push(encoder.encode(`${SERIAL_PREFIX}${'X'.repeat(36)} {}\n`));
    parser.push(encoder.encode(`${SERIAL_PREFIX}${id} {\n`));
    expect(frames).toEqual([[id, { v: 1, ok: true }], [id, undefined]]);
    parser.push(new Uint8Array([30, 255, 10])); expect(parser.length).toBe(0);
  });
  it('enforces exact 1536 UTF-8 payload bytes and lowercase UUIDv4', () => {
    const padding = 1536 - encoder.encode(JSON.stringify({ text: '' })).length;
    const frame = serialFrame(id, { text: 'x'.repeat(padding) });
    const frames = []; new SerialFrames((...f) => frames.push(f)).push(frame); expect(frames).toHaveLength(1);
    expect(() => serialFrame(id, { text: 'x'.repeat(padding + 1) })).toThrow('1536');
    expect(() => serialFrame(id, { text: '界'.repeat(520) })).toThrow('1536');
    for (const bad of [id.toUpperCase(), id.replace('-4333-', '-1333-'), id.replace('-8444-', '-7444-')]) {
      // The all-numeric valid ID has no uppercase characters; use alphabetic UUID.
      if (bad !== id) expect(() => serialFrame(bad, {})).toThrow();
    }
    expect(() => serialFrame(other.toUpperCase(), {})).toThrow(); expect(() => serialFrame(id, [])).toThrow();
  });
});
describe('USB browser transport and enrollment boundary', () => {
  it('calls the chooser synchronously and feature detects actual Web Serial availability', async () => {
    let called = false; const selected = selectProvisioningPort({ serial: { requestPort() { called = true; return Promise.resolve('port'); } } });
    expect(called).toBe(true); expect(await selected).toBe('port'); expect(serialSupport({})).toBe(false);
  });
  it('requires begin acknowledgement then polls ready info before exposing a factory identity', async () => {
    let infoCalls = 0;
    const port = fakePort(body => body.op === 'begin' ? { v: 1, ok: true, state: 'starting' } : body.op === 'info' ? (++infoCalls === 1 ? { v: 1, ok: false, reason: 'setup_not_ready' } : info) : { v: 1, ok: true, state: 'received', attempt_id: body.attempt_id });
    const { client, identity } = await connectSerialProvisioning(port, { pollMs: 1 }); expect(identity.node_id).toBe(TEST_NODE); expect(port.calls.map(r => r.op)).toEqual(['begin', 'info', 'info']);
    await client.request({ op: 'configure', nonce: 'caller-cannot-override-session', node_id: TEST_NODE, attempt_id: id, ssid: 'synthetic', password: 'synthetic-password', device_token: TEST_TOKEN });
    expect(port.calls[3]).toEqual({ v: 1, op: 'info' }); expect(port.calls[4].nonce).toBe(TEST_NONCE); expect(port.calls[4].device_token).toBe(TEST_TOKEN); expect(port.calls[4].proof).toBeUndefined();
    await client.request({ op: 'status' }); expect(port.calls[5]).toEqual({ v: 1, op: 'status' }); await client.close(); expect(port.closed).toBe(true);
  });
  it('refreshes a rotated nonce after failed Wi-Fi validation and keeps the same cloud credential', async () => {
    let sessionNonce = TEST_NONCE, state = 'waiting'; const candidates = [];
    const port = fakePort(body => {
      if (body.op === 'begin') return { v: 1, ok: true, state: 'starting' };
      if (body.op === 'info') return { ...info, nonce: sessionNonce, state };
      if (body.op === 'status') return { v: 1, ok: true, state };
      expect(body.nonce).toBe(sessionNonce); candidates.push(body);
      return { v: 1, ok: true, state: 'received', attempt_id: body.attempt_id };
    });
    const { client } = await connectSerialProvisioning(port);
    await client.request({ op: 'configure', node_id: TEST_NODE, attempt_id: id, password: 'first-synthetic-password', device_token: TEST_TOKEN });
    state = 'failed'; sessionNonce = 'cd'.repeat(16);
    expect((await client.request({ op: 'status' })).state).toBe('failed');
    await client.request({ op: 'configure', node_id: TEST_NODE, attempt_id: other, password: 'corrected-synthetic-password', device_token: TEST_TOKEN });
    expect(candidates.map(c => c.nonce)).toEqual([TEST_NONCE, sessionNonce]);
    expect(candidates.map(c => c.device_token)).toEqual([TEST_TOKEN, TEST_TOKEN]);
    expect(candidates[0].attempt_id).not.toBe(candidates[1].attempt_id); await client.close();
  });
  it('refuses to send credentials if factory identity changes before configure', async () => {
    let reads = 0;
    const port = fakePort(body => body.op === 'begin' ? { v: 1, ok: true, state: 'starting' } : { ...info, node_id: ++reads === 1 ? TEST_NODE : 'cp_ffffffffffff' });
    const { client } = await connectSerialProvisioning(port);
    await expect(client.request({ op: 'configure', node_id: TEST_NODE, device_token: TEST_TOKEN })).rejects.toThrow('身份');
    expect(port.calls.some(c => c.op === 'configure' || c.device_token)).toBe(false); expect(port.closed).toBe(true);
  });
  it('probes info after a lost begin ACK and only retries begin for explicit not-ready', async () => {
    let begins = 0, infos = 0;
    const port = fakePort(body => {
      if (body.op === 'begin') return ++begins === 1 ? null : { v: 1, ok: true, state: 'starting' };
      if (++infos <= 2) return { v: 1, ok: false, reason: 'session_busy' };
      return begins === 1 ? { v: 1, ok: false, reason: 'setup_not_ready' } : info;
    });
    const { client } = await connectSerialProvisioning(port, { timeoutMs: 3, pollMs: 1, readyTimeoutMs: 100 });
    expect(port.calls.map(c => c.op)).toEqual(['begin', 'info', 'info', 'info', 'begin', 'info']); await client.close();
  });
  it('accepts ready info after a lost begin ACK without resetting the session again', async () => {
    const port = fakePort(body => body.op === 'begin' ? null : info);
    const { client } = await connectSerialProvisioning(port, { timeoutMs: 3, pollMs: 1, readyTimeoutMs: 100 });
    expect(port.calls.map(c => c.op)).toEqual(['begin', 'info']); await client.close();
  });
  it('bounds lost boot handshakes to three begins and never sends configure', async () => {
    const port = fakePort(body => body.op === 'begin' ? null : { v: 1, ok: false, reason: 'setup_not_ready' });
    await expect(connectSerialProvisioning(port, { timeoutMs: 3, pollMs: 1, readyTimeoutMs: 100 })).rejects.toThrow('尚未准备好');
    expect(port.calls.filter(c => c.op === 'begin')).toHaveLength(3); expect(port.calls.some(c => c.op === 'configure')).toBe(false); expect(port.closed).toBe(true);
  });
  it('refuses saved credential reuse if capability disappears at the fresh identity check', async () => {
    let reads = 0;
    const port = fakePort(body => body.op === 'begin' ? { v: 1, ok: true, state: 'starting' } : { ...info, has_saved_credential: ++reads === 1 });
    const { client } = await connectSerialProvisioning(port);
    await expect(client.request({ op: 'configure', node_id: TEST_NODE, reuse_saved_credential: true })).rejects.toMatchObject({ code: 'saved_credential_unavailable' });
    expect(port.calls.some(c => c.op === 'configure')).toBe(false); await client.close();
  });
  it('waits for one in-flight status poll before fresh info and a single configure', async () => {
    let finishStatus; const port = fakePort(body => {
      if (body.op === 'begin') return { v: 1, ok: true, state: 'starting' };
      if (body.op === 'info') return info;
      if (body.op === 'status') return new Promise(resolve => { finishStatus = () => resolve({ v: 1, ok: true, state: 'failed' }); });
      return { v: 1, ok: true, state: 'received', attempt_id: body.attempt_id };
    });
    const { client } = await connectSerialProvisioning(port);
    const poll = client.request({ op: 'status' }); await new Promise(resolve => setTimeout(resolve, 0));
    await expect(client.request({ op: 'status' })).rejects.toThrow('正在读取');
    const submit = client.request({ op: 'configure', node_id: TEST_NODE, attempt_id: id, device_token: TEST_TOKEN });
    expect(port.calls.map(c => c.op)).toEqual(['begin', 'info', 'status']);
    finishStatus(); await poll; expect((await submit).state).toBe('received');
    expect(port.calls.map(c => c.op)).toEqual(['begin', 'info', 'status', 'info', 'configure']); await client.close();
  });
  it('rejects supervisor busy, wrong transport, bad identity and missing nonce; closes the port', async () => {
    for (const ready of [{ ...info, nonce: undefined }, { ...info, node_id: 'browser-opaque-id' }, { ...info, transport: 'ble' }, { ...info, security: 'security2' }]) {
      const port = fakePort(body => body.op === 'begin' ? { v: 1, ok: true, state: 'starting' } : ready);
      await expect(connectSerialProvisioning(port)).rejects.toThrow('身份'); expect(port.closed).toBe(true);
    }
    const port = fakePort(() => ({ v: 1, ok: false, reason: 'supervisor_busy' })); await expect(connectSerialProvisioning(port)).rejects.toThrow('supervisor_busy'); expect(port.calls).toHaveLength(1); expect(port.closed).toBe(true);
  });
  it('times out readiness without treating the queued begin as completed setup', async () => {
    const port = fakePort(body => body.op === 'begin' ? { v: 1, ok: true, state: 'starting' } : { v: 1, ok: false, reason: 'setup_not_ready' });
    await expect(connectSerialProvisioning(port, { pollMs: 1, readyTimeoutMs: 3 })).rejects.toThrow('尚未准备好'); expect(port.closed).toBe(true);
  });
  it('ignores mismatched request IDs and permits only one pending request', async () => {
    let actualId; const port = fakePort((body, requestId) => { actualId = requestId; return null; });
    const client = await openSerialClient(port, { timeoutMs: 100 });
    const pending = client.request({ op: 'status' }); await expect(client.request({ op: 'info' })).rejects.toThrow('忙');
    port.emit(serialFrame(other, { v: 1, ok: true, state: 'wrong' }));
    port.emit(serialFrame(actualId, { v: 1, ok: true, state: 'right' })); expect((await pending).state).toBe('right'); await client.close();
  });
  it('rejects stale sessions and malformed matching replies without leaking console content', async () => {
    const port = fakePort(() => ({ v: 1, ok: false, reason: 'setup_expired' })); const client = await openSerialClient(port);
    await expect(client.request({ op: 'configure' })).rejects.toMatchObject({ code: 'setup_expired' }); await client.close();
    let requestId; const malformed = fakePort((body, rid) => { requestId = rid; }); const second = await openSerialClient(malformed);
    const pending = second.request({ op: 'status' }); await Promise.resolve(); malformed.emit(encoder.encode(`${SERIAL_PREFIX}${requestId} not-json\n`)); await expect(pending).rejects.toThrow('格式'); await second.close();
  });
  it('handles unplugging and request timeout without claiming successful enrollment', async () => {
    let disconnected = false; const port = fakePort(() => null); const client = await openSerialClient(port, { onDisconnect: () => { disconnected = true; } });
    const pending = client.request({ op: 'status' }); port.unplug(); await expect(pending).rejects.toThrow('断开'); await client.close(); expect(disconnected).toBe(true);
    const timeoutPort = fakePort(() => null), timeout = await openSerialClient(timeoutPort, { timeoutMs: 5 }); await expect(timeout.request({ op: 'configure' })).rejects.toThrow('超时'); await timeout.close();
  });
});

describe('read-only USB diagnosis boot recovery', () => {
  it('retries only status on the same port after a lost boot request', async () => {
    let reads = 0; const port = fakePort(() => ++reads === 1 ? null : { v: 1, ok: true, node_id: TEST_NODE, state: 'waiting' });
    const { client, status } = await connectSerialDiagnostics(port, TEST_NODE, { timeoutMs: 3, pollMs: 1, readyTimeoutMs: 100 });
    expect(status.state).toBe('waiting'); expect(port.calls.map(c => c.op)).toEqual(['status', 'status']);
    await expect(client.request({ op: 'begin' })).rejects.toThrow('只能'); await client.close();
  });
});

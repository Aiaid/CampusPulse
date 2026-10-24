import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import fixture from './idf-security2-fixture.json';
import { establishSecurity2, GcmSession, PIN_PATTERN } from '../../src/admin/provisioning/security2.js';
import { decodeProto, join, protoBytes, protoInt, sessionPacket } from '../../src/admin/provisioning/protocol.js';
import { connectProvisioning, selectProvisioningDevice, SESSION_UUID, APP_UUID } from '../../src/admin/provisioning/bluetooth.js';
import { createPeer, TEST_PROOF, TEST_NODE } from './device-peer.mjs';
const hex = h => new Uint8Array(Buffer.from(h, 'hex'));
const fixedCrypto = { subtle: webcrypto.subtle, getRandomValues: input => { input.set(hex(fixture.client_random)); return input; } };
const fixtureSession = () => { let step = 0; return establishSecurity2(async () => hex(step++ === 0 ? fixture.resp0 : fixture.resp1), fixture.pin, fixedCrypto); };
describe('ESP-IDF 5.5.3 Security 2 client interoperability', () => {
  it('matches both official Python proof packets and bidirectional patch1 GCM messages', async () => {
    let step = 0;
    const cipher = await establishSecurity2(async data => { expect(Buffer.from(data).toString('hex')).toBe(step === 0 ? fixture.cmd0 : fixture.cmd1); return hex(step++ === 0 ? fixture.resp0 : fixture.resp1); }, fixture.pin, fixedCrypto);
    expect(step).toBe(2);
    for (const m of fixture.stream) expect(Buffer.from(await cipher[m.direction](hex(m.direction === 'encrypt' ? m.plain : m.cipher))).toString('hex')).toBe(m.direction === 'encrypt' ? m.cipher : m.plain);
  });
  it('preserves leading zeros and accepts exactly eight ASCII digits', async () => {
    expect(PIN_PATTERN.test('00123456')).toBe(true);
    for (const value of ['1234567', '123456789', '１２３４５６７８', '1234 5678', '00123456\n', fixture.pin.repeat(4), 12345678]) {
      let calls = 0; await expect(establishSecurity2(() => { calls++; }, value)).rejects.toThrow('8 位'); expect(calls).toBe(0);
    }
  });
  it('rejects a wrong PIN, invalid server proof, and downgrade without application data', async () => {
    const peer = createPeer(); await expect(establishSecurity2(data => peer(SESSION_UUID, data), '99999999')).rejects.toThrow();
    for (const response of [new Uint8Array([16, 0]), new Uint8Array([16, 1])]) await expect(establishSecurity2(async () => response, fixture.pin, fixedCrypto)).rejects.toThrow('Security 2');
    let step = 0; const bad = hex(fixture.resp1); bad[20] ^= 1;
    await expect(establishSecurity2(async () => step++ ? bad : hex(fixture.resp0), fixture.pin, fixedCrypto)).rejects.toThrow('不匹配');
  });
  it('rejects invalid public keys, salt, nonce, protocol status and malformed packets', async () => {
    for (const publicKey of [new Uint8Array(384), new Uint8Array(385), hex(fixture.group_N)]) {
      const r = sessionPacket(1, 21, join(protoBytes(2, publicKey), protoBytes(3, hex(fixture.salt))));
      await expect(establishSecurity2(async () => r, fixture.pin, fixedCrypto)).rejects.toThrow();
    }
    for (const salt of [new Uint8Array(15), new Uint8Array(17)]) {
      const r = sessionPacket(1, 21, join(protoBytes(2, new Uint8Array([5])), protoBytes(3, salt)));
      await expect(establishSecurity2(async () => r, fixture.pin, fixedCrypto)).rejects.toThrow();
    }
    const rejected = sessionPacket(1, 21, protoInt(1, 4)); await expect(establishSecurity2(async () => rejected, fixture.pin, fixedCrypto)).rejects.toThrow('验证失败');
    const proof = decodeProto(decodeProto(decodeProto(hex(fixture.resp1)).get(12)).get(23)).get(2);
    for (const nonce of [new Uint8Array(12), new Uint8Array(11)]) {
      let step = 0; await expect(establishSecurity2(async () => step++ ? sessionPacket(3, 23, join(protoBytes(2, proof), protoBytes(3, nonce))) : hex(fixture.resp0), fixture.pin, fixedCrypto)).rejects.toThrow('patch 1');
    }
    expect(() => decodeProto(new Uint8Array([18, 9, 1]))).toThrow(); expect(() => decodeProto(new Uint8Array([16, 2, 16, 2]))).toThrow();
  });
  it('fails closed on altered/replayed ciphertext, concurrent crypto and nonce exhaustion', async () => {
    const cipher = await fixtureSession(); const bad = hex(fixture.stream[0].cipher); bad[0] ^= 1;
    await expect(cipher.decrypt(bad)).rejects.toThrow(); await expect(cipher.encrypt(new Uint8Array([1]))).rejects.toThrow('关闭');
    const replay = await fixtureSession(); await replay.decrypt(hex(fixture.stream[0].cipher)); await expect(replay.decrypt(hex(fixture.stream[0].cipher))).rejects.toThrow();
    const busy = await fixtureSession(); const first = busy.encrypt(new Uint8Array([1])); await expect(busy.encrypt(new Uint8Array([2]))).rejects.toThrow('忙'); await first;
    const key = await webcrypto.subtle.importKey('raw', hex(fixture.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const nonce = hex(fixture.nonce); nonce.fill(255, 8); await expect(new GcmSession(key, nonce).encrypt(new Uint8Array([1]))).rejects.toThrow();
  });
  it('keeps chooser synchronous, verifies factory ID, and bounds plaintext before encryption', async () => {
    let requested = false, connected = false, writes = 0; const candidates = [], peer = createPeer(r => candidates.push(r)), replies = new Map();
    const device = { id: 'opaque-browser-id', gatt: { get connected() { return connected; }, disconnect() { connected = false; }, async connect() { connected = true; return { getPrimaryService: async () => ({ getCharacteristic: async uuid => ({ async writeValueWithResponse(value) { if (uuid === APP_UUID) { writes++; expect(Buffer.from(value).toString()).not.toContain('synthetic-password'); } replies.set(uuid, await peer(uuid, value)); }, async readValue() { return new DataView(Uint8Array.from(replies.get(uuid)).buffer); } }) }) }; } } };
    const selection = selectProvisioningDevice({ bluetooth: { requestDevice: () => { requested = true; return Promise.resolve(device); } } }); expect(requested).toBe(true);
    const { client, identity } = await connectProvisioning(await selection, TEST_PROOF); expect(identity.node_id).toBe(TEST_NODE);
    await client.request({ op: 'configure', attempt_id: '11111111-2222-4333-8444-555555555555', password: 'synthetic-password' }); expect(candidates).toHaveLength(1);
    const count = writes; await expect(client.request({ op: 'configure', password: '界'.repeat(170) })).rejects.toThrow('长度'); expect(writes).toBe(count); expect(connected).toBe(false);
  });
});

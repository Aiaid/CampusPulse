import { describe, expect, it } from 'vitest';
import { wifiPayload, supportsWifiMode } from '../../src/admin/provisioning/network.js';
it('requires an explicit open-network choice and never downgrades an empty personal password', () => {
  expect(() => wifiPayload({ ssid: 'test', password: '' })).toThrow('WPA2');
  expect(wifiPayload({ mode: 'open', ssid: 'test', password: 'must-not-send' })).toEqual({ wifi_security: 'open', ssid: 'test', password: '' });
  expect(supportsWifiMode({}, 'open')).toBe(false);
  expect(supportsWifiMode({ wifi_modes: 7 }, 'enterprise')).toBe(true);
});
it('keeps enterprise credentials in the explicit local PEAP request with an optional outer identity', () => {
  expect(wifiPayload({ mode: 'enterprise', ssid: 'test', username: 'synthetic-user', enterprisePassword: 'synthetic-password', password: 'old-psk' })).toEqual({ wifi_security: 'enterprise', ssid: 'test', password: '', eap_username: 'synthetic-user', eap_password: 'synthetic-password' });
  expect(() => wifiPayload({ mode: 'enterprise', ssid: 'test', username: '', enterprisePassword: 'synthetic' })).toThrow('企业');
  expect(() => wifiPayload({ mode: 'enterprise', ssid: 'test', username: '界'.repeat(44), enterprisePassword: 'synthetic' })).toThrow('企业');
  expect(() => wifiPayload({ mode: 'enterprise', ssid: 'test', username: 'synthetic', enterprisePassword: 'bad\npassword' })).toThrow('企业');
});

describe('local Wi-Fi payload validation', () => {
  it('sends only the selected mode fields, including an explicit optional enterprise identity', () => {
    const input = { ssid: '合成网络', password: 'synthetic-psk', username: 'synthetic-user', identity: 'synthetic-outer', enterprisePassword: 'synthetic-enterprise-password' };
    expect(wifiPayload(input)).toEqual({ wifi_security: 'wpa2', ssid: input.ssid, password: input.password });
    expect(wifiPayload({ ...input, mode: 'open' })).toEqual({ wifi_security: 'open', ssid: input.ssid, password: '' });
    expect(wifiPayload({ ...input, mode: 'enterprise' })).toEqual({ wifi_security: 'enterprise', ssid: input.ssid, password: '', eap_username: input.username, eap_identity: input.identity, eap_password: input.enterprisePassword });
  });

  it('measures SSID and enterprise limits in UTF-8 bytes', () => {
    expect(wifiPayload({ mode: 'open', ssid: '界'.repeat(10) + 'ab' }).ssid).toBe('界'.repeat(10) + 'ab');
    for (const ssid of ['', 'x'.repeat(33), '界'.repeat(11), 'test\0ssid', 'test\nssid', 'test\x7fssid', undefined]) {
      expect(() => wifiPayload({ mode: 'open', ssid })).toThrow('SSID');
    }
    const input = { mode: 'enterprise', ssid: 'synthetic', username: '界'.repeat(42) + 'ab', enterprisePassword: '界'.repeat(42) + 'ab', identity: '界'.repeat(42) + 'ab' };
    expect(wifiPayload(input).eap_username).toBe(input.username);
    for (const field of ['username', 'enterprisePassword', 'identity']) {
      for (const value of ['x'.repeat(129), '界'.repeat(43), 'bad\0value', 'bad\rvalue', 'bad\x7fvalue', null]) {
        expect(() => wifiPayload({ ...input, [field]: value })).toThrow('企业');
      }
    }
    expect(() => wifiPayload({ ...input, enterprisePassword: '' })).toThrow('企业');
  });

  it('accepts only bounded printable personal passwords without trimming secrets', () => {
    for (const password of ['12345678', 'x'.repeat(63), ' spaces ']) {
      expect(wifiPayload({ ssid: 'synthetic', password }).password).toBe(password);
    }
    for (const password of ['', 'x'.repeat(7), 'x'.repeat(64), '密码password', 'bad\npassword', 'bad\x7fpassword', null]) {
      expect(() => wifiPayload({ ssid: 'synthetic', password })).toThrow('WPA2');
    }
    expect(() => wifiPayload({ mode: 'automatic', ssid: 'synthetic', password: 'synthetic-password' })).toThrow('未知');
  });
});

it('requires each explicit nonpersonal firmware capability while retaining legacy WPA2 support', () => {
  for (const identity of [undefined, {}, { wifi_modes: null }, { wifi_modes: '7' }, { wifi_modes: 7.5 }, { wifi_modes: 0 }, { wifi_modes: 1 }]) {
    expect(supportsWifiMode(identity, 'wpa2')).toBe(true);
    expect(supportsWifiMode(identity, 'open')).toBe(false);
    expect(supportsWifiMode(identity, 'enterprise')).toBe(false);
  }
  expect(supportsWifiMode({ wifi_modes: 2 }, 'open')).toBe(true);
  expect(supportsWifiMode({ wifi_modes: 2 }, 'enterprise')).toBe(false);
  expect(supportsWifiMode({ wifi_modes: 4 }, 'open')).toBe(false);
  expect(supportsWifiMode({ wifi_modes: 4 }, 'enterprise')).toBe(true);
  expect(supportsWifiMode({ wifi_modes: 7 }, 'open')).toBe(true);
  expect(supportsWifiMode({ wifi_modes: 7 }, 'unknown')).toBe(false);
});

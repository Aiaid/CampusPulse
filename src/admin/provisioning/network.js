// Local-device payload only. Network credentials never enter cloud API bodies.
export function wifiPayload({ mode = 'wpa2', ssid, password = '', username = '', identity = '', enterprisePassword = '' }) {
  const size = value => typeof value === 'string' ? new TextEncoder().encode(value).length : Infinity;
  const text = value => typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value);
  if (!text(ssid) || size(ssid) < 1 || size(ssid) > 32) throw new Error('SSID 需要 1–32 字节。');
  if (mode === 'open') return { wifi_security: 'open', ssid, password: '' };
  if (mode === 'enterprise') {
    if (!text(username) || size(username) < 1 || size(username) > 128 || !text(enterprisePassword) || size(enterprisePassword) < 1 || size(enterprisePassword) > 128 || !text(identity) || size(identity) > 128) throw new Error('企业认证用户名和密码需要 1–128 字节，外层身份最多 128 字节。');
    return { wifi_security: 'enterprise', ssid, password: '', eap_username: username, eap_password: enterprisePassword, ...(identity ? { eap_identity: identity } : {}) };
  }
  if (mode !== 'wpa2') throw new Error('未知的 Wi-Fi 认证方式。');
  if (!text(password) || size(password) < 8 || size(password) > 63 || /[^\x20-\x7e]/.test(password)) throw new Error('WPA2 密码需要 8–63 个可打印 ASCII 字符。');
  return { wifi_security: 'wpa2', ssid, password };
}
export function supportsWifiMode(identity, mode) {
  if (mode === 'wpa2') return true;
  const bit = mode === 'open' ? 2 : mode === 'enterprise' ? 4 : 0;
  return !!bit && Number.isInteger(identity?.wifi_modes) && !!(identity.wifi_modes & bit);
}

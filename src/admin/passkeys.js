import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

export function passkeySupport() {
  if (!window.isSecureContext) return '当前页面不是安全上下文。请使用本站 HTTPS 地址；本地测试可使用 localhost。';
  if (!window.PublicKeyCredential || !navigator.credentials) return '当前浏览器不支持 Passkey。请使用密码登录，或换用支持 WebAuthn 的浏览器。';
  return null;
}

function browserError(error) {
  const name = error?.name || error?.cause?.name;
  const code = error?.code;
  if (name === 'NotAllowedError' || name === 'AbortError' || code === 'ERROR_CEREMONY_ABORTED') return new Error('Passkey 操作已取消、超时或未获授权；尚未完成验证。可以重试或使用密码。');
  if (name === 'InvalidStateError' || code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return new Error('这个 Passkey 可能已经登记。请查看现有列表，或选择另一个验证器。');
  if (name === 'SecurityError' || code === 'ERROR_INVALID_DOMAIN') return new Error('Passkey 域名或来源与服务器配置不匹配。请使用登记时的站点地址，或联系部署维护者。');
  if (name === 'NotSupportedError' || code === 'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEY_ALG') return new Error('当前验证器不支持本站要求的 Passkey 参数，请使用密码或其他验证器。');
  return new Error('Passkey 操作未完成。请检查浏览器和验证器后重试，或使用密码。');
}

/** Called only from an explicit user action; no conditional or automatic prompt. */
export async function authenticatePasskey(api, intent = 'login') {
  const unavailable = passkeySupport();
  if (unavailable) throw new Error(unavailable);
  const options = await api('/passkeys/authentication/options', { method: 'POST', body: { intent } });
  let response;
  try { response = await startAuthentication({ optionsJSON: options.optionsJSON }); }
  catch (error) { throw browserError(error); }
  return api('/passkeys/authentication/verify', { method: 'POST', body: { challenge_id: options.challenge_id, response } });
}

export async function registerPasskey(api, name) {
  const unavailable = passkeySupport();
  if (unavailable) throw new Error(unavailable);
  const options = await api('/passkeys/registration/options', { method: 'POST', body: { name } });
  let response;
  try { response = await startRegistration({ optionsJSON: options.optionsJSON }); }
  catch (error) { throw browserError(error); }
  return api('/passkeys/registration/verify', { method: 'POST', body: { challenge_id: options.challenge_id, response } });
}

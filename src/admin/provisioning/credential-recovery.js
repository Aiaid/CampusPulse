import { NODE_PATTERN, TOKEN_PATTERN } from './enrollment.js';
import { adminErrorReference } from '../error-reference.js';

const trustedIdentity = (identity, node, transport) =>
  identity?.node_id === node && identity.transport === transport &&
  ((transport === 'usb' && identity.security === 'physical-usb') ||
    (transport === 'ble' && identity.security === 'security2'));
const validCredential = reply => typeof reply?.credential === 'string' && TOKEN_PATTERN.test(reply.credential);

// Only an explicit physical-device recovery action may call this helper. Keep
// the returned credential in the caller's memory for local retries; never issue
// another credential merely because writing it to the device failed.
export async function prepareNetworkCredential({ node, identity, client, api, sensitiveAction, beforeIssue = async () => {} }) {
  let lastOutcome = 'not_started', attempts = 0;
  try {
    if (typeof node !== 'string' || !NODE_PATTERN.test(node) ||
      !trustedIdentity(identity, node, client?.transport) ||
      identity.has_saved_credential !== false || typeof client?.request !== 'function' ||
      typeof api !== 'function' || typeof sensitiveAction !== 'function') {
      throw new Error('请先连接同一台现场设备，并确认设备明确没有已保存凭证。');
    }

    const transport = identity.transport;
    const readCurrent = async () => {
      const current = await client.request({ op: 'info' });
      if (client.transport !== transport || !trustedIdentity(current, node, transport) ||
        !['waiting', 'failed'].includes(current.state) ||
        typeof current.has_saved_credential !== 'boolean') {
        throw new Error('设备身份、凭证能力或配网状态已变化，请重新读取同一设备后再操作。');
      }
      return current;
    };
    const current = await readCurrent();
    if (current.has_saved_credential) return { mode: 'saved', identity: current };

    const result = await sensitiveAction(async () => {
      // The existing sensitive-action wrapper may retry once after the server
      // explicitly rejects the first request for reauthentication. All other
      // outcomes must be retained, including a lost or malformed response.
      if (attempts && (attempts !== 1 || lastOutcome !== 'reauth_required')) {
        throw new Error('凭证请求不能自动重复，请先核对上次操作结果。');
      }
      // Reauthentication can wait for user interaction. Check again inside its
      // callback, including on its one permitted retry, before any mutation.
      const latest = await readCurrent();
      if (latest.has_saved_credential) return { mode: 'saved', identity: latest };
      await beforeIssue(latest);
      attempts++;
      lastOutcome = 'pending';
      let reply;
      try {
        reply = await api(`/devices/${node}/rotate-credential`, { method: 'POST', body: {} });
      } catch (error) {
        const rejected = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500;
        lastOutcome = rejected ? (error.status === 403 && error.code === 'reauth_required' ? 'reauth_required' : 'rejected') : 'uncertain';
        throw error;
      }
      lastOutcome = 'succeeded';
      if (!validCredential(reply)) throw new Error('未收到有效新凭证，请核对结果，勿自动重复签发。');
      return { mode: 'provided', identity: latest, credential: reply.credential };
    });
    if (result?.mode === 'saved' && trustedIdentity(result.identity, node, transport) && result.identity.has_saved_credential === true) return result;
    if (result?.mode !== 'provided' || !validCredential(result)) throw new Error('未收到有效新凭证，请核对结果，勿自动重复签发。');
    return result;
  } catch (error) {
    // Track the most recent POST, not just whether any POST ever started: a
    // rejected reauth request followed by cancellation made no credential.
    const failure = new Error(error instanceof Error ? error.message : '凭证准备失败，请检查设备和管理服务。');
    if (typeof error?.code === 'string') failure.code = error.code;
    if (Number.isInteger(error?.status)) failure.status = error.status;
    const reference = adminErrorReference(error?.requestId);
    if (reference) failure.requestId = reference;
    failure.credentialIssuanceUncertain = ['pending', 'uncertain', 'succeeded'].includes(lastOutcome);
    throw failure;
  }
}

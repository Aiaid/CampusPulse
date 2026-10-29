import { describe, it, expect, vi } from 'vitest';
import { prepareNetworkCredential } from '../../src/admin/provisioning/credential-recovery.js';

const node = 'cp_001122aabbcc';
const credential = `cpd_${'1'.repeat(64)}`;
function setup(overrides = {}) {
  const identity = { node_id: node, transport: 'usb', security: 'physical-usb', has_saved_credential: false, state: 'waiting' };
  const current = { ...identity };
  return { node, identity, client: { transport: 'usb', request: vi.fn().mockResolvedValue(current) },
    api: vi.fn().mockResolvedValue({ credential }), sensitiveAction: vi.fn(action => action()), ...overrides };
}
const httpError = (status, code = 'rejected') => Object.assign(new Error('Request rejected'), { status, code });
const reauthWrapper = async action => {
  try { return await action(); }
  catch (error) { if (error.code !== 'reauth_required') throw error; return action(); }
};

describe('physical-device missing-credential recovery', () => {
  it.each(['12345678-1234-4567-89ab-123456789abc', 'invalid-private-reference'])('retains only a validated admin failure reference through credential recovery', async reference => {
    const error = Object.assign(httpError(503, 'storage_unavailable'), { requestId: reference });
    const args = setup({ api: vi.fn().mockRejectedValue(error) });
    const failure = await prepareNetworkCredential(args).catch(value => value);
    expect(failure).toMatchObject({ status: 503, code: 'storage_unavailable', credentialIssuanceUncertain: true });
    expect(failure.requestId).toBe(reference.startsWith('1234') ? reference : undefined);
    expect(args.api).toHaveBeenCalledOnce();
  });

  it.each([
    ['invalid node', { node: 'manual-node' }],
    ['different node', { identity: { node_id: 'cp_112233445566', transport: 'usb', security: 'physical-usb', has_saved_credential: false } }],
    ['manual identity', { identity: null }],
    ['AP transport', { identity: { node_id: node, transport: 'ap', security: 'security2', has_saved_credential: false } }],
    ['unknown capability', { identity: { node_id: node, transport: 'usb', security: 'physical-usb' } }],
    ['already saved', { identity: { node_id: node, transport: 'usb', security: 'physical-usb', has_saved_credential: true } }],
    ['insecure USB', { identity: { node_id: node, transport: 'usb', security: 'none', has_saved_credential: false } }],
    ['insecure BLE', { identity: { node_id: node, transport: 'ble', security: 'security1', has_saved_credential: false } }],
  ])('rejects %s before reading or issuing', async (_label, overrides) => {
    const args = setup(overrides);
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: false });
    expect(args.client.request).not.toHaveBeenCalled();
    expect(args.api).not.toHaveBeenCalled();
    expect(args.sensitiveAction).not.toHaveBeenCalled();
  });

  it('rejects a client on a different transport', async () => {
    const args = setup(); args.client.transport = 'ble';
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: false });
    expect(args.api).not.toHaveBeenCalled();
  });

  it.each(['waiting', 'failed'])('issues once from a fresh %s device and returns its token unchanged', async state => {
    const args = setup(), current = { ...args.identity, state };
    args.client.request.mockResolvedValue(current);
    await expect(prepareNetworkCredential(args)).resolves.toEqual({ mode: 'provided', identity: current, credential });
    expect(args.client.request).toHaveBeenCalledTimes(2);
    expect(args.client.request).toHaveBeenNthCalledWith(1, { op: 'info' });
    expect(args.client.request).toHaveBeenNthCalledWith(2, { op: 'info' });
    expect(args.api).toHaveBeenCalledExactlyOnceWith(`/devices/${node}/rotate-credential`, { method: 'POST', body: {} });
    expect(args.sensitiveAction).toHaveBeenCalledTimes(1);
  });

  it('rejects legacy authenticated BLE Security 2 before any device read or credential issue', async () => {
    const args = setup(); args.identity = { ...args.identity, transport: 'ble', security: 'security2' };
    args.client.transport = 'ble'; args.client.request.mockResolvedValue({ ...args.identity });
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: false });
    expect(args.client.request).not.toHaveBeenCalled();
    expect(args.api).not.toHaveBeenCalled();
    expect(args.sensitiveAction).not.toHaveBeenCalled();
  });

  it('reuses a credential saved since the initial identity read', async () => {
    const args = setup(), current = { ...args.identity, has_saved_credential: true };
    args.client.request.mockResolvedValue(current);
    await expect(prepareNetworkCredential(args)).resolves.toEqual({ mode: 'saved', identity: current });
    expect(args.api).not.toHaveBeenCalled(); expect(args.sensitiveAction).not.toHaveBeenCalled();
  });

  it('reuses a credential saved while administrator verification was pending', async () => {
    const args = setup(), current = { ...args.identity, has_saved_credential: true };
    args.client.request.mockResolvedValueOnce({ ...args.identity }).mockResolvedValueOnce(current);
    await expect(prepareNetworkCredential(args)).resolves.toEqual({ mode: 'saved', identity: current });
    expect(args.sensitiveAction).toHaveBeenCalledTimes(1); expect(args.api).not.toHaveBeenCalled();
  });

  it('checks changed device identity again inside the sensitive callback', async () => {
    const args = setup();
    args.client.request.mockResolvedValueOnce({ ...args.identity }).mockResolvedValueOnce({ ...args.identity, node_id: 'cp_112233445566' });
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: false });
    expect(args.api).not.toHaveBeenCalled();
  });

  it('runs the caller cloud preflight after fresh info and before issuing', async () => {
    const args = setup({ beforeIssue: vi.fn().mockRejectedValue(new Error('Cloud configuration changed')) });
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: false });
    expect(args.beforeIssue).toHaveBeenCalledExactlyOnceWith(args.identity);
    expect(args.client.request).toHaveBeenCalledTimes(2); expect(args.api).not.toHaveBeenCalled();
  });

  it('does not require the caller cloud preflight to reuse saved credentials', async () => {
    const args = setup({ beforeIssue: vi.fn().mockRejectedValue(new Error('Should not run')) });
    args.client.request.mockResolvedValue({ ...args.identity, has_saved_credential: true });
    await expect(prepareNetworkCredential(args)).resolves.toMatchObject({ mode: 'saved' });
    expect(args.beforeIssue).not.toHaveBeenCalled(); expect(args.api).not.toHaveBeenCalled();
  });

  it.each([
    { node_id: 'cp_112233445566' }, { transport: 'ble', security: 'security2' },
    { security: 'none' }, { has_saved_credential: undefined }, { has_saved_credential: 0 },
    ...['starting', 'testing', 'saved', 'rebooting', 'stop_failed', undefined].map(state => ({ state })),
  ])('rejects changed fresh identity/readiness %j without issuing', async change => {
    const args = setup(); args.client.request.mockResolvedValue({ ...args.identity, ...change });
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: false });
    expect(args.api).not.toHaveBeenCalled();
  });

  it('keeps an info failure certain and never calls the API', async () => {
    const args = setup(); args.client.request.mockRejectedValue(new Error('USB disconnected'));
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: false });
    expect(args.api).not.toHaveBeenCalled();
  });

  it.each([null, {}, { credential: 'invalid' }, { credential: credential + '\n' }, { credential: credential.toUpperCase() }, { credential: 123 }])('marks malformed successful replies uncertain', async reply => {
    const args = setup(); args.api.mockResolvedValue(reply);
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: true });
    expect(args.api).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('Response lost'), httpError(500)])('marks an unknown POST outcome uncertain with no retry', async error => {
    const args = setup(); args.api.mockRejectedValue(error);
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: true });
    expect(args.api).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 409, 422, 429])('keeps explicit HTTP %s rejection certain', async status => {
    const args = setup(); args.api.mockRejectedValue(httpError(status));
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ status, credentialIssuanceUncertain: false });
    expect(args.api).toHaveBeenCalledTimes(1);
  });

  it('keeps cancelled reauthentication after a rejected POST certain', async () => {
    const args = setup(); args.api.mockRejectedValue(httpError(403, 'reauth_required'));
    args.sensitiveAction = async action => { try { return await action(); } catch { throw new Error('Reauthentication cancelled'); } };
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: false });
    expect(args.api).toHaveBeenCalledTimes(1);
  });

  it('allows the existing wrapper to retry only a known reauth rejection', async () => {
    const args = setup({ sensitiveAction: reauthWrapper });
    args.api.mockRejectedValueOnce(httpError(403, 'reauth_required')).mockResolvedValueOnce({ credential });
    await expect(prepareNetworkCredential(args)).resolves.toMatchObject({ mode: 'provided', credential });
    expect(args.api).toHaveBeenCalledTimes(2);
  });

  it('marks response loss after reauthentication uncertain', async () => {
    const args = setup({ sensitiveAction: reauthWrapper });
    args.api.mockRejectedValueOnce(httpError(403, 'reauth_required')).mockRejectedValueOnce(new Error('Response lost'));
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: true });
    expect(args.api).toHaveBeenCalledTimes(2);
  });

  it('leaves a changed-device preflight after a known reauth rejection certain', async () => {
    const args = setup({ sensitiveAction: reauthWrapper });
    args.client.request.mockResolvedValueOnce({ ...args.identity }).mockResolvedValueOnce({ ...args.identity }).mockResolvedValueOnce({ ...args.identity, state: 'testing' });
    args.api.mockRejectedValueOnce(httpError(403, 'reauth_required'));
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: false });
    expect(args.api).toHaveBeenCalledTimes(1);
  });

  it('rechecks caller cloud state after reauthentication and keeps its rejection certain', async () => {
    const args = setup({ sensitiveAction: reauthWrapper, beforeIssue: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Device disabled')) });
    args.api.mockRejectedValueOnce(httpError(403, 'reauth_required'));
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: false });
    expect(args.beforeIssue).toHaveBeenCalledTimes(2); expect(args.client.request).toHaveBeenCalledTimes(3);
    expect(args.api).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('Response lost'), httpError(409), httpError(500, 'reauth_required'), Object.assign(new Error('Unknown rejection'), { code: 'reauth_required' })])('blocks unsafe wrapper retries', async error => {
    const args = setup({ sensitiveAction: async action => { try { return await action(); } catch { return action(); } } });
    args.api.mockRejectedValue(error);
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: error.status === 409 ? false : true });
    expect(args.api).toHaveBeenCalledTimes(1);
  });

  it('does not send another POST if the wrapper replays a successful action', async () => {
    const args = setup({ sensitiveAction: async action => { await action(); return action(); } });
    await expect(prepareNetworkCredential(args)).rejects.toMatchObject({ credentialIssuanceUncertain: true });
    expect(args.api).toHaveBeenCalledTimes(1);
  });
});

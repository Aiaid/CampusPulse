import { afterEach, beforeEach, expect, it } from 'vitest';
import { authState, Client, json } from './admin-auth-helpers';
import { fixture } from './helpers/ingestion';
import { validateAnyCaptureConfig } from '../worker/device-v2-validation';
import { cloneConfig, publishConfigEdit, rawCaptureUpdate, validateConfigForm } from '../src/admin/config-editing.js';
let state: Awaited<ReturnType<typeof authState>>;
let client: Client;
let initial: any;
let calls: { path: string; method: string }[];
beforeEach(async () => {
  state = await authState(); client = new Client(state); await client.initialize(); calls = [];
  initial = fixture('capture-config-v2.fixture'); initial.capture_config_id = 'initial-v2-policy'; initial.accept_until = new Date(Date.now() + 86400000).toISOString();
  await json(await client.call('/configs', 'POST', { config: initial }), 201);
  await json(await client.call(`/configs/${initial.capture_config_id}/publish`, 'POST', { revision: 1 }));
});
afterEach(() => state.db.close());
async function api(path: string, options: any = {}) {
  calls.push({ path, method: options.method || 'GET' });
  const response = await client.call(path, options.method, options.body); const result: any = await response.json();
  if (!response.ok) { const error = new Error(result.error.message); Object.assign(error, { code: result.error.code }); throw error; }
  return result;
}
function edit() {
  const config = cloneConfig(initial); config.scan.interval_ms = 200;
  config.summary.window_ms = 60000; config.summary.max_addresses = 32;
  return { config: rawCaptureUpdate(config, 'sampled'), raw_retention_hours: 12, aggregate_retention_days: 14 };
}
it('publishes an edited v2 policy without mutating history or claiming application', async () => {
  const body = edit(); const original = structuredClone(initial);
  const credential = state.db.prepare('SELECT credential_sha256 FROM device_nodes WHERE id=?').get(initial.node_id);
  expect(validateAnyCaptureConfig(body.config)).toMatchObject({ protocol: 'campuspulse/2', capture_profile: 'address_metrics', raw_capture: { mode: 'sampled', max_reports_per_window: 4 } });
  expect(await publishConfigEdit(api, body)).toBe(body.config.capture_config_id);
  const detail = await api(`/devices/${initial.node_id}`);
  expect(detail.device).toMatchObject({ desired_config_id: body.config.capture_config_id, applied_config_id: null, config_state: 'pending' });
  expect(detail.configs.find((row: any) => row.id === original.capture_config_id).config).toEqual(original);
  expect(detail.placements).toHaveLength(1);
  expect(state.db.prepare('SELECT credential_sha256 FROM device_nodes WHERE id=?').get(initial.node_id)).toEqual(credential);
  expect(calls.some(call => call.path.includes('rotate'))).toBe(false);
});
it.each(['draft', 'placement', 'publish'])('reconciles a lost %s response without duplicate writes or lost provenance', async stage => {
  const body = edit(); const from = Date.now(); const placement = { id: 'moved-placement', place_id: 'library', valid_from_ms: from, valid_until_ms: null };
  body.config.placement_id = placement.id;
  let dropped = false;
  const flaky = async (path: string, options: any = {}) => {
    const result = await api(path, options);
    if (!dropped && options.method === 'POST' && (stage === 'draft' && path === '/configs' || stage === 'placement' && path.endsWith('/placements') || stage === 'publish' && path.endsWith('/publish'))) { dropped = true; throw new Error('Synthetic response lost after commit'); }
    return result;
  };
  await expect(publishConfigEdit(flaky, body, placement)).rejects.toThrow('Synthetic response lost');
  expect(await publishConfigEdit(flaky, body, placement)).toBe(body.config.capture_config_id);
  expect(calls.filter(call => call.method === 'POST' && call.path === '/configs')).toHaveLength(1);
  expect(calls.filter(call => call.method === 'POST' && call.path.endsWith('/placements'))).toHaveLength(1);
  expect(calls.filter(call => call.method === 'POST' && call.path.endsWith('/publish'))).toHaveLength(1);
  const detail = await api(`/devices/${initial.node_id}`);
  expect(detail.device.config_state).toBe('pending');
  expect(detail.configs.find((row: any) => row.id === initial.capture_config_id).config.placement_id).toBe(initial.placement_id);
  expect(detail.placements.find((row: any) => row.id === initial.placement_id).effective_valid_until_ms).toBe(from);
});
it('keeps a saved draft editable after server validation fails and publishes a correction', async () => {
  const body = edit(); state.env.RAW_BUCKET = undefined;
  await expect(publishConfigEdit(api, body)).rejects.toMatchObject({ code: 'raw_storage_not_configured' });
  body.config = rawCaptureUpdate(body.config, 'off');
  await expect(publishConfigEdit(api, body)).resolves.toBe(body.config.capture_config_id);
  const detail = await api(`/devices/${initial.node_id}`);
  expect(detail.configs.find((row: any) => row.id === body.config.capture_config_id).config.raw_capture.mode).toBe('off');
});
it('rejects inconsistent v2 bins before sending writes and preserves mandatory streams when raw is disabled', () => {
  const config = rawCaptureUpdate(edit().config, 'off');
  expect(config.allowed_streams).toEqual(['ble_windows', 'address_summaries', 'node_status']);
  expect(config.raw_capture).toEqual({ mode: 'off' });
  expect(validateAnyCaptureConfig(config)).toMatchObject({ protocol: 'campuspulse/2' });
  config.summary.bin_ms = 7000;
  expect(() => validateConfigForm(config)).toThrow('分箱');
});
it('uses the Passport raw ceiling by default and preserves an existing smaller sampling budget', () => {
  expect(rawCaptureUpdate(initial, 'sampled').raw_capture.max_reports_per_window).toBe(4);
  const configured = { ...initial, raw_capture: { mode: 'sampled', sample_every_n: 25, selection: 'seq_mod_n_eq_0', max_reports_per_window: 2 } };
  expect(rawCaptureUpdate(configured, 'sampled').raw_capture).toEqual(configured.raw_capture);
});
it('versions a same-place work-purpose change while keeping the firmware policy strict', async () => {
  await api('/places/library', { method: 'PATCH', body: { observation_kinds: ['activity', 'parking', 'elevator'] } });
  const body = edit();
  const original = structuredClone(initial);
  const placement = { id: 'same-place-new-purposes', place_id: 'library', observation_kinds: ['activity', 'elevator'], valid_from_ms: Date.now(), valid_until_ms: null };
  body.config.placement_id = placement.id;
  await publishConfigEdit(api, body, placement);
  const detail = await api(`/devices/${initial.node_id}`);
  expect(detail.placements.find((p: any) => p.id === placement.id)).toMatchObject({ observation_kinds: ['activity', 'elevator'] });
  expect(detail.configs.find((row: any) => row.id === initial.capture_config_id).config).toEqual(original);
  expect(detail.device).toMatchObject({ desired_config_id: body.config.capture_config_id, applied_config_id: null, config_state: 'pending' });
  expect(body.config).not.toHaveProperty('observation_kinds');
  expect(validateAnyCaptureConfig(body.config)).toEqual(body.config);
  const before = calls.length;
  await expect(publishConfigEdit(api, body, { ...placement, observation_kinds: ['parking'] })).rejects.toThrow('工作用途');
  expect(calls.slice(before).every(call => call.method === 'GET')).toBe(true);
});
it.each(['draft', 'placement', 'publish'])('retains multi-purpose metadata across a lost %s response', async stage => {
  await api('/places/library', { method: 'PATCH', body: { observation_kinds: ['activity', 'parking'] } });
  const body = edit(); const placement = { id: `purposes-lost-${stage}`, place_id: 'library', observation_kinds: ['activity', 'parking'], valid_from_ms: Date.now(), valid_until_ms: null };
  body.config.placement_id = placement.id;
  let dropped = false;
  const flaky = async (path: string, options: any = {}) => {
    const result = await api(path, options);
    if (!dropped && options.method === 'POST' && (stage === 'draft' && path === '/configs' || stage === 'placement' && path.endsWith('/placements') || stage === 'publish' && path.endsWith('/publish'))) { dropped = true; throw new Error('Purpose response lost'); }
    return result;
  };
  await expect(publishConfigEdit(flaky, body, placement)).rejects.toThrow('Purpose response lost');
  await publishConfigEdit(flaky, body, { ...placement, observation_kinds: ['parking', 'activity'] });
  const detail = await api(`/devices/${initial.node_id}`);
  expect(detail.placements.filter((p: any) => p.id === placement.id)).toHaveLength(1);
  expect([...detail.placements.find((p: any) => p.id === placement.id).observation_kinds].sort()).toEqual(['activity', 'parking']);
  expect(detail.device.config_state).toBe('pending');
});

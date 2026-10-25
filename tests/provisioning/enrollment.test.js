import { describe, it, expect, vi } from 'vitest';
import { validateAnyCaptureConfig } from '../../worker/device-v2-validation.ts';
import { cloudProgress, provisionConfig, assignProvisionConfig, saveProvisionSettings } from '../../src/admin/provisioning/enrollment.js';
describe('enrollment state boundaries',()=>{
  it('publishes supported v2 defaults with explicit dataset',()=>{const c=provisionConfig('cp_001122aabbcc','p','c');expect(validateAnyCaptureConfig(c)).toEqual(c);expect(c.protocol).toBe('campuspulse/2');expect(c.dataset).toBe('controlled_test');expect(c.summary).toEqual({window_ms:30000,bin_ms:5000,max_addresses:64});expect(c.upload_policy.max_body_bytes).toBe(8192);});
  it('requires fresh contact and the same applied config, not registration alone',()=>{
    const d={device:{desired_config_id:'c',applied_config_id:'c',config_state:'applied',last_seen_at:'2026-10-24T00:00:00Z'}};
    expect(cloudProgress(d,'c',Date.parse('2026-10-24T01:00:00Z')).applied).toBe(false);
    d.device.latest_control={received_at:'2026-10-24T02:00:00Z'};d.activation={current:{state:'applied',capture_config_id:'c',received_at:'2026-10-24T02:00:00Z'}};expect(cloudProgress(d,'c',Date.parse('2026-10-24T01:00:00Z')).applied).toBe(true);
  });
  it('reconciles already-published assignment with no writes',async()=>{const calls=[];const id=await assignProvisionConfig(async(path,opts)=>{calls.push([path,opts]);return{device:{desired_config_id:'cp_001122aabbcc-c-1111111122224333'}}},'cp_001122aabbcc','11111111-2222-4333-8444-555555555555','p','field');expect(id).toBe('cp_001122aabbcc-c-1111111122224333');expect(calls).toHaveLength(1);expect(calls[0][1]).toBeUndefined();});
});

function settingsApi(initial = null) {
  const node = 'cp_001122aabbcc', writes = [], drafts = [], configs = initial ? [structuredClone(initial)] : [];
  const device = { id: node, desired_config_id: initial?.id ?? null };
  const placements = initial ? [{ id: initial.config.placement_id, place_id: 'library', valid_from_ms: Date.now() - 1000, valid_until_ms: null }] : [];
  const state = { node, writes, drafts, configs, device, placements, lose: '' };
  state.api = async (path, options) => {
    if (!options) {
      if (path === `/devices/${node}`) return structuredClone({ device, placements, configs });
      if (path === `/configs?node_id=${node}`) return structuredClone({ drafts, configs });
      throw new Error(`Unexpected read ${path}`);
    }
    writes.push([path, structuredClone(options)]);
    const body = structuredClone(options.body);
    let result, phase;
    if (path === `/devices/${node}/placements`) {
      if (placements.some(p => p.id === body.id)) throw new Error('Duplicate placement');
      for (const p of placements) if (p.valid_until_ms === null && p.valid_from_ms < body.valid_from_ms) p.effective_valid_until_ms = body.valid_from_ms;
      placements.push(body); result = { placement: body }; phase = 'placement';
    } else if (path === '/configs') {
      if (state.rejectDraft) { state.rejectDraft = false; throw new Error('Request interrupted'); }
      if (drafts.some(c => c.id === body.config.capture_config_id) || configs.some(c => c.id === body.config.capture_config_id)) throw new Error('Duplicate config');
      // The real API validates and normalizes field ordering before storing.
      const draft = { ...body, config: validateAnyCaptureConfig(body.config), id: body.config.capture_config_id, revision: 1 };
      drafts.push(draft); result = { draft }; phase = 'draft';
    } else {
      const [, id, action] = /^\/configs\/([^/]+)\/(validate|publish)$/.exec(path) || [];
      const draft = drafts.find(c => c.id === id);
      if (!draft || draft.revision !== body.revision) throw new Error('Missing draft or wrong revision');
      if (action === 'publish') { configs.push(draft); drafts.splice(drafts.indexOf(draft), 1); device.desired_config_id = id; result = { config: draft }; phase = 'publish'; }
      else { result = { valid: true }; phase = 'validate'; }
    }
    if (state.lose === phase) { state.lose = ''; throw new Error('Response lost'); }
    return structuredClone(result);
  };
  return state;
}

describe('saving editable provisioning settings', () => {
  it('creates immutable same-place purpose changes without altering BLE capture parameters', async () => {
    const config = provisionConfig('cp_001122aabbcc', 'existing-placement', 'existing', 'field');
    config.summary.max_addresses = 18;
    const state = settingsApi({ id: 'existing', config, raw_retention_hours: 48, aggregate_retention_days: 90 });
    state.placements[0].observation_kinds = ['activity'];
    const id = await saveProvisionSettings(state.api, state.node, 'purposes', 'library', 'field', ['activity', 'parking']);
    expect(state.placements).toHaveLength(2);
    expect(state.placements[0].observation_kinds).toEqual(['activity']);
    expect(state.placements[1]).toMatchObject({ place_id: 'library', observation_kinds: ['activity', 'parking'] });
    expect(state.configs[1].config).toEqual({ ...config, capture_config_id: id, placement_id: `${state.node}-p-purposes` });
    expect(state.configs[1].config).not.toHaveProperty('observation_kinds');
  });
  it('reconciles lost placement purpose writes and rejects conflicting retry metadata', async () => {
    const state = settingsApi(); state.lose = 'placement';
    await expect(saveProvisionSettings(state.api, state.node, 'purposeretry', 'library', 'field', ['parking', 'activity'])).rejects.toThrow('Response lost');
    await expect(saveProvisionSettings(state.api, state.node, 'purposeretry', 'library', 'field', ['activity', 'elevator'])).rejects.toThrow('内容已变化');
    const id = await saveProvisionSettings(state.api, state.node, 'purposeretry', 'library', 'field', ['activity', 'parking']);
    expect(state.device.desired_config_id).toBe(id);
    expect(state.placements).toHaveLength(1);
    const before = state.writes.length;
    await expect(saveProvisionSettings((...args) => state.api(...args), state.node, 'purposeretry', 'library', 'field', ['activity'])).rejects.toThrow('不同内容');
    expect(state.writes).toHaveLength(before);
  });
  it('makes a second save current while preserving the first immutable config', async () => {
    const state = settingsApi();
    const first = await saveProvisionSettings(state.api, state.node, 'save1', 'library', 'controlled_test');
    const original = structuredClone(state.configs[0]);
    const second = await saveProvisionSettings(state.api, state.node, 'save2', 'parking', 'field');
    expect(second).not.toBe(first);
    expect(state.device.desired_config_id).toBe(second);
    expect(state.configs[0]).toEqual(original);
    expect(state.configs[1].config).toMatchObject({ dataset: 'field', placement_id: `${state.node}-p-save2` });
    expect(state.placements).toHaveLength(2);
  });

  it('returns the current valid settings without any mutation', async () => {
    const initial = { id: 'existing', config: provisionConfig('cp_001122aabbcc', 'existing-placement', 'existing', 'field'), raw_retention_hours: 48, aggregate_retention_days: 90 };
    const state = settingsApi(initial);
    expect(await saveProvisionSettings(state.api, state.node, 'noop', 'library', 'field')).toBe('existing');
    expect(state.writes).toEqual([]);
    await expect(saveProvisionSettings(state.api, state.node, 'noop', 'parking', 'field')).rejects.toThrow('内容已变化');
    expect(state.writes).toEqual([]);
  });

  it('clones custom capture and retention policy, reusing an unchanged placement', async () => {
    const config = provisionConfig('cp_001122aabbcc', 'existing-placement', 'existing', 'controlled_test');
    config.scan.interval_ms = 200; config.scan.window_ms = 100;
    config.raw_capture = { mode: 'sampled', sample_every_n: 7, selection: 'seq_mod_n_eq_0', max_reports_per_window: 5 };
    config.allowed_streams.push('ble_reports'); config.summary = { window_ms: 60000, bin_ms: 10000, max_addresses: 32 };
    config.control.lease_ms = 300000; config.upload_policy.flush_max_age_ms = 9000;
    const initial = { id: 'existing', config, raw_retention_hours: 72, aggregate_retention_days: 120 };
    const state = settingsApi(initial);
    const id = await saveProvisionSettings(state.api, state.node, 'custom', 'library', 'field');
    expect(state.configs[1]).toMatchObject({ raw_retention_hours: 72, aggregate_retention_days: 120 });
    expect(state.configs[1].config).toEqual({ ...config, capture_config_id: id, dataset: 'field' });
    expect(state.configs[0]).toEqual(initial);
    expect(state.writes.some(([path]) => path.endsWith('/placements'))).toBe(false);
  });

  it('renews an expired policy without resetting its capture or retention settings', async () => {
    const config = provisionConfig('cp_001122aabbcc', 'existing-placement', 'expired', 'field', Date.now() - 8 * 86400000);
    config.summary.max_addresses = 12;
    const state = settingsApi({ id: 'expired', config, raw_retention_hours: 96, aggregate_retention_days: 75 });
    await saveProvisionSettings(state.api, state.node, 'renew', 'library', 'field');
    expect(state.configs[1].config.summary).toEqual(config.summary);
    expect(Date.parse(state.configs[1].config.accept_until)).toBeGreaterThan(Date.now());
    expect(state.configs[1]).toMatchObject({ raw_retention_hours: 96, aggregate_retention_days: 75 });
    expect(state.placements).toHaveLength(1);
  });

  it('retries an interrupted write with the exact frozen request body', async () => {
    const state = settingsApi(); state.rejectDraft = true;
    const originalNow = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(originalNow);
    try {
      await expect(saveProvisionSettings(state.api, state.node, 'interrupted', 'library', 'field')).rejects.toThrow('Request interrupted');
      clock.mockReturnValue(originalNow + 60000);
      await saveProvisionSettings(state.api, state.node, 'interrupted', 'library', 'field');
      const requests = state.writes.filter(([path]) => path === '/configs');
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[0][1].body.config.accept_until).toBe(new Date(originalNow + 7 * 86400000).toISOString());
    } finally { clock.mockRestore(); }
  });

  it('does not republish an uncertain draft over an intervening assignment', async () => {
    const state = settingsApi(); state.lose = 'draft';
    await expect(saveProvisionSettings(state.api, state.node, 'changedelsewhere', 'library', 'field')).rejects.toThrow('Response lost');
    const other = structuredClone(state.drafts[0]);
    other.id = other.config.capture_config_id = 'other-current-config';
    state.configs.push(other); state.device.desired_config_id = other.id;
    const before = state.writes.length;
    await expect(saveProvisionSettings(state.api, state.node, 'changedelsewhere', 'library', 'field')).rejects.toThrow('配置已变化');
    expect(state.writes).toHaveLength(before);
    expect(state.device.desired_config_id).toBe(other.id);
  });

  for (const phase of ['placement', 'draft', 'validate', 'publish']) it(`reconciles a lost ${phase} response with fixed IDs and payload`, async () => {
    const state = settingsApi(); state.lose = phase;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      await expect(saveProvisionSettings(state.api, state.node, 'retry', 'library', 'field')).rejects.toThrow('Response lost');
      clock.mockReturnValue(Date.now() + 60000);
      const id = await saveProvisionSettings(state.api, state.node, 'retry', 'library', 'field');
      expect(state.device.desired_config_id).toBe(id);
      expect(state.placements).toHaveLength(1); expect(state.configs).toHaveLength(1); expect(state.drafts).toHaveLength(0);
      expect(state.writes.filter(([path]) => path.endsWith('/placements'))).toHaveLength(1);
      expect(state.writes.filter(([path]) => path === '/configs')).toHaveLength(1);
      const submitted = state.writes.find(([path]) => path === '/configs')[1].body;
      expect(state.configs[0].config).toEqual(submitted.config);
      const before = state.writes.length;
      // Even a new API wrapper (such as after reopening the page) must verify
      // the already-published operation against its actual requested values.
      await expect(saveProvisionSettings((...args) => state.api(...args), state.node, 'retry', 'parking', 'field')).rejects.toThrow('不同内容');
      expect(state.writes).toHaveLength(before);
    } finally { clock.mockRestore(); }
  });
});

describe('reconfiguration keeps cloud identity and assignment', () => {
  it('recognizes existing nodes and only an explicit unknown-device response permits registration', async () => {
    const { inspectEnrollment } = await import('../../src/admin/provisioning/enrollment.js');
    const node = 'cp_001122aabbcc';
    expect((await inspectEnrollment(async () => ({ device: { id: node } }), node)).kind).toBe('existing');
    expect((await inspectEnrollment(async () => { throw Object.assign(new Error(), { status: 404, code: 'device_not_found' }); }, node)).kind).toBe('new');
    for (const error of [new Error('offline'), Object.assign(new Error(), { status: 401 }), Object.assign(new Error(), { status: 404, code: 'not_found' }), Object.assign(new Error(), { status: 500 })]) {
      await expect(inspectEnrollment(async () => { throw error; }, node)).rejects.toBe(error);
    }
    await expect(inspectEnrollment(async () => ({ device: { id: 'cp_ffffffffffff' } }), node)).rejects.toThrow('不同');
  });
  it('preserves only a current published v2 policy with an active placement', async () => {
    const { currentProvisionConfig } = await import('../../src/admin/provisioning/enrollment.js');
    const now = Date.now(), config = provisionConfig('cp_001122aabbcc', 'p', 'c', 'field', now);
    const detail = { device: { id: config.node_id, desired_config_id: 'c' }, configs: [{ id: 'c', config }], placements: [{ id: 'p', valid_from_ms: now - 1000, effective_valid_until_ms: null }] };
    expect(currentProvisionConfig(detail, now)?.id).toBe('c');
    expect(currentProvisionConfig({ ...detail, configs: [] }, now)).toBeNull();
    expect(currentProvisionConfig({ ...detail, placements: [{ ...detail.placements[0], effective_valid_until_ms: now - 1 }] }, now)).toBeNull();
    expect(currentProvisionConfig(detail, now + 8 * 86400000)).toBeNull();
  });
  it('never treats an old applied ACK plus a fresh heartbeat as a new Wi-Fi success', () => {
    const now = Date.now(), detail = { device: { desired_config_id: 'c', applied_config_id: 'c', config_state: 'applied', latest_control: { received_at: new Date(now + 100).toISOString(), boot_id: 'new' } }, activation: { current: { capture_config_id: 'c', state: 'applied', received_at: new Date(now - 1).toISOString(), boot_id: 'old' } } };
    expect(cloudProgress(detail, 'c', now)).toMatchObject({ contact: true, applied: false });
    detail.activation.current.received_at = new Date(now + 100).toISOString(); expect(cloudProgress(detail, 'c', now).applied).toBe(false);
    detail.activation.current.boot_id = 'new'; expect(cloudProgress(detail, 'c', now).applied).toBe(true);
  });
});

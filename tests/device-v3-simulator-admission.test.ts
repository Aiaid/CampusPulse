import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateDeviceConfigV3, type DeviceConfigV3 } from '../worker/device-v3-config';
import { assertV3StatisticsPolicy, type DeviceV3StatisticsEnv } from '../worker/device-v3-statistics-policy';
import { setup } from './helpers/ingestion';
import { statisticsCapabilities, statisticsPolicy } from './helpers/v3-statistics-policy-fixtures';
import { createSimulatedV3Device, createSimulationPolicy } from '../scripts/lib/v3-simulated-device.mjs';
import { V3_VEHICLE_CANDIDATE_RULESET } from '../worker/device-v3-statistics-validation';

const NODE = 'sim-live-admission-fixture';
const PRODUCER = 'synthetic-statistics/1';
let state: Awaited<ReturnType<typeof setup>>;
let env: DeviceV3StatisticsEnv;
let policy: DeviceConfigV3;
beforeAll(async () => {
  state = await setup();
  env = { ...state.env, DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true',
    DEVICE_V3_PRODUCER_VERSIONS: '["cp-v3-small/1"]', DEVICE_V3_SIMULATOR_NODE_IDS: JSON.stringify([NODE]),
    DEVICE_V3_INGEST_ENABLED: 'false', CPRAW_ARCHIVE_ENABLED: '0' };
  policy = await statisticsPolicy(statisticsCapabilities(NODE));
  policy.custody.dataset = 'field'; policy.custody.purpose = 'site_observation';
  if (!policy.uplink.enabled) throw Error('fixture');
  policy.uplink.transport = 'mqtt_tls';
  policy = validateDeviceConfigV3(policy);
});
afterAll(() => state.db.close());

describe('named production virtual-device statistics admission', () => {
  it('admits the actual online simulator policy with temporal tracking disabled', async () => {
    const onlineConfiguration = { origin: 'https://pulse.anend.net', operator_confirmed_production_simulation: true,
      nodeId: NODE, placementId: 'sim-live-admission-placement', dataset: 'field', purpose: 'site_observation' };
    const device = await createSimulatedV3Device({ nodeId: NODE, deviceBearer: 'synthetic-unused-admission-fixture',
      transport: 'mqtt_tls', onlineConfiguration, request: async () => { throw Error('Admission test must not use the network'); } });
    const actualPolicy = validateDeviceConfigV3(await createSimulationPolicy(device.capabilities, {
      placementId: onlineConfiguration.placementId, cadenceMs: 30000, transport: 'mqtt_tls', onlineConfiguration }));
    expect(actualPolicy.temporal).toEqual({ mode: 'off' });
    expect(device.capabilities.producer_version).toBe(PRODUCER);
    expect(() => assertV3StatisticsPolicy(actualPolicy, env, device.capabilities.producer_version)).not.toThrow();
  });
  it('admits the exact named synthetic node while retaining its producer identity', () => {
    expect(() => assertV3StatisticsPolicy(policy, env, PRODUCER)).not.toThrow();
    expect(JSON.parse(env.DEVICE_V3_PRODUCER_VERSIONS!)).toEqual(['cp-v3-small/1']);
    expect(() => assertV3StatisticsPolicy(policy, env, 'synthetic-statistics/2')).toThrow();
    expect(() => assertV3StatisticsPolicy({ ...policy, node_id: `${NODE}-other` }, env, PRODUCER)).toThrow();
    expect(() => assertV3StatisticsPolicy({ ...policy, node_id: 'physical-fixture' }, env, PRODUCER)).toThrow();
  });
  it('admits the reviewed vehicle ruleset only through the same exact simulator scope', () => {
    const vehicles = structuredClone(policy);
    if (vehicles.evidence.mode !== 'statistics') throw Error('fixture');
    vehicles.evidence.ruleset_version = V3_VEHICLE_CANDIDATE_RULESET;
    expect(() => assertV3StatisticsPolicy(vehicles, env, PRODUCER)).not.toThrow();
    expect(() => assertV3StatisticsPolicy({ ...vehicles, node_id: 'other-synthetic' }, env, PRODUCER)).toThrow();
    if (vehicles.uplink.enabled) vehicles.uplink.transport = 'https';
    expect(() => assertV3StatisticsPolicy(vehicles, env, PRODUCER)).toThrow();
  });
  it.each([undefined, '', 'broken', 'null', '{}', '"sim-live-admission-fixture"', '[]', '[42]',
    JSON.stringify([NODE, NODE]), JSON.stringify([`${NODE}-other`]), JSON.stringify([NODE, 'physical-fixture']),
    '["sim-live-*"]', '["sim-live-"]', '["sim-live-UPPER"]', JSON.stringify([`sim-live-${'x'.repeat(56)}`]),
    JSON.stringify([NODE, ...Array.from({ length: 16 }, (_, i) => `sim-live-fixture-${i}`)])])(
    'fails closed for absent, malformed, broad, duplicate or mismatched node lists: %s', value => {
      expect(() => assertV3StatisticsPolicy(policy, { ...env, DEVICE_V3_SIMULATOR_NODE_IDS: value }, PRODUCER)).toThrow();
    });
  it.each([undefined, '', 'broken', '[]', 'null', '["cp-v3-small/1","cp-v3-small/1"]', '[42]'])(
    'does not bypass malformed global producer configuration: %s', value => {
      expect(() => assertV3StatisticsPolicy(policy, { ...env, DEVICE_V3_PRODUCER_VERSIONS: value }, PRODUCER)).toThrow();
    });
  it.each<[string, (p: DeviceConfigV3) => void]>([
    ['controlled dataset', p => { p.custody.dataset = 'controlled_test'; }],
    ['demonstration purpose', p => { p.custody.purpose = 'demonstration'; }],
    ['missing placement', p => { p.custody.placement_id = null; }],
    ['segment association', p => { p.custody.association_scope = 'segment'; }],
    ['mobile collection', p => { p.collection.mode = 'mobile_research'; }],
    ['local raw', p => { p.local_raw = { mode: 'tf_cpraw', format: 'cpraw/1', max_segment_bytes: 1048576,
      max_total_bytes: 16777216, min_free_bytes: 1048576, sync_interval_ms: 1000, full_behavior: 'stop_recording' }; }],
    ['other ruleset', p => { if (p.evidence.mode === 'statistics') p.evidence.ruleset_version = 'vehicle-candidate-v1'; }],
    ['other extractor', p => { if (p.evidence.mode === 'statistics') p.evidence.extractor_version = 'other/1'; }],
    ['candidate event reports', p => { if (p.temporal?.mode === 'rolling') p.temporal.report_mode = 'terminal_only'; }],
    ['HTTPS', p => { if (p.uplink.enabled) p.uplink.transport = 'https'; }],
    ['candidate event stream', p => { if (p.uplink.enabled) p.uplink.streams.push('candidate_events'); }],
    ['raw stream', p => { if (p.uplink.enabled) p.uplink.streams.push('ble_reports'); }],
    ['missing status stream', p => { if (p.uplink.enabled) p.uplink.streams = ['window_statistics']; }],
    ['duplicate streams', p => { if (p.uplink.enabled) p.uplink.streams.push('node_status'); }],
    ['raw sampling', p => { if (p.uplink.enabled) p.uplink.raw_sample = { mode: 'sampled', format: 'legacy_ad', every_n: 1,
      max_reports_per_window: 1, selection: 'seq_mod_n_eq_0' }; }],
    ['raw archive', p => { if (p.uplink.enabled) p.uplink.archive = { mode: 'separate_policy', policy_id: 'fixture' }; }],
  ])('rejects a synthetic policy with %s', (_name, change) => {
    const changed = structuredClone(policy); change(changed);
    expect(() => assertV3StatisticsPolicy(changed, env, PRODUCER)).toThrow();
  });
  it.each<Partial<DeviceV3StatisticsEnv>>([
    { DEVICE_V3_CONTROL_ENABLED: 'false' }, { DEVICE_V3_STATISTICS_ENABLED: 'false' },
    { DEVICE_V3_INGEST_ENABLED: 'true' }, { DEVICE_V3_INGEST_ENABLED: undefined },
    { CPRAW_ARCHIVE_ENABLED: '1' }, { CPRAW_ARCHIVE_ENABLED: undefined },
  ])('retains release shutdown and raw gates: %j', change => {
    expect(() => assertV3StatisticsPolicy(policy, { ...env, ...change }, PRODUCER)).toThrow();
  });
  it('leaves explicitly reviewed ordinary producers and local test producer opt-in unchanged', () => {
    const ordinary = structuredClone(policy); ordinary.node_id = 'physical-fixture';
    ordinary.custody.dataset = 'controlled_test'; ordinary.custody.purpose = 'controlled_test';
    if (ordinary.uplink.enabled) ordinary.uplink.transport = 'https';
    expect(() => assertV3StatisticsPolicy(ordinary, { ...env, DEVICE_V3_SIMULATOR_NODE_IDS: 'malformed' }, 'cp-v3-small/1')).not.toThrow();
    expect(() => assertV3StatisticsPolicy(ordinary, env, 'unreviewed/1')).toThrow();
    // Existing offline test environments deliberately opt into synthetic globally.
    // The deployment generator independently forbids that release expansion.
    expect(() => assertV3StatisticsPolicy(ordinary, { ...env, DEVICE_V3_PRODUCER_VERSIONS: JSON.stringify([PRODUCER]) }, PRODUCER)).not.toThrow();
  });
});

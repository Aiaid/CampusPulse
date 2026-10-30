import { describe, expect, it } from 'vitest';
import { capabilityDigestV3, evaluateDeviceV3Lease, freezeDeviceConfigV3, negotiateDeviceConfigV3,
  parseDeviceV3Json, validateDeviceCapabilitiesV3, validateDeviceConfigV3, validateFrozenDeviceConfigV3,
  type DeviceCapabilitiesV3, type DeviceConfigV3, type V3NegotiationContext } from '../worker/device-v3-config';

// Deliberately synthetic claims, not measured board/Flash/TF capacity or firmware support.
const BOOT = '11111111-1111-4111-8111-111111111111';
const context = (): V3NegotiationContext => ({ node_id: 'synthetic-node', boot_id: BOOT,
  now: '2026-10-30T10:01:00.000Z', last_assignment_generation: 1,
  closed_window_seq: 3, closed_segment_seq: 0, window_open: false, segment_open: false });
function capabilities(): DeviceCapabilitiesV3 {
  return { schema: 'device-capabilities/1', capability_id: 'synthetic-capability', node_id: 'synthetic-node', boot_id: BOOT,
    producer_version: 'synthetic-v3', policy_schemas: ['device-config/3'], issued_at: '2026-10-30T10:00:00.000Z', expires_at: '2026-10-31T00:00:00.000Z',
    scanner: { modes: ['passive'], phys: ['1m'], duplicate_filter: [false, true], min_interval_units: 4, max_interval_units: 16384 },
    summary: { max_addresses: 512, max_bins: 60, max_window_ms: 300000 }, features: null, local_raw: null,
    uplink: { transports: ['https'], streams: ['ble_windows', 'address_summaries', 'node_status'], max_batch_items: 16,
      max_body_bytes: 4096, max_sample_reports_per_window: 0, cpraw_archive: false },
    queue: { media: [{ medium: 'flash_journal', usable_bytes: 262144, max_items: 256, power_loss_recovery: true }] },
    resources: { max_working_bytes: 1048576, max_storage_write_bytes_per_day: 104857600, tf_usable_bytes: null } };
}
async function policy(caps = capabilities()): Promise<DeviceConfigV3> {
  return { schema: 'device-config/3', protocol: 'campuspulse/3', policy_id: 'synthetic-v3-policy', node_id: 'synthetic-node', revision: 1, assignment_generation: 2,
    collection: { enabled: true, mode: 'fixed_point', scan: { mode: 'passive', interval_units: 160, window_units: 160, duplicate_filter: false, phys: ['1m'] },
      summary: { enabled: true, window_ms: 60000, bin_ms: 20000, max_addresses: 512 } },
    local_raw: { mode: 'off' }, evidence: { mode: 'off' },
    uplink: { enabled: true, transport: 'https', streams: ['ble_windows', 'address_summaries', 'node_status'],
      max_batch_items: 16, max_body_bytes: 4096, retry: { min_delay_ms: 1000, max_delay_ms: 60000, max_attempts: 10 },
      raw_sample: { mode: 'off' }, archive: { mode: 'off' } },
    local_queue: { mode: 'durable', medium: 'flash_journal', max_bytes: 131072, max_items: 128, control_reserve_bytes: 4096, control_reserve_items: 2,
      stream_reserves: ['ble_windows', 'address_summaries', 'node_status'].map(stream => ({ stream: stream as 'ble_windows' | 'address_summaries' | 'node_status', bytes: 8192, items: 8 })),
      high_water_percent: 80, full_behavior: 'pause_collection', recovery: 'exact_frozen_batches' },
    resources: { working_bytes: 524288, storage_write_bytes_per_day: 10485760 },
    custody: { dataset: 'field', purpose: 'site_observation', placement_id: 'synthetic-place', association_scope: 'window',
      source_retention_hours: 24, derived_retention_hours: 24, accept_until: '2026-11-01T00:00:00.000Z', max_upload_bytes_per_day: 10485760 },
    control: { capability_sha256: await capabilityDigestV3(caps), activation: { boot_id: BOOT, boundary: 'closed_window_and_segment', after_window_seq: 3, after_segment_seq: 0,
      not_before: '2026-10-30T10:00:00.000Z', expires_at: '2026-10-30T20:00:00.000Z' },
      lease: { duration_ms: 120000, on_collection_expiry: 'pause', on_raw_expiry: 'stop_recording', on_uplink_expiry: 'drain_frozen_until_accept_until' } } };
}
const rawPolicy = (): DeviceConfigV3['local_raw'] => ({ mode: 'tf_cpraw', format: 'cpraw/1', max_segment_bytes: 1048576,
  max_total_bytes: 16777216, min_free_bytes: 1048576, sync_interval_ms: 1000, full_behavior: 'stop_recording' });
async function offlineFixture() {
  const caps = capabilities();
  delete caps.summary; delete caps.uplink; delete caps.queue;
  caps.local_raw = { formats: ['cpraw/1'], max_segment_bytes: 1048576, min_sync_interval_ms: 500 };
  caps.resources!.tf_usable_bytes = 33554432;
  const p = await policy(caps);
  p.collection.mode = 'mobile_research'; p.collection.summary = { enabled: false };
  p.local_raw = rawPolicy(); p.uplink = { enabled: false }; p.local_queue = { mode: 'disabled' };
  p.custody = { ...p.custody, dataset: 'research_unassigned', purpose: 'research', placement_id: null,
    association_scope: 'segment', max_upload_bytes_per_day: 0 };
  p.control.lease.on_collection_expiry = 'continue_until_policy_expiry';
  p.control.lease.on_raw_expiry = 'continue_until_policy_expiry';
  return { caps, p };
}
async function negotiate(p: DeviceConfigV3, caps = capabilities(), ctx = context()) {
  return negotiateDeviceConfigV3(await freezeDeviceConfigV3(p), caps, ctx);
}
async function featureFixture() {
  const caps = capabilities();
  caps.features = { schemas: ['ble-feature-evidence/1'], extractor_versions: ['synthetic-extractor/1'], fields: ['company_ids', 'appearance'],
    populations: ['all_worker_reports', 'deterministic_sample'], max_reports_per_window: 50000, max_bytes_per_window: 65536 };
  const p = await policy(caps);
  p.evidence = { mode: 'features', schema: 'ble-feature-evidence/1', extractor_version: 'synthetic-extractor/1', population: 'all_worker_reports',
    sample_every_n: null, fields: [{ kind: 'company_ids', max_values_per_identifier: 16 }, { kind: 'appearance', max_values_per_identifier: 8 }],
    max_reports_per_window: 50000, max_bytes_per_window: 65536, overflow: 'count_and_mark_partial' };
  return { caps, p };
}

describe('strict v3 policy and capability core', () => {
  it('admits a headless no-TF profile without implying an applied policy', async () => {
    const p = await policy();
    expect(validateDeviceConfigV3(p)).toEqual(p);
    expect(await negotiate(p)).toMatchObject({ state: 'compatible', applied: false, requires_device_ack: true, issues: [] });
    expect(p).not.toHaveProperty('display');
  });

  it('admits offline TF raw without summary, feature, network or queue capabilities', async () => {
    const { p, caps } = await offlineFixture();
    expect(await negotiate(p, caps)).toMatchObject({ state: 'compatible', applied: false });
    expect(evaluateDeviceV3Lease(p, context().now, 120000)).toEqual({ collection: 'permitted', local_raw: 'permitted', uplink: 'paused', preserve_unacknowledged: true });
  });

  it('keeps features independent from raw sampling, TF and feature upload', async () => {
    const { p, caps } = await featureFixture();
    expect(await negotiate(p, caps)).toMatchObject({ state: 'compatible' });
    expect(p.uplink.enabled && p.uplink.streams).not.toContain('feature_summaries');
    expect(p.local_raw).toEqual({ mode: 'off' });
    expect(p.uplink.enabled && p.uplink.raw_sample).toEqual({ mode: 'off' });
  });

  it.each(['collection', 'local_raw', 'evidence', 'uplink', 'local_queue', 'resources', 'custody', 'control'] as const)('rejects unknown fields in %s without echoing private values', async key => {
    const p = await policy();
    Object.assign(p[key], { secret_name: 'PRIVATE_VALUE_DO_NOT_ECHO' });
    expect(() => validateDeviceConfigV3(p)).toThrow(/Invalid v3 field/);
    try { validateDeviceConfigV3(p); } catch (e) { expect(String(e)).not.toContain('PRIVATE_VALUE_DO_NOT_ECHO'); }
  });

  it('rejects extra top-level fields, absent requirements, wrong versions and invalid timestamps', async () => {
    const base = await policy();
    for (const patch of [{ extra: true }, { protocol: 'campuspulse/2' }, { schema: 'device-config/4' }, { revision: null }, { assignment_generation: Infinity }]) {
      expect(() => validateDeviceConfigV3({ ...base, ...patch })).toThrow();
    }
    const { resources: _, ...missing } = base;
    expect(() => validateDeviceConfigV3(missing)).toThrow();
    base.control.activation.not_before = '2026-02-30T00:00:00.000Z';
    expect(() => validateDeviceConfigV3(base)).toThrow();
    expect(() => validateDeviceCapabilitiesV3({ ...capabilities(), unknown_extension: true })).toThrow();
    expect(() => validateDeviceCapabilitiesV3({ ...capabilities(), schema: 'device-capabilities/2' })).toThrow();
  });

  it('rejects duplicate decoded JSON keys, malformed UTF-8, deep nesting and oversized input', async () => {
    const encode = (s: string) => new TextEncoder().encode(s);
    expect(() => parseDeviceV3Json(encode('{"schema":1,"schem\\u0061":2}'))).toThrow();
    expect(() => parseDeviceV3Json(new Uint8Array([0xff]))).toThrow();
    expect(() => parseDeviceV3Json(encode('['.repeat(1000) + ']'.repeat(1000)))).toThrow();
    expect(() => parseDeviceV3Json(new Uint8Array(32769))).toThrow();
    const p = await policy();
    expect(validateDeviceConfigV3(parseDeviceV3Json(encode(JSON.stringify(p))))).toEqual(p);
  });

  it('preserves undeclared versus explicitly unsupported capabilities and rejects both when needed', async () => {
    for (const value of [undefined, null]) {
      const caps = capabilities();
      if (value === undefined) delete caps.queue; else caps.queue = value;
      const normalized = validateDeviceCapabilitiesV3(caps);
      expect(Object.hasOwn(normalized, 'queue')).toBe(value !== undefined);
      const result = await negotiate(await policy(caps), caps);
      expect(result.state).toBe('rejected');
      expect(result.issues).toContainEqual({ code: value === undefined ? 'undeclared_capability' : 'unsupported_capability', path: 'capabilities.queue' });
    }
  });

  it('does not infer TF support from any producer or capability name', async () => {
    const caps = capabilities(); caps.producer_version = 'waveshare-v2-with-tf';
    const p = await policy(caps); p.local_raw = rawPolicy();
    expect((await negotiate(p, caps)).issues).toContainEqual({ code: 'unsupported_capability', path: 'capabilities.local_raw' });
  });

  it('rejects stale capability bindings, boot/node identity and mutated capability snapshots', async () => {
    const caps = capabilities(), p = await policy(caps);
    caps.summary!.max_addresses = 128;
    expect((await negotiate(p, caps)).issues).toContainEqual({ code: 'capability_digest_mismatch', path: 'control.capability_sha256' });
    expect((await negotiate(p, capabilities(), { ...context(), boot_id: '22222222-2222-4222-8222-222222222222' })).issues)
      .toContainEqual({ code: 'identity_mismatch', path: 'context' });
    expect((await negotiate(p, capabilities(), { ...context(), node_id: 'another-node' })).state).toBe('rejected');
  });

  it('does not silently downgrade scan modes, PHYs, extractor versions or field support', async () => {
    const { p, caps } = await featureFixture();
    p.collection.scan.mode = 'active'; p.collection.scan.phys = ['coded'];
    if (p.evidence.mode === 'features') { p.evidence.extractor_version = 'unsupported/2'; p.evidence.fields = [{ kind: 'template_ids', max_values_per_identifier: 16 }]; }
    const before = structuredClone(p), result = await negotiate(p, caps);
    expect(result.issues.filter(i => i.code === 'unsupported_capability').map(i => i.path)).toEqual([
      'collection.scan.mode', 'collection.scan.phys', 'evidence.extractor_version', 'evidence.fields',
    ]);
    expect(p).toEqual(before);
  });

  it('requires current capability validity and an explicit supported policy schema', async () => {
    const caps = capabilities(); caps.expires_at = context().now; caps.policy_schemas = ['device-config/4'];
    const result = await negotiate(await policy(caps), caps);
    expect(result.issues).toContainEqual({ code: 'capabilities_not_current', path: 'capabilities' });
    expect(result.issues).toContainEqual({ code: 'unsupported_capability', path: 'config.schema' });
    caps.issued_at = '2026-10-30T11:00:00.000Z'; caps.expires_at = '2026-10-31T00:00:00.000Z';
    expect((await negotiate(await policy(caps), caps)).state).toBe('rejected');
  });

  it('hashes validated objects deterministically and detects policy changes', async () => {
    const p = await policy(), frozen = await freezeDeviceConfigV3(p);
    const reordered = Object.fromEntries(Object.entries(p).reverse());
    expect(await freezeDeviceConfigV3(reordered)).toEqual(frozen);
    expect(await validateFrozenDeviceConfigV3(frozen)).toEqual(frozen);
    p.revision++;
    expect(frozen.policy.revision).toBe(1);
    expect((await freezeDeviceConfigV3(p)).policy_sha256).not.toBe(frozen.policy_sha256);
    frozen.policy.revision++;
    await expect(validateFrozenDeviceConfigV3(frozen)).rejects.toThrow('envelope.policy_sha256');
    await expect(validateFrozenDeviceConfigV3({ ...frozen, arbitrary: true })).rejects.toThrow();
  });

  it('gives omission and null different capability digests', async () => {
    const caps = capabilities(), explicit = await capabilityDigestV3(caps);
    delete caps.local_raw;
    expect(await capabilityDigestV3(caps)).not.toBe(explicit);
  });
});

describe('v3 resource and custody limits', () => {
  it.each([64, 128, 512])('validates %i addresses independently from device and request capacity', async count => {
    const caps = capabilities(), p = await policy(caps);
    if (p.collection.summary.enabled) p.collection.summary.max_addresses = count;
    expect((await negotiate(p, caps)).state).toBe('compatible');
    caps.summary!.max_addresses = count - 1;
    p.control.capability_sha256 = await capabilityDigestV3(caps);
    expect((await negotiate(p, caps)).issues).toContainEqual({ code: 'resource_limit', path: 'collection.summary.max_addresses' });
  });

  it('keeps protocol ceilings separate from claimed device capacity', async () => {
    const p = await policy();
    if (p.collection.summary.enabled) p.collection.summary.max_addresses = 513;
    expect(() => validateDeviceConfigV3(p)).toThrow();
    if (p.collection.summary.enabled) p.collection.summary.max_addresses = 512;
    if (p.uplink.enabled) p.uplink.max_batch_items = 129;
    expect(() => validateDeviceConfigV3(p)).toThrow();
    if (p.uplink.enabled) { p.uplink.max_batch_items = 16; p.uplink.max_body_bytes = 65537; }
    expect(() => validateDeviceConfigV3(p)).toThrow();
  });

  it('enforces divisibility and finite safe integer resource limits', async () => {
    const p = await policy();
    if (p.collection.summary.enabled) p.collection.summary.bin_ms = 19000;
    expect(() => validateDeviceConfigV3(p)).toThrow();
    for (const amount of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, -1, 0.5]) {
      p.resources.working_bytes = amount;
      expect(() => validateDeviceConfigV3(p)).toThrow();
    }
  });

  it('rejects overcommitted queue reserves and reserves smaller than an allowed body', async () => {
    const p = await policy();
    if (p.local_queue.mode !== 'disabled') {
      p.local_queue.max_bytes = 512;
      expect(() => validateDeviceConfigV3(p)).toThrow();
      p.local_queue.max_bytes = 131072; p.local_queue.stream_reserves[0].bytes = 512;
      expect(() => validateDeviceConfigV3(p)).toThrow();
      p.local_queue.stream_reserves[0].bytes = 8192;
      p.local_queue.stream_reserves.pop();
      expect(() => validateDeviceConfigV3(p)).toThrow();
    }
  });

  it('does not accept RAM/PSRAM as durable or claim recovery from an unverified medium', async () => {
    const p = await policy(), caps = capabilities();
    if (p.local_queue.mode !== 'disabled') p.local_queue.medium = 'ram';
    expect(() => validateDeviceConfigV3(p)).toThrow();
    caps.queue!.media[0].power_loss_recovery = false;
    const result = await negotiate(await policy(caps), caps);
    expect(result.issues).toContainEqual({ code: 'unsupported_capability', path: 'local_queue.recovery' });
    caps.queue!.media = [{ medium: 'ram', usable_bytes: 1048576, max_items: 256, power_loss_recovery: true }];
    expect(() => validateDeviceCapabilitiesV3(caps)).toThrow();
  });

  it('allows best-effort RAM only under an explicit research/test mode', async () => {
    const caps = capabilities(); caps.queue!.media = [{ medium: 'ram', usable_bytes: 262144, max_items: 256, power_loss_recovery: false }];
    const p = await policy(caps);
    if (p.local_queue.mode !== 'disabled') Object.assign(p.local_queue, { mode: 'best_effort_research', medium: 'ram', full_behavior: 'drop_new_counted', recovery: 'none' });
    expect(() => validateDeviceConfigV3(p)).toThrow();
    p.custody.dataset = 'controlled_test'; p.custody.purpose = 'controlled_test';
    expect((await negotiate(p, caps)).state).toBe('compatible');
    p.resources.working_bytes = 1024;
    expect(() => validateDeviceConfigV3(p)).toThrow();
  });

  it('checks queue, memory, write, summary and network limits without clipping', async () => {
    const caps = capabilities();
    caps.queue!.media[0].usable_bytes = 65536; caps.queue!.media[0].max_items = 64;
    caps.resources!.max_working_bytes = 262144; caps.resources!.max_storage_write_bytes_per_day = 1048576;
    caps.summary!.max_bins = 2; caps.summary!.max_window_ms = 30000;
    caps.uplink!.max_batch_items = 8; caps.uplink!.max_body_bytes = 2048;
    const result = await negotiate(await policy(caps), caps);
    expect(result.issues.filter(i => i.code === 'resource_limit').map(i => i.path)).toEqual([
      'collection.summary.bin_ms', 'collection.summary.window_ms', 'uplink.max_batch_items', 'uplink.max_body_bytes',
      'local_queue.max_bytes', 'local_queue.max_items', 'resources.working_bytes', 'resources.storage_write_bytes_per_day',
    ]);
  });

  it('accounts for raw, free-space and TF queue reservations on the same card', async () => {
    const caps = capabilities();
    caps.local_raw = { formats: ['cpraw/1'], max_segment_bytes: 1048576, min_sync_interval_ms: 500 };
    caps.resources!.tf_usable_bytes = 17825792;
    caps.queue!.media = [{ medium: 'tf_journal', usable_bytes: 262144, max_items: 256, power_loss_recovery: true }];
    const p = await policy(caps); p.local_raw = rawPolicy();
    if (p.local_queue.mode !== 'disabled') p.local_queue.medium = 'tf_journal';
    expect((await negotiate(p, caps)).issues).toContainEqual({ code: 'resource_limit', path: 'resources.tf_usable_bytes' });
    caps.resources!.tf_usable_bytes += 131072;
    p.control.capability_sha256 = await capabilityDigestV3(caps);
    expect((await negotiate(p, caps)).state).toBe('compatible');
  });

  it('enforces bounded feature extraction and deliberate sampling semantics', async () => {
    const { p, caps } = await featureFixture();
    if (p.evidence.mode !== 'features') throw new Error('fixture');
    p.evidence.sample_every_n = 10;
    expect(() => validateDeviceConfigV3(p)).toThrow();
    p.evidence.population = 'deterministic_sample';
    expect((await negotiate(p, caps)).state).toBe('compatible');
    p.evidence.fields[1].max_values_per_identifier = 9;
    expect(() => validateDeviceConfigV3(p)).toThrow();
    p.evidence.fields[1].max_values_per_identifier = 8; p.evidence.max_reports_per_window++;
    expect((await negotiate(p, caps)).issues).toContainEqual({ code: 'resource_limit', path: 'evidence.max_reports_per_window' });
  });

  it('does not grant archive upload permission merely from a supported feature and policy ID', async () => {
    const caps = capabilities(); caps.uplink!.cpraw_archive = true;
    const p = await policy(caps);
    if (p.uplink.enabled) p.uplink.archive = { mode: 'separate_policy', policy_id: 'unresolved-archive-policy' };
    expect((await negotiate(p, caps)).issues).toContainEqual({ code: 'separate_archive_policy_required', path: 'uplink.archive' });
  });

  it('requires exact streams, sample format and retained status capacity', async () => {
    const p = await policy();
    if (!p.uplink.enabled) throw new Error('fixture');
    p.uplink.streams.push('ble_reports');
    expect(() => validateDeviceConfigV3(p)).toThrow();
    p.uplink.raw_sample = { mode: 'sampled', format: 'legacy_ad', every_n: 100, max_reports_per_window: 4, selection: 'seq_mod_n_eq_0' };
    if (p.local_queue.mode !== 'disabled') p.local_queue.stream_reserves.push({ stream: 'ble_reports', bytes: 8192, items: 8 });
    expect((await negotiate(p)).state).toBe('rejected');
    p.uplink.raw_sample.max_reports_per_window = 17;
    expect(() => validateDeviceConfigV3(p)).toThrow();
  });

  it('rejects mismatched custody, uncontrolled association, retention extension and invalid time order', async () => {
    const original = await policy();
    for (const patch of [{ purpose: 'research' }, { placement_id: null }, { association_scope: 'segment' },
      { derived_retention_hours: 25 }, { accept_until: '2026-10-30T19:59:59.000Z' }]) {
      expect(() => validateDeviceConfigV3({ ...original, custody: { ...original.custody, ...patch } })).toThrow();
    }
    const { p } = await offlineFixture();
    p.uplink = original.uplink; p.local_queue = original.local_queue;
    expect(() => validateDeviceConfigV3(p)).toThrow();
  });
});

describe('v3 activation boundaries and lease plans', () => {
  it('requires a new assignment generation and fully closed windows and segments', async () => {
    const p = await policy();
    for (const patch of [{ window_open: true }, { segment_open: true }, { closed_window_seq: 2 }]) {
      expect((await negotiate(p, capabilities(), { ...context(), ...patch })).issues).toContainEqual({ code: 'boundary_not_ready', path: 'control.activation' });
    }
    expect((await negotiate(p, capabilities(), { ...context(), last_assignment_generation: 2 })).issues)
      .toContainEqual({ code: 'stale_assignment', path: 'config.assignment_generation' });
    p.control.activation.after_segment_seq = 1;
    expect((await negotiate(p)).state).toBe('rejected');
  });

  it('uses half-open time boundaries for capabilities, policy validity and upload acceptance', async () => {
    const p = await policy();
    expect((await negotiate(p, capabilities(), { ...context(), now: '2026-10-30T09:59:59.999Z' })).issues)
      .toContainEqual({ code: 'policy_not_yet_valid', path: 'control.activation.not_before' });
    expect((await negotiate(p, capabilities(), { ...context(), now: p.control.activation.not_before })).state).toBe('compatible');
    expect((await negotiate(p, capabilities(), { ...context(), now: p.control.activation.expires_at })).issues)
      .toContainEqual({ code: 'policy_expired', path: 'control.activation.expires_at' });
    expect(evaluateDeviceV3Lease(p, p.custody.accept_until, 0)).toEqual({ collection: 'paused', local_raw: 'stopped', uplink: 'paused', preserve_unacknowledged: true });
  });

  it('separates scan/raw lease actions from frozen-queue drain and never erases evidence', async () => {
    const p = await policy(); p.local_raw = rawPolicy(); p.control.lease.on_raw_expiry = 'continue_until_policy_expiry';
    expect(evaluateDeviceV3Lease(p, context().now, 119999)).toEqual({ collection: 'permitted', local_raw: 'permitted', uplink: 'permitted', preserve_unacknowledged: true });
    expect(evaluateDeviceV3Lease(p, context().now, 120000)).toEqual({ collection: 'paused', local_raw: 'permitted', uplink: 'frozen_only', preserve_unacknowledged: true });
    expect(evaluateDeviceV3Lease(p, p.control.activation.expires_at, 0)).toEqual({ collection: 'paused', local_raw: 'stopped', uplink: 'frozen_only', preserve_unacknowledged: true });
    p.control.lease.on_uplink_expiry = 'pause';
    expect(evaluateDeviceV3Lease(p, context().now, 120000).uplink).toBe('paused');
  });
});

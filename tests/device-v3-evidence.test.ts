import { describe, expect, it } from 'vitest';
import { freezeDeviceConfigV3, type DeviceConfigV3 } from '../worker/device-v3-config';
import { parseFeatureEvidenceV3Json, validateFeatureEvidenceV3, validateFeatureEvidenceWindowV3,
  type FeatureEvidenceV3, type V3FeatureRegistry } from '../worker/device-v3-evidence';

// All identities, registry IDs, policies and source claims are synthetic.
const BOOT = '11111111-1111-4111-8111-111111111111';
const registry: V3FeatureRegistry = { dictionary_version: 'synthetic-dictionary/1', name_pattern_ids: ['synthetic-pattern'], template_ids: ['synthetic-template'] };
const known = (value: number) => ({ value, reason: null });
const unavailable = () => ({ value: null, reason: 'not_provided' as const });
function record(): FeatureEvidenceV3 {
  return { schema: 'ble-feature-evidence/1', extractor_version: 'synthetic-extractor/1',
    dictionary: { value: registry.dictionary_version, reason: null },
    scope: { node_id: 'synthetic-node', boot_id: BOOT, placement_id: 'synthetic-place', capture_config_id: 'synthetic-policy',
      policy_sha256: '1'.repeat(64), dataset: 'controlled_test', window_seq: 4 },
    identity: { scheme: 'window_token', token: '1'.repeat(32), address_type: 'random' },
    observed_time: { start: { mono_ms: 0, utc_ms: null, clock_epoch: 1, uncertainty_ms: null },
      end: { mono_ms: 60000, utc_ms: null, clock_epoch: 1, uncertainty_ms: null } },
    population: 'all_worker_reports', sampling: null, extraction_state: 'complete',
    reports: { available_reports: 2, examined_reports: 2, parsed_reports: 2, malformed_reports: 0, unsupported_reports: 0,
      unexamined_reports: 0, parsed_adv_reports: 1, parsed_scan_response_reports: 1 },
    source_counters: { identifier_worker_reports: known(2), window_reports_seen: known(2), window_reports_aggregated: known(2),
      window_queue_drops: known(0), window_address_overflow: known(0), identifier_intentional_skips: known(0), identifier_pressure_skips: known(0) },
    features: { company_ids: { values: [{ value: 76, support_reports: 2, adv_reports: 1, scan_response_reports: 1, conflicting: false }],
      unavailable_reason: null, overflow: 0, overflow_reason: null } } };
}
function policy(): DeviceConfigV3 {
  return { schema: 'device-config/3', protocol: 'campuspulse/3', policy_id: 'synthetic-policy', node_id: 'synthetic-node', revision: 1, assignment_generation: 2,
    collection: { enabled: true, mode: 'fixed_point', scan: { mode: 'passive', interval_units: 160, window_units: 160, duplicate_filter: false, phys: ['1m'] },
      summary: { enabled: true, window_ms: 60000, bin_ms: 20000, max_addresses: 512 } },
    local_raw: { mode: 'off' }, evidence: { mode: 'features', schema: 'ble-feature-evidence/1', extractor_version: 'synthetic-extractor/1', population: 'all_worker_reports', sample_every_n: null,
      fields: [{ kind: 'company_ids', max_values_per_identifier: 16 }], max_reports_per_window: 100000, max_bytes_per_window: 2000000, overflow: 'count_and_mark_partial' },
    uplink: { enabled: false }, local_queue: { mode: 'disabled' }, resources: { working_bytes: 2000000, storage_write_bytes_per_day: 0 },
    custody: { dataset: 'controlled_test', purpose: 'controlled_test', placement_id: 'synthetic-place', association_scope: 'window', source_retention_hours: 24,
      derived_retention_hours: 24, accept_until: '2026-11-01T00:00:00.000Z', max_upload_bytes_per_day: 0 },
    control: { capability_sha256: '1'.repeat(64), activation: { boot_id: BOOT, boundary: 'closed_window_and_segment', after_window_seq: 3, after_segment_seq: 0,
      not_before: '2026-10-30T10:00:00.000Z', expires_at: '2026-10-30T20:00:00.000Z' },
      lease: { duration_ms: 120000, on_collection_expiry: 'pause', on_raw_expiry: 'stop_recording', on_uplink_expiry: 'pause' } } };
}
async function windowRecords(count = 1, p = policy()) {
  const envelope = await freezeDeviceConfigV3(p);
  const records = Array.from({ length: count }, (_, n) => {
    const r = record();
    r.scope.policy_sha256 = envelope.policy_sha256;
    r.identity.token = n.toString(16).padStart(32, '0');
    r.source_counters.window_reports_seen = known(count * 2);
    r.source_counters.window_reports_aggregated = known(count * 2);
    return r;
  });
  return { envelope, records };
}

describe('offline v3 feature evidence subset', () => {
  it('validates claims without adding an inferred count, RF completeness or source time', () => {
    const r = record();
    expect(validateFeatureEvidenceV3(r, registry)).toEqual(r);
    expect(r.observed_time.end.utc_ms).toBeNull();
    expect(r).not.toHaveProperty('estimated_total');
  });

  it('preserves absent, null/unavailable and empty/examined feature states', () => {
    const missing = record(); missing.extraction_state = 'partial'; delete missing.features.company_ids;
    expect(validateFeatureEvidenceV3(missing, registry).features).not.toHaveProperty('company_ids');
    const nil = record(); nil.extraction_state = 'partial';
    nil.features.company_ids = { values: null, unavailable_reason: 'unavailable', overflow: null, overflow_reason: 'not_measured' };
    expect(validateFeatureEvidenceV3(nil, registry).features.company_ids!.values).toBeNull();
    const empty = record(); empty.features.company_ids!.values = [];
    expect(validateFeatureEvidenceV3(empty, registry).features.company_ids!.values).toEqual([]);
    expect(() => validateFeatureEvidenceV3({ ...record(), features: null }, registry)).toThrow();
  });

  it('preserves explicit unavailable versions and source counters without defaulting to zero', () => {
    const r = record(); r.ruleset = { value: null, reason: 'not_supported' };
    r.source_counters.window_reports_seen = unavailable();
    expect(validateFeatureEvidenceV3(r, registry).ruleset).toEqual(r.ruleset);
    expect(validateFeatureEvidenceV3(r, registry).source_counters.window_reports_seen.value).toBeNull();
    expect(() => validateFeatureEvidenceV3({ ...r, ruleset: { value: null, reason: null } }, registry)).toThrow();
    r.source_counters.window_reports_seen = { value: null, reason: null };
    expect(() => validateFeatureEvidenceV3(r, registry)).toThrow();
  });

  it.each(['available_reports', 'examined_reports', 'parsed_reports', 'parsed_adv_reports', 'parsed_scan_response_reports'] as const)('rejects broken report accounting at %s', key => {
    const r = record(); r.reports[key]++;
    expect(() => validateFeatureEvidenceV3(r, registry)).toThrow();
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid counter %s', n => {
    const r = record(); r.reports.parsed_reports = n;
    expect(() => validateFeatureEvidenceV3(r, registry)).toThrow();
  });

  it('allows overlapping support counts and conflict claims without majority voting', () => {
    const r = record();
    r.features.company_ids!.values!.push({ value: 117, support_reports: 2, adv_reports: 1, scan_response_reports: 1, conflicting: true });
    const result = validateFeatureEvidenceV3(r, registry);
    expect(result.features.company_ids!.values!.reduce((n, v) => n + v.support_reports, 0)).toBe(4);
    expect(result.reports.parsed_reports).toBe(2);
    expect(result.features.company_ids!.values![1].conflicting).toBe(true);
    expect(result).not.toHaveProperty('category');
  });

  it('rejects unsupported feature support and duplicate values', () => {
    for (const change of [(r: FeatureEvidenceV3) => { r.features.company_ids!.values![0].support_reports = 3; },
      (r: FeatureEvidenceV3) => { r.features.company_ids!.values![0].scan_response_reports = 0; },
      (r: FeatureEvidenceV3) => { r.features.company_ids!.values!.push(r.features.company_ids!.values![0]); }]) {
      const r = record(); change(r); expect(() => validateFeatureEvidenceV3(r, registry)).toThrow();
    }
  });

  it('retains malformed, fragment/unsupported and unexamined reports as partial extraction', () => {
    const r = record(); r.extraction_state = 'partial';
    Object.assign(r.reports, { available_reports: 5, examined_reports: 4, malformed_reports: 1, unsupported_reports: 1, unexamined_reports: 1 });
    r.source_counters.identifier_worker_reports = known(5); r.source_counters.window_reports_seen = known(5);
    r.source_counters.identifier_intentional_skips = known(1); r.source_counters.identifier_pressure_skips = known(1);
    expect(validateFeatureEvidenceV3(r, registry).reports.unsupported_reports).toBe(1);
    r.extraction_state = 'complete';
    expect(() => validateFeatureEvidenceV3(r, registry)).toThrow();
  });

  it('requires explicit partial state for known overflow, unknown overflow and unavailable values', () => {
    const r = record(); r.features.company_ids!.overflow = 3;
    expect(() => validateFeatureEvidenceV3(r, registry)).toThrow();
    r.extraction_state = 'partial'; expect(validateFeatureEvidenceV3(r, registry).features.company_ids!.overflow).toBe(3);
    r.features.company_ids!.overflow = null;
    expect(() => validateFeatureEvidenceV3(r, registry)).toThrow();
    r.features.company_ids!.overflow_reason = 'not_measured';
    expect(validateFeatureEvidenceV3(r, registry).features.company_ids!.overflow).toBeNull();
  });

  it.each(['service_uuids', 'company_ids', 'appearance', 'name_pattern_ids', 'template_ids'] as const)('enforces %s limits without truncating', kind => {
    const r = record();
    r.features[kind] = { values: Array.from({ length: kind === 'appearance' ? 9 : 17 }, (_, n) => ({
      value: kind === 'service_uuids' ? `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb` : kind === 'name_pattern_ids' ? 'synthetic-pattern' : kind === 'template_ids' ? 'synthetic-template' : n,
      support_reports: 1, adv_reports: 1, scan_response_reports: 0, conflicting: false })), unavailable_reason: null, overflow: 0, overflow_reason: null };
    expect(() => validateFeatureEvidenceV3(r, registry)).toThrow();
  });

  it('requires reviewed registry IDs and the matching dictionary instead of accepting arbitrary observed strings', () => {
    const r = record(); r.features.name_pattern_ids = { ...r.features.company_ids!, values: [{ ...r.features.company_ids!.values![0], value: 'synthetic-pattern' }] };
    expect(validateFeatureEvidenceV3(r, registry).features.name_pattern_ids!.values![0].value).toBe('synthetic-pattern');
    r.features.name_pattern_ids!.values![0].value = 'PRIVATE_NAME_DO_NOT_ECHO';
    expect(() => validateFeatureEvidenceV3(r, registry)).toThrow();
    try { validateFeatureEvidenceV3(r, registry); } catch (e) { expect(String(e)).not.toContain('PRIVATE_NAME'); }
    r.features.name_pattern_ids!.values![0].value = 'synthetic-pattern'; delete r.dictionary;
    expect(() => validateFeatureEvidenceV3(r, registry)).toThrow();
  });

  it.each(['payload_hex', 'name', 'address', 'mac', 'payload_hash'])('rejects private/unknown %s fields at every schema boundary', field => {
    for (const part of ['root', 'scope', 'identity', 'observed_time', 'reports', 'source_counters', 'features', 'list', 'feature']) {
      const r = record();
      const target = part === 'root' ? r : part === 'list' ? r.features.company_ids! : part === 'feature' ? r.features.company_ids!.values![0] : r[part as 'scope'];
      Object.assign(target, { [field]: 'PRIVATE_VALUE_DO_NOT_ECHO' });
      expect(() => validateFeatureEvidenceV3(r, registry)).toThrow();
      try { validateFeatureEvidenceV3(r, registry); } catch (e) { expect(String(e)).not.toContain('PRIVATE_VALUE'); }
    }
  });

  it('rejects wrong schema, missing requirements, null without reason and MAC identity', () => {
    expect(() => validateFeatureEvidenceV3({ ...record(), schema: 'ble-feature-evidence/2' }, registry)).toThrow();
    const { sampling: _, ...missing } = record(); expect(() => validateFeatureEvidenceV3(missing, registry)).toThrow();
    expect(() => validateFeatureEvidenceV3({ ...record(), identity: { scheme: 'mac', address: '00:00:00:00:00:00', address_type: 'random' } }, registry)).toThrow();
    const r = record(); r.features.company_ids!.values = null;
    expect(() => validateFeatureEvidenceV3(r, registry)).toThrow();
  });

  it('preserves original delayed UTC and rejects clock epoch/interval inconsistencies', () => {
    const r = record(); r.observed_time.start.utc_ms = 1793354400000; r.observed_time.end.utc_ms = 1793354460000;
    r.observed_time.start.uncertainty_ms = 200; r.observed_time.end.uncertainty_ms = 200;
    expect(validateFeatureEvidenceV3(r, registry).observed_time).toEqual(r.observed_time);
    r.observed_time.end.clock_epoch++;
    expect(() => validateFeatureEvidenceV3(r, registry)).toThrow();
    const missingUtc = record(); missingUtc.observed_time.end.uncertainty_ms = 200;
    expect(() => validateFeatureEvidenceV3(missingUtc, registry)).toThrow();
    const reversed = record(); reversed.observed_time.start.mono_ms = 60000;
    expect(() => validateFeatureEvidenceV3(reversed, registry)).toThrow();
  });

  it('checks original known UTC against policy observation validity and never uses current receive time', async () => {
    const { envelope, records } = await windowRecords();
    records[0].observed_time.start.utc_ms = Date.parse('2026-10-30T10:00:00.000Z');
    records[0].observed_time.end.utc_ms = Date.parse('2026-10-30T10:01:00.000Z');
    const validated = await validateFeatureEvidenceWindowV3(records, envelope, registry);
    expect(validated.records[0].observed_time).toEqual(records[0].observed_time);
    records[0].observed_time.end.utc_ms = Date.parse('2026-10-30T20:01:00.000Z');
    await expect(validateFeatureEvidenceWindowV3(records, envelope, registry)).rejects.toThrow();
  });

  it('requires immutable explicit sampling and does not relabel a sample as a whole window', async () => {
    const p = policy(); if (p.evidence.mode !== 'features') throw new Error('fixture');
    p.evidence.population = 'deterministic_sample'; p.evidence.sample_every_n = 3;
    const { envelope, records } = await windowRecords(1, p);
    records[0].population = 'deterministic_sample'; records[0].sampling = { selection: 'seq_mod_n_eq_0', every_n: 3, max_reports_per_window: 100000 };
    records[0].source_counters.identifier_worker_reports = known(6); records[0].source_counters.window_reports_seen = known(6);
    const result = await validateFeatureEvidenceWindowV3(records, envelope, registry);
    expect(result.limitations).toContain('deterministic_sample_only'); expect(result.estimated_total).toBeNull();
    records[0].sampling.every_n = 2;
    await expect(validateFeatureEvidenceWindowV3(records, envelope, registry)).rejects.toThrow();
    records[0].sampling = null;
    expect(() => validateFeatureEvidenceV3(records[0], registry)).toThrow();
  });

  it.each([64, 128, 512])('validates %s retained identifiers within explicit policy bounds', async count => {
    const { envelope, records } = await windowRecords(count);
    const result = await validateFeatureEvidenceWindowV3(records, envelope, registry);
    expect(result.retained_identifiers).toBe(count); expect(result.limitations).toContain('not_a_device_or_people_count');
    expect(result.window_completeness).toBe('not_established');
  });

  it('rejects 513 identifiers, duplicates and mixed full source scopes', async () => {
    const { envelope, records } = await windowRecords(513);
    await expect(validateFeatureEvidenceWindowV3(records, envelope, registry)).rejects.toThrow();
    const two = await windowRecords(2); two.records[1].identity = two.records[0].identity;
    await expect(validateFeatureEvidenceWindowV3(two.records, two.envelope, registry)).rejects.toThrow();
    for (const key of ['node_id', 'boot_id', 'placement_id', 'capture_config_id', 'policy_sha256', 'dataset', 'window_seq'] as const) {
      const two = await windowRecords(2);
      Object.assign(two.records[1].scope, { [key]: key === 'window_seq' ? 5 : key === 'boot_id' ? '22222222-2222-4222-8222-222222222222' : key === 'policy_sha256' ? '2'.repeat(64) : key === 'dataset' ? 'demo' : 'other' });
      await expect(validateFeatureEvidenceWindowV3(two.records, two.envelope, registry)).rejects.toThrow();
    }
  });

  it('enforces policy fields, extraction completeness, versions, source window counters and aggregate budgets', async () => {
    for (const mutate of [(r: FeatureEvidenceV3) => { r.extractor_version = 'other'; },
      (r: FeatureEvidenceV3) => { delete r.features.company_ids; },
      (r: FeatureEvidenceV3) => { r.scope.window_seq = 3; },
      (r: FeatureEvidenceV3) => { r.observed_time.end.mono_ms = 60001; },
      (r: FeatureEvidenceV3) => { r.features.appearance = { ...r.features.company_ids!, values: [] }; }]) {
      const { records, envelope } = await windowRecords(); mutate(records[0]);
      await expect(validateFeatureEvidenceWindowV3(records, envelope, registry)).rejects.toThrow();
    }
    const p = policy(); if (p.evidence.mode !== 'features') throw new Error('fixture'); p.evidence.max_reports_per_window = 3;
    const bounded = await windowRecords(2, p);
    await expect(validateFeatureEvidenceWindowV3(bounded.records, bounded.envelope, registry)).rejects.toThrow();
    p.evidence.max_reports_per_window = 100; p.evidence.max_bytes_per_window = 512;
    const bytes = await windowRecords(1, p);
    await expect(validateFeatureEvidenceWindowV3(bytes.records, bytes.envelope, registry)).rejects.toThrow();
    const two = await windowRecords(2); two.records[1].source_counters.window_queue_drops = known(1);
    await expect(validateFeatureEvidenceWindowV3(two.records, two.envelope, registry)).rejects.toThrow();
  });

  it('rejects impossible aggregate source claims even when per-identifier worker counts are unavailable', async () => {
    const { envelope, records } = await windowRecords(2);
    for (const r of records) {
      r.source_counters.identifier_worker_reports = unavailable();
      r.source_counters.window_reports_seen = known(2);
      r.source_counters.window_reports_aggregated = known(2);
    }
    await expect(validateFeatureEvidenceWindowV3(records, envelope, registry)).rejects.toThrow();
  });

  it('rejects malformed UTF-8, duplicate decoded keys, deep JSON and transport bodies beyond 65536 bytes', () => {
    const encode = (s: string) => new TextEncoder().encode(s);
    expect(() => parseFeatureEvidenceV3Json(new Uint8Array([255]))).toThrow();
    expect(() => parseFeatureEvidenceV3Json(encode('{"schema":1,"schem\\u0061":2}'))).toThrow();
    expect(() => parseFeatureEvidenceV3Json(encode('['.repeat(1000) + ']'.repeat(1000)))).toThrow();
    expect(() => parseFeatureEvidenceV3Json(new Uint8Array(65537))).toThrow();
    expect(validateFeatureEvidenceV3(parseFeatureEvidenceV3Json(encode(JSON.stringify(record()))), registry)).toEqual(record());
  });
});

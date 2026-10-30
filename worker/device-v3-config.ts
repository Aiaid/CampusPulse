/** Offline-only v3 policy core. No routes, assignments, persistence or device ACKs. */
import { parseIngestJson } from './ingest-validation';

export const V3_POLICY_SCHEMA = 'device-config/3' as const;
export const V3_CAPABILITY_SCHEMA = 'device-capabilities/1' as const;
export const V3_STREAMS = ['ble_windows', 'address_summaries', 'feature_summaries', 'node_status', 'ble_reports'] as const;
export const V3_FEATURE_FIELDS = ['service_uuids', 'company_ids', 'appearance', 'name_pattern_ids', 'template_ids'] as const;
type Stream = typeof V3_STREAMS[number];
type FeatureField = typeof V3_FEATURE_FIELDS[number];
type Medium = 'flash_journal' | 'tf_journal' | 'ram';
type Phy = '1m' | 'coded';
type Transport = 'https' | 'mqtt_tls';
type Population = 'all_worker_reports' | 'deterministic_sample';
type ScanMode = 'passive' | 'active';
type Sample = { mode: 'off' } | { mode: 'sampled'; format: 'legacy_ad'; every_n: number; max_reports_per_window: number; selection: 'seq_mod_n_eq_0' };

export interface DeviceConfigV3 {
  schema: typeof V3_POLICY_SCHEMA;
  protocol: 'campuspulse/3';
  policy_id: string;
  node_id: string;
  revision: number;
  assignment_generation: number;
  collection: {
    enabled: boolean;
    mode: 'fixed_point' | 'mobile_research';
    scan: { mode: ScanMode; interval_units: number; window_units: number; duplicate_filter: boolean; phys: Phy[] };
    summary: { enabled: false } | { enabled: true; window_ms: number; bin_ms: number; max_addresses: number };
  };
  local_raw: { mode: 'off' } | {
    mode: 'tf_cpraw'; format: 'cpraw/1'; max_segment_bytes: number; max_total_bytes: number;
    min_free_bytes: number; sync_interval_ms: number; full_behavior: 'stop_recording';
  };
  evidence: { mode: 'off' } | {
    mode: 'features'; schema: 'ble-feature-evidence/1'; extractor_version: string;
    population: Population; sample_every_n: number | null;
    fields: { kind: FeatureField; max_values_per_identifier: number }[];
    max_reports_per_window: number; max_bytes_per_window: number;
    overflow: 'count_and_mark_partial';
  };
  uplink: { enabled: false } | {
    enabled: true; transport: Transport; streams: Stream[]; max_batch_items: number; max_body_bytes: number;
    retry: { min_delay_ms: number; max_delay_ms: number; max_attempts: number };
    raw_sample: Sample;
    archive: { mode: 'off' } | { mode: 'separate_policy'; policy_id: string };
  };
  local_queue: { mode: 'disabled' } | {
    mode: 'durable' | 'best_effort_research'; medium: Medium;
    max_bytes: number; max_items: number; control_reserve_bytes: number; control_reserve_items: number;
    stream_reserves: { stream: Stream; bytes: number; items: number }[];
    high_water_percent: number; full_behavior: 'pause_collection' | 'drop_new_counted';
    recovery: 'exact_frozen_batches' | 'none';
  };
  resources: { working_bytes: number; storage_write_bytes_per_day: number };
  custody: {
    dataset: 'field' | 'demo' | 'controlled_test' | 'research_unassigned';
    purpose: 'site_observation' | 'demonstration' | 'controlled_test' | 'research';
    placement_id: string | null; association_scope: 'window' | 'segment';
    source_retention_hours: number; derived_retention_hours: number;
    accept_until: string; max_upload_bytes_per_day: number;
  };
  control: {
    capability_sha256: string;
    activation: { boot_id: string; boundary: 'closed_window_and_segment'; after_window_seq: number;
      after_segment_seq: number; not_before: string; expires_at: string };
    lease: { duration_ms: number; on_collection_expiry: 'pause' | 'continue_until_policy_expiry';
      on_raw_expiry: 'stop_recording' | 'continue_until_policy_expiry';
      on_uplink_expiry: 'pause' | 'drain_frozen_until_accept_until' };
  };
}

/** Omitted capability = undeclared; null = explicitly unsupported. Neither grants support. */
export interface DeviceCapabilitiesV3 {
  schema: typeof V3_CAPABILITY_SCHEMA; capability_id: string; node_id: string; boot_id: string;
  producer_version: string; policy_schemas: string[]; issued_at: string; expires_at: string;
  scanner?: { modes: ScanMode[]; phys: Phy[]; duplicate_filter: boolean[];
    min_interval_units: number; max_interval_units: number } | null;
  summary?: { max_addresses: number; max_bins: number; max_window_ms: number } | null;
  features?: { schemas: string[]; extractor_versions: string[]; fields: FeatureField[];
    populations: Population[]; max_reports_per_window: number; max_bytes_per_window: number } | null;
  local_raw?: { formats: string[]; max_segment_bytes: number; min_sync_interval_ms: number } | null;
  uplink?: { transports: Transport[]; streams: Stream[]; max_batch_items: number; max_body_bytes: number;
    max_sample_reports_per_window: number; cpraw_archive: boolean } | null;
  queue?: { media: { medium: Medium; usable_bytes: number; max_items: number; power_loss_recovery: boolean }[] } | null;
  resources?: { max_working_bytes: number; max_storage_write_bytes_per_day: number; tf_usable_bytes: number | null } | null;
}

export class DeviceV3ConfigError extends Error {
  readonly code = 'invalid_device_v3';
  constructor(readonly path: string) { super(`Invalid v3 field: ${path}.`); this.name = 'DeviceV3ConfigError'; }
}
const fail = (path: string): never => { throw new DeviceV3ConfigError(path); };
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function obj(v: unknown, p: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(p);
  const o = v as Record<string, unknown>;
  if (required.some(k => !Object.hasOwn(o, k)) || Object.keys(o).some(k => !required.includes(k) && !optional.includes(k))) fail(p);
  return o;
}
function num(v: unknown, p: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail(p);
}
function str(v: unknown, p: string, pattern = LABEL): string {
  return typeof v === 'string' && pattern.test(v) ? v : fail(p);
}
function bool(v: unknown, p: string): boolean { return typeof v === 'boolean' ? v : fail(p); }
function pick<T extends string>(v: unknown, p: string, allowed: readonly T[]): T {
  return typeof v === 'string' && allowed.includes(v as T) ? v as T : fail(p);
}
function array<T>(v: unknown, p: string, convert: (v: unknown, p: string) => T, min = 0, max = 16): T[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) return fail(p);
  return v.map((value, i) => convert(value, `${p}[${i}]`));
}
function unique<T>(values: T[], p: string, key: (v: T) => unknown = v => v): T[] {
  if (new Set(values.map(key)).size !== values.length) fail(p);
  return values;
}
function enums<T extends string>(v: unknown, p: string, choices: readonly T[], min = 0): T[] {
  return unique(array(v, p, (v, p) => pick(v, p, choices), min, choices.length), p);
}
function labels(v: unknown, p: string): string[] { return unique(array(v, p, (v, p) => str(v, p), 0), p); }
function utc(v: unknown, p: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)) return fail(p);
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString() === v ? v : fail(p);
}
const bytes = (v: unknown, p: string, min = 1) => num(v, p, min, 2 ** 40);

export function validateDeviceConfigV3(value: unknown): DeviceConfigV3 {
  const o = obj(value, 'config', ['schema', 'protocol', 'policy_id', 'node_id', 'revision', 'assignment_generation',
    'collection', 'local_raw', 'evidence', 'uplink', 'local_queue', 'resources', 'custody', 'control']);
  const c = obj(o.collection, 'collection', ['enabled', 'mode', 'scan', 'summary']);
  const scan = obj(c.scan, 'collection.scan', ['mode', 'interval_units', 'window_units', 'duplicate_filter', 'phys']);
  const s = obj(c.summary, 'collection.summary', ['enabled'], ['window_ms', 'bin_ms', 'max_addresses']);
  let summary: DeviceConfigV3['collection']['summary'];
  if (!bool(s.enabled, 'collection.summary.enabled')) { obj(s, 'collection.summary', ['enabled']); summary = { enabled: false }; }
  else {
    obj(s, 'collection.summary', ['enabled', 'window_ms', 'bin_ms', 'max_addresses']);
    const window_ms = num(s.window_ms, 'collection.summary.window_ms', 1000, 300000);
    const bin_ms = num(s.bin_ms, 'collection.summary.bin_ms', 1000, window_ms);
    if (window_ms % bin_ms || window_ms / bin_ms > 60) fail('collection.summary.bin_ms');
    summary = { enabled: true, window_ms, bin_ms, max_addresses: num(s.max_addresses, 'collection.summary.max_addresses', 1, 512) };
  }
  const interval_units = num(scan.interval_units, 'collection.scan.interval_units', 4, 16384);
  const collection: DeviceConfigV3['collection'] = {
    enabled: bool(c.enabled, 'collection.enabled'), mode: pick(c.mode, 'collection.mode', ['fixed_point', 'mobile_research']),
    scan: { mode: pick(scan.mode, 'collection.scan.mode', ['passive', 'active']), interval_units,
      window_units: num(scan.window_units, 'collection.scan.window_units', 4, interval_units),
      duplicate_filter: bool(scan.duplicate_filter, 'collection.scan.duplicate_filter'), phys: enums(scan.phys, 'collection.scan.phys', ['1m', 'coded'], 1) },
    summary,
  };
  const raw = obj(o.local_raw, 'local_raw', ['mode'], ['format', 'max_segment_bytes', 'max_total_bytes', 'min_free_bytes', 'sync_interval_ms', 'full_behavior']);
  const rawMode = pick(raw.mode, 'local_raw.mode', ['off', 'tf_cpraw']);
  let local_raw: DeviceConfigV3['local_raw'];
  if (rawMode === 'off') { obj(raw, 'local_raw', ['mode']); local_raw = { mode: 'off' }; }
  else {
    obj(raw, 'local_raw', ['mode', 'format', 'max_segment_bytes', 'max_total_bytes', 'min_free_bytes', 'sync_interval_ms', 'full_behavior']);
    local_raw = { mode: rawMode, format: pick(raw.format, 'local_raw.format', ['cpraw/1']),
      max_total_bytes: bytes(raw.max_total_bytes, 'local_raw.max_total_bytes'),
      max_segment_bytes: bytes(raw.max_segment_bytes, 'local_raw.max_segment_bytes'),
      min_free_bytes: bytes(raw.min_free_bytes, 'local_raw.min_free_bytes'),
      sync_interval_ms: num(raw.sync_interval_ms, 'local_raw.sync_interval_ms', 100, 60000),
      full_behavior: pick(raw.full_behavior, 'local_raw.full_behavior', ['stop_recording']) };
    if (local_raw.max_segment_bytes > local_raw.max_total_bytes) fail('local_raw.max_segment_bytes');
  }
  const e = obj(o.evidence, 'evidence', ['mode'], ['schema', 'extractor_version', 'population', 'sample_every_n', 'fields', 'max_reports_per_window', 'max_bytes_per_window', 'overflow']);
  const evidenceMode = pick(e.mode, 'evidence.mode', ['off', 'features']);
  let evidence: DeviceConfigV3['evidence'];
  if (evidenceMode === 'off') { obj(e, 'evidence', ['mode']); evidence = { mode: 'off' }; }
  else {
    obj(e, 'evidence', ['mode', 'schema', 'extractor_version', 'population', 'sample_every_n', 'fields', 'max_reports_per_window', 'max_bytes_per_window', 'overflow']);
    const population = pick(e.population, 'evidence.population', ['all_worker_reports', 'deterministic_sample']);
    if (population === 'all_worker_reports' && e.sample_every_n !== null) fail('evidence.sample_every_n');
    evidence = { mode: evidenceMode, schema: pick(e.schema, 'evidence.schema', ['ble-feature-evidence/1']),
      extractor_version: str(e.extractor_version, 'evidence.extractor_version'), population,
      sample_every_n: population === 'all_worker_reports' ? null : num(e.sample_every_n, 'evidence.sample_every_n', 1, 0xffffffff),
      fields: unique(array(e.fields, 'evidence.fields', (v, p) => {
        const f = obj(v, p, ['kind', 'max_values_per_identifier']);
        const kind = pick(f.kind, `${p}.kind`, V3_FEATURE_FIELDS);
        return { kind, max_values_per_identifier: num(f.max_values_per_identifier, `${p}.max_values_per_identifier`, 1, kind === 'appearance' ? 8 : 16) };
      }, 1, V3_FEATURE_FIELDS.length), 'evidence.fields', f => f.kind),
      max_reports_per_window: num(e.max_reports_per_window, 'evidence.max_reports_per_window', 1, 10000000),
      max_bytes_per_window: bytes(e.max_bytes_per_window, 'evidence.max_bytes_per_window'),
      overflow: pick(e.overflow, 'evidence.overflow', ['count_and_mark_partial']) };
    if (!summary.enabled) fail('evidence');
  }
  const u = obj(o.uplink, 'uplink', ['enabled'], ['transport', 'streams', 'max_batch_items', 'max_body_bytes', 'retry', 'raw_sample', 'archive']);
  let uplink: DeviceConfigV3['uplink'];
  if (!bool(u.enabled, 'uplink.enabled')) { obj(u, 'uplink', ['enabled']); uplink = { enabled: false }; }
  else {
    obj(u, 'uplink', ['enabled', 'transport', 'streams', 'max_batch_items', 'max_body_bytes', 'retry', 'raw_sample', 'archive']);
    const r = obj(u.retry, 'uplink.retry', ['min_delay_ms', 'max_delay_ms', 'max_attempts']);
    const min_delay_ms = num(r.min_delay_ms, 'uplink.retry.min_delay_ms', 1000, 3600000);
    const sample = obj(u.raw_sample, 'uplink.raw_sample', ['mode'], ['format', 'every_n', 'max_reports_per_window', 'selection']);
    const mode = pick(sample.mode, 'uplink.raw_sample.mode', ['off', 'sampled']);
    let raw_sample: Sample;
    if (mode === 'off') { obj(sample, 'uplink.raw_sample', ['mode']); raw_sample = { mode }; }
    else {
      obj(sample, 'uplink.raw_sample', ['mode', 'format', 'every_n', 'max_reports_per_window', 'selection']);
      raw_sample = { mode, format: pick(sample.format, 'uplink.raw_sample.format', ['legacy_ad']),
        every_n: num(sample.every_n, 'uplink.raw_sample.every_n', 1, 0xffffffff),
        max_reports_per_window: num(sample.max_reports_per_window, 'uplink.raw_sample.max_reports_per_window', 1, 16),
        selection: pick(sample.selection, 'uplink.raw_sample.selection', ['seq_mod_n_eq_0']) };
    }
    const a = obj(u.archive, 'uplink.archive', ['mode'], ['policy_id']);
    const archiveMode = pick(a.mode, 'uplink.archive.mode', ['off', 'separate_policy']);
    let archive: { mode: 'off' } | { mode: 'separate_policy'; policy_id: string };
    if (archiveMode === 'off') { obj(a, 'uplink.archive', ['mode']); archive = { mode: archiveMode }; }
    else { obj(a, 'uplink.archive', ['mode', 'policy_id']); archive = { mode: archiveMode, policy_id: str(a.policy_id, 'uplink.archive.policy_id', ID) }; }
    uplink = { enabled: true, transport: pick(u.transport, 'uplink.transport', ['https', 'mqtt_tls']),
      streams: enums(u.streams, 'uplink.streams', V3_STREAMS, 1), max_batch_items: num(u.max_batch_items, 'uplink.max_batch_items', 1, 128),
      max_body_bytes: num(u.max_body_bytes, 'uplink.max_body_bytes', 512, 65536), raw_sample, archive,
      retry: { min_delay_ms, max_delay_ms: num(r.max_delay_ms, 'uplink.retry.max_delay_ms', min_delay_ms, 86400000),
        max_attempts: num(r.max_attempts, 'uplink.retry.max_attempts', 1, 100) } };
    if (uplink.streams.includes('ble_reports') !== (raw_sample.mode === 'sampled')) fail('uplink.raw_sample');
    if (uplink.streams.includes('feature_summaries') && evidence.mode !== 'features') fail('uplink.streams');
    if (uplink.streams.some(s => s !== 'node_status') && !summary.enabled) fail('uplink.streams');
    if (!uplink.streams.includes('node_status')) fail('uplink.streams');
  }
  const q = obj(o.local_queue, 'local_queue', ['mode'], ['medium', 'max_bytes', 'max_items', 'control_reserve_bytes', 'control_reserve_items', 'stream_reserves', 'high_water_percent', 'full_behavior', 'recovery']);
  const queueMode = pick(q.mode, 'local_queue.mode', ['disabled', 'durable', 'best_effort_research']);
  let local_queue: DeviceConfigV3['local_queue'];
  if (queueMode === 'disabled') { obj(q, 'local_queue', ['mode']); local_queue = { mode: queueMode }; }
  else {
    obj(q, 'local_queue', ['mode', 'medium', 'max_bytes', 'max_items', 'control_reserve_bytes', 'control_reserve_items', 'stream_reserves', 'high_water_percent', 'full_behavior', 'recovery']);
    local_queue = { mode: queueMode, medium: pick(q.medium, 'local_queue.medium', ['flash_journal', 'tf_journal', 'ram']),
      max_bytes: bytes(q.max_bytes, 'local_queue.max_bytes'), max_items: num(q.max_items, 'local_queue.max_items', 1, 1000000),
      control_reserve_bytes: bytes(q.control_reserve_bytes, 'local_queue.control_reserve_bytes', 512),
      control_reserve_items: num(q.control_reserve_items, 'local_queue.control_reserve_items', 1, 1000000),
      stream_reserves: unique(array(q.stream_reserves, 'local_queue.stream_reserves', (v, p) => {
        const r = obj(v, p, ['stream', 'bytes', 'items']);
        return { stream: pick(r.stream, `${p}.stream`, V3_STREAMS), bytes: bytes(r.bytes, `${p}.bytes`, 512), items: num(r.items, `${p}.items`, 1, 1000000) };
      }, 1, V3_STREAMS.length), 'local_queue.stream_reserves', r => r.stream),
      high_water_percent: num(q.high_water_percent, 'local_queue.high_water_percent', 1, 99),
      full_behavior: pick(q.full_behavior, 'local_queue.full_behavior', ['pause_collection', 'drop_new_counted']),
      recovery: pick(q.recovery, 'local_queue.recovery', ['exact_frozen_batches', 'none']) };
    const durable = queueMode === 'durable';
    if (durable === (local_queue.medium === 'ram') || local_queue.recovery !== (durable ? 'exact_frozen_batches' : 'none') ||
        local_queue.full_behavior !== (durable ? 'pause_collection' : 'drop_new_counted')) fail('local_queue');
    if (local_queue.stream_reserves.reduce((n, r) => n + r.bytes, local_queue.control_reserve_bytes) > local_queue.max_bytes ||
        local_queue.stream_reserves.reduce((n, r) => n + r.items, local_queue.control_reserve_items) > local_queue.max_items) fail('local_queue.stream_reserves');
    if (!local_queue.stream_reserves.some(r => r.stream === 'node_status')) fail('local_queue.stream_reserves');
    const reserves = local_queue.stream_reserves;
    if (uplink.enabled && (uplink.streams.some(s => !reserves.some(r => r.stream === s && r.bytes >= uplink.max_body_bytes)) ||
        reserves.some(r => !uplink.streams.includes(r.stream)))) fail('local_queue.stream_reserves');
  }
  if (uplink.enabled && local_queue.mode === 'disabled') fail('local_queue.mode');
  const budget = obj(o.resources, 'resources', ['working_bytes', 'storage_write_bytes_per_day']);
  const resources = { working_bytes: bytes(budget.working_bytes, 'resources.working_bytes'),
    storage_write_bytes_per_day: bytes(budget.storage_write_bytes_per_day, 'resources.storage_write_bytes_per_day', 0) };
  if (local_queue.mode === 'best_effort_research' && local_queue.max_bytes > resources.working_bytes) fail('resources.working_bytes');
  if ((local_raw.mode === 'tf_cpraw' || local_queue.mode === 'durable') && resources.storage_write_bytes_per_day === 0) fail('resources.storage_write_bytes_per_day');
  const p = obj(o.custody, 'custody', ['dataset', 'purpose', 'placement_id', 'association_scope', 'source_retention_hours', 'derived_retention_hours', 'accept_until', 'max_upload_bytes_per_day']);
  const custody: DeviceConfigV3['custody'] = {
    dataset: pick(p.dataset, 'custody.dataset', ['field', 'demo', 'controlled_test', 'research_unassigned']),
    purpose: pick(p.purpose, 'custody.purpose', ['site_observation', 'demonstration', 'controlled_test', 'research']),
    placement_id: p.placement_id === null ? null : str(p.placement_id, 'custody.placement_id', ID),
    association_scope: pick(p.association_scope, 'custody.association_scope', ['window', 'segment']),
    source_retention_hours: num(p.source_retention_hours, 'custody.source_retention_hours', 1, 168),
    derived_retention_hours: num(p.derived_retention_hours, 'custody.derived_retention_hours', 1, 168),
    accept_until: utc(p.accept_until, 'custody.accept_until'), max_upload_bytes_per_day: bytes(p.max_upload_bytes_per_day, 'custody.max_upload_bytes_per_day', 0),
  };
  const purpose = { field: 'site_observation', demo: 'demonstration', controlled_test: 'controlled_test', research_unassigned: 'research' };
  if (custody.purpose !== purpose[custody.dataset] || custody.derived_retention_hours > custody.source_retention_hours) fail('custody');
  if (custody.dataset === 'research_unassigned') {
    if (custody.placement_id !== null || uplink.enabled || collection.mode !== 'mobile_research') fail('custody.dataset');
  } else if (custody.placement_id === null) fail('custody.placement_id');
  if (custody.dataset === 'field' && (collection.mode !== 'fixed_point' || custody.association_scope !== 'window' ||
      (collection.enabled && local_queue.mode !== 'durable'))) fail('custody.dataset');
  if (local_queue.mode === 'best_effort_research' && !['controlled_test', 'research_unassigned'].includes(custody.dataset)) fail('local_queue.mode');
  if (uplink.enabled && custody.max_upload_bytes_per_day < uplink.max_body_bytes) fail('custody.max_upload_bytes_per_day');
  if (!uplink.enabled && custody.max_upload_bytes_per_day !== 0) fail('custody.max_upload_bytes_per_day');
  const control = obj(o.control, 'control', ['capability_sha256', 'activation', 'lease']);
  const a = obj(control.activation, 'control.activation', ['boot_id', 'boundary', 'after_window_seq', 'after_segment_seq', 'not_before', 'expires_at']);
  const l = obj(control.lease, 'control.lease', ['duration_ms', 'on_collection_expiry', 'on_raw_expiry', 'on_uplink_expiry']);
  const result: DeviceConfigV3 = {
    schema: pick(o.schema, 'config.schema', [V3_POLICY_SCHEMA]), protocol: pick(o.protocol, 'config.protocol', ['campuspulse/3']),
    policy_id: str(o.policy_id, 'config.policy_id', ID), node_id: str(o.node_id, 'config.node_id', ID),
    revision: num(o.revision, 'config.revision', 1), assignment_generation: num(o.assignment_generation, 'config.assignment_generation', 1),
    collection, local_raw, evidence, uplink, local_queue, resources, custody,
    control: { capability_sha256: str(control.capability_sha256, 'control.capability_sha256', SHA256),
      activation: { boot_id: str(a.boot_id, 'control.activation.boot_id', UUID),
        boundary: pick(a.boundary, 'control.activation.boundary', ['closed_window_and_segment']),
        after_window_seq: num(a.after_window_seq, 'control.activation.after_window_seq', 0, 0xffffffff),
        after_segment_seq: num(a.after_segment_seq, 'control.activation.after_segment_seq', 0, 0xffffffff),
        not_before: utc(a.not_before, 'control.activation.not_before'), expires_at: utc(a.expires_at, 'control.activation.expires_at') },
      lease: { duration_ms: num(l.duration_ms, 'control.lease.duration_ms', 30000, 86400000),
        on_collection_expiry: pick(l.on_collection_expiry, 'control.lease.on_collection_expiry', ['pause', 'continue_until_policy_expiry']),
        on_raw_expiry: pick(l.on_raw_expiry, 'control.lease.on_raw_expiry', ['stop_recording', 'continue_until_policy_expiry']),
        on_uplink_expiry: pick(l.on_uplink_expiry, 'control.lease.on_uplink_expiry', ['pause', 'drain_frozen_until_accept_until']) } },
  };
  if (Date.parse(result.control.activation.not_before) >= Date.parse(result.control.activation.expires_at) ||
      Date.parse(result.control.activation.expires_at) > Date.parse(custody.accept_until)) fail('control.activation.expires_at');
  return result;
}

export function validateDeviceCapabilitiesV3(value: unknown): DeviceCapabilitiesV3 {
  const o = obj(value, 'capabilities', ['schema', 'capability_id', 'node_id', 'boot_id', 'producer_version', 'policy_schemas', 'issued_at', 'expires_at'],
    ['scanner', 'summary', 'features', 'local_raw', 'uplink', 'queue', 'resources']);
  const result: DeviceCapabilitiesV3 = {
    schema: pick(o.schema, 'capabilities.schema', [V3_CAPABILITY_SCHEMA]), capability_id: str(o.capability_id, 'capabilities.capability_id', ID),
    node_id: str(o.node_id, 'capabilities.node_id', ID), boot_id: str(o.boot_id, 'capabilities.boot_id', UUID),
    producer_version: str(o.producer_version, 'capabilities.producer_version'), policy_schemas: labels(o.policy_schemas, 'capabilities.policy_schemas'),
    issued_at: utc(o.issued_at, 'capabilities.issued_at'), expires_at: utc(o.expires_at, 'capabilities.expires_at'),
  };
  if (Date.parse(result.issued_at) >= Date.parse(result.expires_at)) fail('capabilities.expires_at');
  if (Object.hasOwn(o, 'scanner')) {
    if (o.scanner === null) result.scanner = null;
    else {
      const s = obj(o.scanner, 'capabilities.scanner', ['modes', 'phys', 'duplicate_filter', 'min_interval_units', 'max_interval_units']);
      const min = num(s.min_interval_units, 'capabilities.scanner.min_interval_units', 4, 16384);
      result.scanner = { modes: enums(s.modes, 'capabilities.scanner.modes', ['passive', 'active']),
        phys: enums(s.phys, 'capabilities.scanner.phys', ['1m', 'coded']),
        duplicate_filter: unique(array(s.duplicate_filter, 'capabilities.scanner.duplicate_filter', bool, 0, 2), 'capabilities.scanner.duplicate_filter'),
        min_interval_units: min, max_interval_units: num(s.max_interval_units, 'capabilities.scanner.max_interval_units', min, 16384) };
    }
  }
  if (Object.hasOwn(o, 'summary')) {
    if (o.summary === null) result.summary = null;
    else {
      const s = obj(o.summary, 'capabilities.summary', ['max_addresses', 'max_bins', 'max_window_ms']);
      result.summary = { max_addresses: num(s.max_addresses, 'capabilities.summary.max_addresses', 1, 512),
        max_bins: num(s.max_bins, 'capabilities.summary.max_bins', 1, 60), max_window_ms: num(s.max_window_ms, 'capabilities.summary.max_window_ms', 1000, 300000) };
    }
  }
  if (Object.hasOwn(o, 'features')) {
    if (o.features === null) result.features = null;
    else {
      const f = obj(o.features, 'capabilities.features', ['schemas', 'extractor_versions', 'fields', 'populations', 'max_reports_per_window', 'max_bytes_per_window']);
      result.features = { schemas: labels(f.schemas, 'capabilities.features.schemas'), extractor_versions: labels(f.extractor_versions, 'capabilities.features.extractor_versions'),
        fields: enums(f.fields, 'capabilities.features.fields', V3_FEATURE_FIELDS),
        populations: enums(f.populations, 'capabilities.features.populations', ['all_worker_reports', 'deterministic_sample']),
        max_reports_per_window: num(f.max_reports_per_window, 'capabilities.features.max_reports_per_window', 1, 10000000),
        max_bytes_per_window: bytes(f.max_bytes_per_window, 'capabilities.features.max_bytes_per_window') };
    }
  }
  if (Object.hasOwn(o, 'local_raw')) {
    if (o.local_raw === null) result.local_raw = null;
    else {
      const r = obj(o.local_raw, 'capabilities.local_raw', ['formats', 'max_segment_bytes', 'min_sync_interval_ms']);
      result.local_raw = { formats: labels(r.formats, 'capabilities.local_raw.formats'), max_segment_bytes: bytes(r.max_segment_bytes, 'capabilities.local_raw.max_segment_bytes'),
        min_sync_interval_ms: num(r.min_sync_interval_ms, 'capabilities.local_raw.min_sync_interval_ms', 100, 60000) };
    }
  }
  if (Object.hasOwn(o, 'uplink')) {
    if (o.uplink === null) result.uplink = null;
    else {
      const u = obj(o.uplink, 'capabilities.uplink', ['transports', 'streams', 'max_batch_items', 'max_body_bytes', 'max_sample_reports_per_window', 'cpraw_archive']);
      result.uplink = { transports: enums(u.transports, 'capabilities.uplink.transports', ['https', 'mqtt_tls']), streams: enums(u.streams, 'capabilities.uplink.streams', V3_STREAMS),
        max_batch_items: num(u.max_batch_items, 'capabilities.uplink.max_batch_items', 1, 128), max_body_bytes: num(u.max_body_bytes, 'capabilities.uplink.max_body_bytes', 512, 65536),
        max_sample_reports_per_window: num(u.max_sample_reports_per_window, 'capabilities.uplink.max_sample_reports_per_window', 0, 16),
        cpraw_archive: bool(u.cpraw_archive, 'capabilities.uplink.cpraw_archive') };
    }
  }
  if (Object.hasOwn(o, 'queue')) {
    if (o.queue === null) result.queue = null;
    else {
      const q = obj(o.queue, 'capabilities.queue', ['media']);
      result.queue = { media: unique(array(q.media, 'capabilities.queue.media', (v, p) => {
        const m = obj(v, p, ['medium', 'usable_bytes', 'max_items', 'power_loss_recovery']);
        const medium = pick(m.medium, `${p}.medium`, ['flash_journal', 'tf_journal', 'ram']);
        const recovery = bool(m.power_loss_recovery, `${p}.power_loss_recovery`);
        if (medium === 'ram' && recovery) fail(`${p}.power_loss_recovery`);
        return { medium, usable_bytes: bytes(m.usable_bytes, `${p}.usable_bytes`), max_items: num(m.max_items, `${p}.max_items`, 1, 1000000), power_loss_recovery: recovery };
      }, 0, 3), 'capabilities.queue.media', m => m.medium) };
    }
  }
  if (Object.hasOwn(o, 'resources')) {
    if (o.resources === null) result.resources = null;
    else {
      const r = obj(o.resources, 'capabilities.resources', ['max_working_bytes', 'max_storage_write_bytes_per_day', 'tf_usable_bytes']);
      result.resources = { max_working_bytes: bytes(r.max_working_bytes, 'capabilities.resources.max_working_bytes'),
        max_storage_write_bytes_per_day: bytes(r.max_storage_write_bytes_per_day, 'capabilities.resources.max_storage_write_bytes_per_day', 0),
        tf_usable_bytes: r.tf_usable_bytes === null ? null : bytes(r.tf_usable_bytes, 'capabilities.resources.tf_usable_bytes', 0) };
    }
  }
  return result;
}

/** Sort object keys recursively; preserve array order and omission/null distinction. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`campuspulse-v3-canonical-json/1\n${canonical(value)}`);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export const capabilityDigestV3 = (value: unknown) => digest(validateDeviceCapabilitiesV3(value));
export interface FrozenDeviceConfigV3 { schema: 'device-config-envelope/3'; policy: DeviceConfigV3; policy_sha256: string }
export async function freezeDeviceConfigV3(value: unknown): Promise<FrozenDeviceConfigV3> {
  const policy = validateDeviceConfigV3(value);
  return { schema: 'device-config-envelope/3', policy, policy_sha256: await digest(policy) };
}
export async function validateFrozenDeviceConfigV3(value: unknown): Promise<FrozenDeviceConfigV3> {
  const o = obj(value, 'envelope', ['schema', 'policy', 'policy_sha256']);
  pick(o.schema, 'envelope.schema', ['device-config-envelope/3']);
  const frozen = await freezeDeviceConfigV3(o.policy);
  if (str(o.policy_sha256, 'envelope.policy_sha256', SHA256) !== frozen.policy_sha256) fail('envelope.policy_sha256');
  return frozen;
}
/** For raw input bytes: duplicate decoded keys and malformed UTF-8 also fail. */
export function parseDeviceV3Json(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 32768) fail('json');
  try { return parseIngestJson(bytes); } catch { return fail('json'); }
}

export interface V3NegotiationContext {
  node_id: string; boot_id: string; now: string; last_assignment_generation: number;
  closed_window_seq: number; closed_segment_seq: number; window_open: boolean; segment_open: boolean;
}
export type V3IssueCode = 'undeclared_capability' | 'unsupported_capability' | 'resource_limit' | 'identity_mismatch' |
  'capability_digest_mismatch' | 'capabilities_not_current' | 'policy_not_yet_valid' | 'policy_expired' |
  'stale_assignment' | 'boundary_not_ready' | 'separate_archive_policy_required';
export interface V3NegotiationResult {
  state: 'compatible' | 'rejected'; applied: false; requires_device_ack: true;
  policy_sha256: string; issues: { code: V3IssueCode; path: string }[];
}
/** Pure preflight against caller-supplied current state. Not an authenticated activation. */
export async function negotiateDeviceConfigV3(envelope: unknown, capabilityValue: unknown, contextValue: unknown): Promise<V3NegotiationResult> {
  const frozen = await validateFrozenDeviceConfigV3(envelope), p = frozen.policy;
  const caps = validateDeviceCapabilitiesV3(capabilityValue);
  const c = obj(contextValue, 'context', ['node_id', 'boot_id', 'now', 'last_assignment_generation', 'closed_window_seq', 'closed_segment_seq', 'window_open', 'segment_open']);
  const context: V3NegotiationContext = {
    node_id: str(c.node_id, 'context.node_id', ID), boot_id: str(c.boot_id, 'context.boot_id', UUID), now: utc(c.now, 'context.now'),
    last_assignment_generation: num(c.last_assignment_generation, 'context.last_assignment_generation'),
    closed_window_seq: num(c.closed_window_seq, 'context.closed_window_seq', 0, 0xffffffff),
    closed_segment_seq: num(c.closed_segment_seq, 'context.closed_segment_seq', 0, 0xffffffff),
    window_open: bool(c.window_open, 'context.window_open'), segment_open: bool(c.segment_open, 'context.segment_open'),
  };
  const issues: V3NegotiationResult['issues'] = [];
  const issue = (code: V3IssueCode, path: string) => { if (!issues.some(i => i.code === code && i.path === path)) issues.push({ code, path }); };
  const unsupported = (ok: boolean, path: string) => { if (!ok) issue('unsupported_capability', path); };
  const limit = (ok: boolean, path: string) => { if (!ok) issue('resource_limit', path); };
  function capability<K extends 'scanner' | 'summary' | 'features' | 'local_raw' | 'uplink' | 'queue' | 'resources'>(key: K): NonNullable<DeviceCapabilitiesV3[K]> | undefined {
    const cap = caps[key];
    if (cap === undefined || cap === null) { issue(cap === undefined ? 'undeclared_capability' : 'unsupported_capability', `capabilities.${key}`); return undefined; }
    return cap as NonNullable<DeviceCapabilitiesV3[K]>;
  }
  const now = Date.parse(context.now), activation = p.control.activation;
  if (p.node_id !== context.node_id || caps.node_id !== context.node_id || caps.boot_id !== context.boot_id || activation.boot_id !== context.boot_id) issue('identity_mismatch', 'context');
  if (await capabilityDigestV3(caps) !== p.control.capability_sha256) issue('capability_digest_mismatch', 'control.capability_sha256');
  if (now < Date.parse(caps.issued_at) || now >= Date.parse(caps.expires_at)) issue('capabilities_not_current', 'capabilities');
  if (now < Date.parse(activation.not_before)) issue('policy_not_yet_valid', 'control.activation.not_before');
  if (now >= Date.parse(activation.expires_at)) issue('policy_expired', 'control.activation.expires_at');
  if (p.assignment_generation <= context.last_assignment_generation) issue('stale_assignment', 'config.assignment_generation');
  if (context.window_open || context.segment_open || context.closed_window_seq < activation.after_window_seq || context.closed_segment_seq < activation.after_segment_seq) issue('boundary_not_ready', 'control.activation');
  unsupported(caps.policy_schemas.includes(V3_POLICY_SCHEMA), 'config.schema');
  if (p.collection.enabled) {
    const scanner = capability('scanner'), scan = p.collection.scan, s = p.collection.summary;
    if (scanner) {
      unsupported(scanner.modes.includes(scan.mode), 'collection.scan.mode');
      unsupported(scan.phys.every(phy => scanner.phys.includes(phy)), 'collection.scan.phys');
      unsupported(scanner.duplicate_filter.includes(scan.duplicate_filter), 'collection.scan.duplicate_filter');
      limit(scan.interval_units >= scanner.min_interval_units && scan.interval_units <= scanner.max_interval_units, 'collection.scan.interval_units');
    }
    if (s.enabled) {
      const summary = capability('summary');
      if (summary) {
        limit(s.max_addresses <= summary.max_addresses, 'collection.summary.max_addresses');
        limit(s.window_ms / s.bin_ms <= summary.max_bins, 'collection.summary.bin_ms');
        limit(s.window_ms <= summary.max_window_ms, 'collection.summary.window_ms');
      }
    }
  }
  if (p.evidence.mode === 'features') {
    const f = capability('features'), e = p.evidence;
    if (f) {
      unsupported(f.schemas.includes(e.schema), 'evidence.schema');
      unsupported(f.extractor_versions.includes(e.extractor_version), 'evidence.extractor_version');
      unsupported(f.populations.includes(e.population), 'evidence.population');
      unsupported(e.fields.every(field => f.fields.includes(field.kind)), 'evidence.fields');
      limit(e.max_reports_per_window <= f.max_reports_per_window, 'evidence.max_reports_per_window');
      limit(e.max_bytes_per_window <= f.max_bytes_per_window, 'evidence.max_bytes_per_window');
    }
  }
  if (p.local_raw.mode === 'tf_cpraw') {
    const r = capability('local_raw');
    if (r) {
      unsupported(r.formats.includes(p.local_raw.format), 'local_raw.format');
      limit(p.local_raw.max_segment_bytes <= r.max_segment_bytes, 'local_raw.max_segment_bytes');
      limit(p.local_raw.sync_interval_ms >= r.min_sync_interval_ms, 'local_raw.sync_interval_ms');
    }
  }
  if (p.uplink.enabled) {
    const u = capability('uplink'), uplink = p.uplink;
    if (u) {
      unsupported(u.transports.includes(uplink.transport), 'uplink.transport');
      unsupported(uplink.streams.every(stream => u.streams.includes(stream)), 'uplink.streams');
      limit(uplink.max_batch_items <= u.max_batch_items, 'uplink.max_batch_items');
      limit(uplink.max_body_bytes <= u.max_body_bytes, 'uplink.max_body_bytes');
      if (uplink.raw_sample.mode === 'sampled') limit(uplink.raw_sample.max_reports_per_window <= u.max_sample_reports_per_window, 'uplink.raw_sample.max_reports_per_window');
      if (uplink.archive.mode === 'separate_policy') unsupported(u.cpraw_archive, 'uplink.archive');
    }
    // A reference alone is not archive-upload authorization. No resolver exists here.
    if (uplink.archive.mode === 'separate_policy') issue('separate_archive_policy_required', 'uplink.archive');
  }
  if (p.local_queue.mode !== 'disabled') {
    const q = capability('queue'), queue = p.local_queue;
    if (q) {
      const medium = q.media.find(m => m.medium === queue.medium);
      unsupported(!!medium, 'local_queue.medium');
      if (medium) {
        limit(queue.max_bytes <= medium.usable_bytes, 'local_queue.max_bytes');
        limit(queue.max_items <= medium.max_items, 'local_queue.max_items');
        if (queue.mode === 'durable') unsupported(medium.power_loss_recovery, 'local_queue.recovery');
      }
    }
  }
  const r = capability('resources');
  if (r) {
    limit(p.resources.working_bytes <= r.max_working_bytes, 'resources.working_bytes');
    limit(p.resources.storage_write_bytes_per_day <= r.max_storage_write_bytes_per_day, 'resources.storage_write_bytes_per_day');
    const tfBytes = (p.local_raw.mode === 'tf_cpraw' ? p.local_raw.max_total_bytes + p.local_raw.min_free_bytes : 0) +
      (p.local_queue.mode !== 'disabled' && p.local_queue.medium === 'tf_journal' ? p.local_queue.max_bytes : 0);
    if (tfBytes > 0) {
      unsupported(r.tf_usable_bytes !== null, 'resources.tf_usable_bytes');
      if (r.tf_usable_bytes !== null) limit(tfBytes <= r.tf_usable_bytes, 'resources.tf_usable_bytes');
    }
  }
  return { state: issues.length ? 'rejected' : 'compatible', applied: false, requires_device_ack: true, policy_sha256: frozen.policy_sha256, issues };
}

/** Evaluate explicit lease actions without mutating data, queues or applied state. */
export function evaluateDeviceV3Lease(value: unknown, nowValue: unknown, elapsedSinceContactValue: unknown) {
  const p = validateDeviceConfigV3(value), now = Date.parse(utc(nowValue, 'now'));
  const elapsed = num(elapsedSinceContactValue, 'elapsed_since_contact_ms');
  const before = now < Date.parse(p.control.activation.not_before), expired = now >= Date.parse(p.control.activation.expires_at);
  const leaseExpired = elapsed >= p.control.lease.duration_ms;
  return {
    collection: p.collection.enabled && !before && !expired && (!leaseExpired || p.control.lease.on_collection_expiry === 'continue_until_policy_expiry') ? 'permitted' : 'paused',
    local_raw: p.local_raw.mode === 'tf_cpraw' && !before && !expired && (!leaseExpired || p.control.lease.on_raw_expiry === 'continue_until_policy_expiry') ? 'permitted' : 'stopped',
    uplink: p.uplink.enabled && !before && now < Date.parse(p.custody.accept_until) &&
      ((!expired && !leaseExpired) || p.control.lease.on_uplink_expiry === 'drain_frozen_until_accept_until') ?
      (expired || leaseExpired ? 'frozen_only' : 'permitted') : 'paused',
    preserve_unacknowledged: true as const,
  };
}

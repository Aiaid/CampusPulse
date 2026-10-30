/** Pure OFFLINE subset of the proposed ble-feature-evidence/1, not a wire route.
 * Only window-scoped tokens are supported; no MAC permission is implied. There
 * is no authentication, custody, batch receipt, activation or inference here.
 *
 * Existing device-inference inputs have service_uuids16, appearances and
 * manufacturer_company_ids. These correspond to a subset of the lists below,
 * but cannot carry sampling, support, clock, overflow or scope provenance.
 * Do not cast these records to DeviceProtocolFeatures or invent the existing
 * parser's extractor version. A reviewed, provenance-preserving adapter is
 * required before classification; names/templates have no current counterpart.
 */
import { parseIngestJson } from './ingest-validation';
import { validateFrozenDeviceConfigV3, V3_FEATURE_FIELDS } from './device-v3-config';

export const V3_FEATURE_EVIDENCE_SCHEMA = 'ble-feature-evidence/1' as const;
type FeatureKind = typeof V3_FEATURE_FIELDS[number];
type Unavailable = { value: number | null; reason: 'not_provided' | null };
type Version = { value: string | null; reason: 'not_supported' | 'unavailable' | null };
interface SourceTime { mono_ms: number; utc_ms: number | null; clock_epoch: number; uncertainty_ms: number | null }
export interface V3FeatureValue {
  value: string | number;
  /** Counts overlap between features and must never be summed as report totals. */
  support_reports: number;
  adv_reports: number;
  scan_response_reports: number;
  conflicting: boolean;
}
export interface V3FeatureList {
  /** Missing list = not extracted; null = explicitly unavailable; [] = examined
   * with no retained value. Neither [] nor zero overflow implies RF absence. */
  values: V3FeatureValue[] | null;
  unavailable_reason: 'not_supported' | 'unavailable' | null;
  overflow: number | null;
  overflow_reason: 'not_measured' | null;
}
export interface FeatureEvidenceV3 {
  schema: typeof V3_FEATURE_EVIDENCE_SCHEMA;
  extractor_version: string;
  ruleset?: Version;
  dictionary?: Version;
  scope: {
    node_id: string; boot_id: string; placement_id: string | null;
    capture_config_id: string; policy_sha256: string;
    dataset: 'field' | 'demo' | 'controlled_test' | 'research_unassigned'; window_seq: number;
  };
  identity: { scheme: 'window_token'; token: string; address_type: 'public' | 'random' | 'public_identity' | 'random_identity' | 'unknown' };
  observed_time: { start: SourceTime; end: SourceTime };
  population: 'all_worker_reports' | 'deterministic_sample';
  sampling: null | { selection: 'seq_mod_n_eq_0'; every_n: number; max_reports_per_window: number };
  extraction_state: 'complete' | 'partial';
  reports: {
    available_reports: number; examined_reports: number; parsed_reports: number;
    malformed_reports: number; unsupported_reports: number; unexamined_reports: number;
    parsed_adv_reports: number; parsed_scan_response_reports: number;
  };
  /** Separate source claims retain their scopes. Never sum these as loss total. */
  source_counters: {
    identifier_worker_reports: Unavailable; window_reports_seen: Unavailable;
    window_reports_aggregated: Unavailable; window_queue_drops: Unavailable;
    window_address_overflow: Unavailable; identifier_intentional_skips: Unavailable;
    identifier_pressure_skips: Unavailable;
  };
  features: Partial<Record<FeatureKind, V3FeatureList>>;
}
/** Caller-supplied reviewed public dictionary, not a device-provided registry.
 * Empty registries deliberately allow no fixed pattern/template IDs. */
export interface V3FeatureRegistry {
  dictionary_version: string;
  name_pattern_ids: readonly string[];
  template_ids: readonly string[];
}
export class DeviceV3EvidenceError extends Error {
  constructor(readonly path: string) { super(`Invalid v3 feature field: ${path}.`); this.name = 'DeviceV3EvidenceError'; }
}
function fail(path: string): never { throw new DeviceV3EvidenceError(path); }
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA = /^[0-9a-f]{64}$/;
const BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_REPORTS = 10000000;
const limits: Record<FeatureKind, number> = { service_uuids: 16, company_ids: 16, appearance: 8, name_pattern_ids: 16, template_ids: 16 };
function obj(v: unknown, p: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(p);
  const o = v as Record<string, unknown>;
  // Do not include unknown key names in errors: those too may contain a secret.
  if (required.some(k => !Object.hasOwn(o, k)) || Object.keys(o).some(k => !required.includes(k) && !optional.includes(k))) fail(p);
  return o;
}
function num(v: unknown, p: string, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail(p);
}
function str(v: unknown, p: string, re = LABEL): string { return typeof v === 'string' && re.test(v) ? v : fail(p); }
function pick<const T extends string>(v: unknown, p: string, allowed: readonly T[]): T {
  return typeof v === 'string' && allowed.includes(v as T) ? v as T : fail(p);
}
function version(v: unknown, p: string): Version {
  const o = obj(v, p, ['value', 'reason']);
  if (o.value === null) return { value: null, reason: pick(o.reason, p, ['not_supported', 'unavailable']) };
  if (o.reason !== null) fail(p);
  return { value: str(o.value, p), reason: null };
}
function claim(v: unknown, p: string): Unavailable {
  const o = obj(v, p, ['value', 'reason']);
  if (o.value === null) { if (o.reason !== 'not_provided') fail(p); return { value: null, reason: 'not_provided' }; }
  if (o.reason !== null) fail(p);
  return { value: num(o.value, p, MAX_REPORTS), reason: null };
}
function time(v: unknown, p: string): SourceTime {
  const o = obj(v, p, ['mono_ms', 'utc_ms', 'clock_epoch', 'uncertainty_ms']);
  const utc = o.utc_ms === null ? null : num(o.utc_ms, p, 8640000000000000);
  const uncertainty = o.uncertainty_ms === null ? null : num(o.uncertainty_ms, p);
  if (utc === null && uncertainty !== null) fail(p);
  return { mono_ms: num(o.mono_ms, p), utc_ms: utc, clock_epoch: num(o.clock_epoch, p), uncertainty_ms: uncertainty };
}
function registry(value: V3FeatureRegistry): V3FeatureRegistry {
  const o = obj(value, 'registry', ['dictionary_version', 'name_pattern_ids', 'template_ids']);
  const list = (v: unknown): string[] => {
    if (!Array.isArray(v) || v.length > 256) return fail('registry');
    const entries = v.map(v => str(v, 'registry'));
    if (new Set(entries).size !== entries.length) fail('registry');
    return entries;
  };
  return { dictionary_version: str(o.dictionary_version, 'registry'), name_pattern_ids: list(o.name_pattern_ids), template_ids: list(o.template_ids) };
}
function featureList(v: unknown, kind: FeatureKind, r: FeatureEvidenceV3['reports'], reg: V3FeatureRegistry): V3FeatureList {
  const p = `features.${kind}`;
  const o = obj(v, p, ['values', 'unavailable_reason', 'overflow', 'overflow_reason']);
  const overflow = o.overflow === null ? null : num(o.overflow, p);
  if (overflow === null ? o.overflow_reason !== 'not_measured' : o.overflow_reason !== null) fail(p);
  if (o.values === null) {
    if (overflow !== null) fail(p);
    return { values: null, unavailable_reason: pick(o.unavailable_reason, p, ['not_supported', 'unavailable']), overflow, overflow_reason: 'not_measured' };
  }
  if (o.unavailable_reason !== null || !Array.isArray(o.values) || o.values.length > limits[kind]) fail(p);
  const values = (o.values as unknown[]).map((v): V3FeatureValue => {
    const x = obj(v, p, ['value', 'support_reports', 'adv_reports', 'scan_response_reports', 'conflicting']);
    let value: string | number;
    if (kind === 'service_uuids') value = str(x.value, p, UUID);
    else if (kind === 'company_ids' || kind === 'appearance') value = num(x.value, p, 65535);
    else {
      value = str(x.value, p);
      if (!reg[kind].includes(value)) fail(p);
    }
    const support_reports = num(x.support_reports, p, r.parsed_reports, 1);
    const adv_reports = num(x.adv_reports, p, r.parsed_adv_reports);
    const scan_response_reports = num(x.scan_response_reports, p, r.parsed_scan_response_reports);
    if (adv_reports + scan_response_reports !== support_reports || typeof x.conflicting !== 'boolean') fail(p);
    return { value, support_reports, adv_reports, scan_response_reports, conflicting: x.conflicting };
  });
  if (new Set(values.map(v => v.value)).size !== values.length) fail(p);
  return { values, unavailable_reason: null, overflow, overflow_reason: overflow === null ? 'not_measured' : null };
}

export function validateFeatureEvidenceV3(value: unknown, registryValue: V3FeatureRegistry): FeatureEvidenceV3 {
  const reg = registry(registryValue);
  const o = obj(value, 'evidence', ['schema', 'extractor_version', 'scope', 'identity', 'observed_time', 'population', 'sampling',
    'extraction_state', 'reports', 'source_counters', 'features'], ['ruleset', 'dictionary']);
  const s = obj(o.scope, 'scope', ['node_id', 'boot_id', 'placement_id', 'capture_config_id', 'policy_sha256', 'dataset', 'window_seq']);
  const i = obj(o.identity, 'identity', ['scheme', 'token', 'address_type']);
  const t = obj(o.observed_time, 'observed_time', ['start', 'end']);
  const start = time(t.start, 'observed_time.start'), end = time(t.end, 'observed_time.end');
  if (start.mono_ms >= end.mono_ms || start.clock_epoch !== end.clock_epoch ||
      (start.utc_ms === null) !== (end.utc_ms === null) || (start.utc_ms !== null && end.utc_ms! < start.utc_ms)) fail('observed_time');
  const r = obj(o.reports, 'reports', ['available_reports', 'examined_reports', 'parsed_reports', 'malformed_reports',
    'unsupported_reports', 'unexamined_reports', 'parsed_adv_reports', 'parsed_scan_response_reports']);
  const reports: FeatureEvidenceV3['reports'] = {
    available_reports: num(r.available_reports, 'reports', MAX_REPORTS), examined_reports: num(r.examined_reports, 'reports', MAX_REPORTS),
    parsed_reports: num(r.parsed_reports, 'reports', MAX_REPORTS), malformed_reports: num(r.malformed_reports, 'reports', MAX_REPORTS),
    unsupported_reports: num(r.unsupported_reports, 'reports', MAX_REPORTS), unexamined_reports: num(r.unexamined_reports, 'reports', MAX_REPORTS),
    parsed_adv_reports: num(r.parsed_adv_reports, 'reports', MAX_REPORTS), parsed_scan_response_reports: num(r.parsed_scan_response_reports, 'reports', MAX_REPORTS),
  };
  if (reports.examined_reports !== reports.parsed_reports + reports.malformed_reports + reports.unsupported_reports ||
      reports.available_reports !== reports.examined_reports + reports.unexamined_reports ||
      reports.parsed_reports !== reports.parsed_adv_reports + reports.parsed_scan_response_reports) fail('reports');
  const sc = obj(o.source_counters, 'source_counters', ['identifier_worker_reports', 'window_reports_seen', 'window_reports_aggregated',
    'window_queue_drops', 'window_address_overflow', 'identifier_intentional_skips', 'identifier_pressure_skips']);
  const source_counters: FeatureEvidenceV3['source_counters'] = {
    identifier_worker_reports: claim(sc.identifier_worker_reports, 'source_counters'), window_reports_seen: claim(sc.window_reports_seen, 'source_counters'),
    window_reports_aggregated: claim(sc.window_reports_aggregated, 'source_counters'), window_queue_drops: claim(sc.window_queue_drops, 'source_counters'),
    window_address_overflow: claim(sc.window_address_overflow, 'source_counters'), identifier_intentional_skips: claim(sc.identifier_intentional_skips, 'source_counters'),
    identifier_pressure_skips: claim(sc.identifier_pressure_skips, 'source_counters'),
  };
  const population = pick(o.population, 'population', ['all_worker_reports', 'deterministic_sample']);
  let sampling: FeatureEvidenceV3['sampling'] = null;
  if (population === 'all_worker_reports') { if (o.sampling !== null) fail('sampling'); }
  else {
    const sample = obj(o.sampling, 'sampling', ['selection', 'every_n', 'max_reports_per_window']);
    sampling = { selection: pick(sample.selection, 'sampling', ['seq_mod_n_eq_0']), every_n: num(sample.every_n, 'sampling', 0xffffffff, 1),
      max_reports_per_window: num(sample.max_reports_per_window, 'sampling', MAX_REPORTS, 1) };
    if (reports.examined_reports > sampling.max_reports_per_window) fail('sampling');
  }
  const workerReports = source_counters.identifier_worker_reports.value;
  if (workerReports !== null && (reports.available_reports > workerReports ||
      (population === 'all_worker_reports' && reports.available_reports !== workerReports))) fail('source_counters');
  const seen = source_counters.window_reports_seen.value, aggregated = source_counters.window_reports_aggregated.value;
  if ((seen !== null && (reports.available_reports > seen || (workerReports !== null && workerReports > seen))) ||
      (seen !== null && aggregated !== null && aggregated > seen)) fail('source_counters');
  for (const k of ['identifier_intentional_skips', 'identifier_pressure_skips'] as const) {
    const n = source_counters[k].value;
    if (n !== null && n > reports.unexamined_reports) fail('source_counters');
  }
  const f = obj(o.features, 'features', [], V3_FEATURE_FIELDS);
  const features: FeatureEvidenceV3['features'] = {};
  for (const kind of V3_FEATURE_FIELDS) if (Object.hasOwn(f, kind)) features[kind] = featureList(f[kind], kind, reports, reg);
  const result: FeatureEvidenceV3 = {
    schema: pick(o.schema, 'schema', [V3_FEATURE_EVIDENCE_SCHEMA]), extractor_version: str(o.extractor_version, 'extractor_version'),
    scope: { node_id: str(s.node_id, 'scope.node_id', ID), boot_id: str(s.boot_id, 'scope.boot_id', BOOT),
      placement_id: s.placement_id === null ? null : str(s.placement_id, 'scope.placement_id', ID),
      capture_config_id: str(s.capture_config_id, 'scope.capture_config_id', ID), policy_sha256: str(s.policy_sha256, 'scope.policy_sha256', SHA),
      dataset: pick(s.dataset, 'scope.dataset', ['field', 'demo', 'controlled_test', 'research_unassigned']), window_seq: num(s.window_seq, 'scope.window_seq', 0xffffffff) },
    identity: { scheme: pick(i.scheme, 'identity.scheme', ['window_token']), token: str(i.token, 'identity.token', /^[0-9a-f]{32}$/),
      address_type: pick(i.address_type, 'identity.address_type', ['public', 'random', 'public_identity', 'random_identity', 'unknown']) },
    observed_time: { start, end }, population, sampling, extraction_state: pick(o.extraction_state, 'extraction_state', ['complete', 'partial']), reports, source_counters, features,
  };
  if (Object.hasOwn(o, 'ruleset')) result.ruleset = version(o.ruleset, 'ruleset');
  if (Object.hasOwn(o, 'dictionary')) result.dictionary = version(o.dictionary, 'dictionary');
  if ((features.name_pattern_ids?.values !== null && features.name_pattern_ids !== undefined) ||
      (features.template_ids?.values !== null && features.template_ids !== undefined)) {
    if (result.dictionary?.value !== reg.dictionary_version) fail('dictionary');
  }
  if (result.extraction_state === 'complete' && (reports.unexamined_reports || reports.malformed_reports || reports.unsupported_reports ||
      source_counters.identifier_intentional_skips.value !== 0 || source_counters.identifier_pressure_skips.value !== 0 ||
      Object.values(features).some(f => f.values === null || f.overflow !== 0))) fail('extraction_state');
  return result;
}

/** Assembled offline window, not an ingest batch (128 items / 65,536 bytes remain
 * transport ceilings). Call once with the whole supplied window; splitting input
 * across calls is not durable cross-batch budget enforcement. */
export async function validateFeatureEvidenceWindowV3(value: unknown, envelope: unknown, registryValue: V3FeatureRegistry) {
  const frozen = await validateFrozenDeviceConfigV3(envelope), p = frozen.policy;
  if (p.evidence.mode !== 'features' || !p.collection.summary.enabled || p.custody.association_scope !== 'window') fail('policy');
  if (!Array.isArray(value) || value.length === 0 || value.length > p.collection.summary.max_addresses || value.length > 512) fail('window');
  const records = value.map(v => validateFeatureEvidenceV3(v, registryValue));
  const first = records[0];
  let examined = 0, available = 0;
  const identities = new Set<string>();
  for (const r of records) {
    if (JSON.stringify(r.scope) !== JSON.stringify(first.scope) || JSON.stringify(r.observed_time) !== JSON.stringify(first.observed_time)) fail('window.scope');
    if (r.scope.node_id !== p.node_id || r.scope.boot_id !== p.control.activation.boot_id || r.scope.capture_config_id !== p.policy_id ||
        r.scope.policy_sha256 !== frozen.policy_sha256 || r.scope.placement_id !== p.custody.placement_id || r.scope.dataset !== p.custody.dataset ||
        r.scope.window_seq <= p.control.activation.after_window_seq || r.extractor_version !== p.evidence.extractor_version || r.population !== p.evidence.population) fail('window.policy');
    if (r.observed_time.end.mono_ms - r.observed_time.start.mono_ms !== p.collection.summary.window_ms) fail('window.observed_time');
    if (r.observed_time.start.utc_ms !== null && (r.observed_time.start.utc_ms < Date.parse(p.control.activation.not_before) ||
        r.observed_time.end.utc_ms! > Date.parse(p.control.activation.expires_at))) fail('window.observed_time');
    if (r.sampling && (r.sampling.every_n !== p.evidence.sample_every_n || r.sampling.max_reports_per_window !== p.evidence.max_reports_per_window)) fail('window.sampling');
    const identity = `${r.identity.token}/${r.identity.address_type}`;
    if (identities.has(identity)) fail('window.identity');
    identities.add(identity);
    for (const kind of V3_FEATURE_FIELDS) {
      const list = r.features[kind], fieldPolicy = p.evidence.fields.find(f => f.kind === kind);
      if (list && (!fieldPolicy || (list.values !== null && list.values.length > fieldPolicy.max_values_per_identifier))) fail('window.features');
      if (r.extraction_state === 'complete' && fieldPolicy && !list) fail('window.extraction_state');
    }
    for (const key of ['window_reports_seen', 'window_reports_aggregated', 'window_queue_drops', 'window_address_overflow'] as const) {
      if (JSON.stringify(r.source_counters[key]) !== JSON.stringify(first.source_counters[key])) fail('window.source_counters');
    }
    examined += r.reports.examined_reports;
    available += r.reports.available_reports;
  }
  if (examined > p.evidence.max_reports_per_window || new TextEncoder().encode(JSON.stringify(records)).byteLength > p.evidence.max_bytes_per_window) fail('window.budget');
  const seen = first.source_counters.window_reports_seen.value;
  const workerReports = records.map(r => r.source_counters.identifier_worker_reports.value);
  if (seen !== null && (available > seen || (workerReports.every((n): n is number => n !== null) && workerReports.reduce((a, b) => a + b, 0) > seen))) fail('window.source_counters');
  return { schema: 'ble-feature-window-offline/1' as const, scope: 'supplied_window_identifiers' as const,
    window_completeness: 'not_established' as const, records, retained_identifiers: records.length, estimated_total: null,
    limitations: ['offline_validation_only', 'producer_claims_not_verified', 'not_radio_complete', 'not_a_device_or_people_count',
      'no_classification_adapter', ...(first.population === 'deterministic_sample' ? ['deterministic_sample_only'] : [])] };
}

/** Exact bytes reject duplicate decoded keys and malformed UTF-8. No route uses
 * this helper; parsing does not establish batch identity, receipt or custody. */
export function parseFeatureEvidenceV3Json(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 65536) fail('json');
  try { return parseIngestJson(bytes); } catch { return fail('json'); }
}

/** Validation for the campuspulse/1 wire format. No storage or authorization here. */
export type IngestStream = 'ble_windows' | 'ble_reports' | 'node_status';
export type Dataset = 'field' | 'controlled_test' | 'demo';
export type RawMode = 'off' | 'all' | 'sampled';
export type IdentityScheme = 'mac' | 'window_token' | 'none';

export interface CaptureConfig {
  capture_config_id: string;
  node_id: string;
  placement_id: string;
  dataset: Dataset;
  capture_profile: 'metrics' | 'research_raw';
  allowed_streams: IngestStream[];
  scan: {
    stack: 'nimble'; adapter_version: string; mode: 'passive' | 'active';
    interval_ms: number; window_ms: number; filter_duplicates: boolean; host_filter: 'none';
  };
  raw_capture: { mode: RawMode; sample_every_n?: number; selection?: 'seq_mod_n_eq_0' };
  identity_scheme: IdentityScheme;
  accept_until: string;
  upload_policy: {
    max_items: number; max_body_bytes: number; flush_max_age_ms: number;
    warn_pct: number; raw_pause_pct: number; critical_pct: number; resume_pct: number;
    overload_action: 'pause_raw' | 'pause_scan';
  };
}

export interface IngestTime {
  mono_ms: number; utc_ms: number | null; clock_epoch: number; uncertainty_ms: number | null;
}
interface BaseItem { seq: number; time: IngestTime }
export interface BleWindow extends BaseItem {
  duration_ms: number; scan_enabled_ms: number; reports_seen: number;
  reports_aggregated: number; aggregation_drops: number; adv_reports: number;
  scan_response_reports: number; visible_identifiers: number;
  unique_table_capacity: number; unique_table_overflow: boolean;
  rssi: { samples: number; min_dbm: number | null; max_dbm: number | null; mean_dbm: number | null };
  raw_capture: { mode: RawMode; selected_reports: number; intentional_skips: number; pressure_skips: number; drops: number };
  indices?: { metric: 'report_rate'; value: number; unit: 'reports_per_scan_enabled_second'; algorithm_id: 'report-rate-v1'; calibration_id: null }[];
  quality_flags: string[];
}
export type ReportIdentity =
  | { scheme: 'mac'; address: string; address_type: AddressType }
  | { scheme: 'window_token'; token: string; address_type: AddressType }
  | { scheme: 'none' };
export type AddressType = 'public' | 'random' | 'public_identity' | 'random_identity' | 'unknown';
export interface BleReport extends BaseItem {
  window_seq: number; identity: ReportIdentity; rssi_dbm: number | null;
  report_type: 'adv_ind' | 'adv_direct_ind' | 'adv_scan_ind' | 'adv_nonconn_ind' | 'scan_rsp' | 'unknown';
  report_type_code: number; format: 'legacy_ad'; payload_length: number; payload_hex: string;
}
export interface NodeStatus extends BaseItem {
  uptime_ms: number; scan_state: string; wifi_state: string;
  free_heap_bytes: number; queue_pending: Record<IngestStream, number>;
  queue_capacity: Record<IngestStream, number>; storage_free_bytes: number;
  raw_capture_state: string; battery_mv?: number; wifi_rssi_dbm?: number;
  loss_totals: {
    aggregation_drops: number; raw_queue_drops: number; storage_drops: number;
    windows_dropped: number; upload_failures: number; ack_failures: number;
    status_samples_coalesced: number; raw_pressure_skips: number;
  };
  buffer_health: {
    log_budget_bytes: number; used_bytes: number; unacked_bytes: number; reclaimable_bytes: number;
    incoming_local_Bps: number | null; newly_acknowledged_local_Bps: number | null;
    time_to_full_s: number | null; growth_state: string; pressure_level: string;
    pause_reason: string | null; raw_paused_ms: number; pre_pause_incoming_local_Bps: number | null;
  };
}
export type IngestItem = BleWindow | BleReport | NodeStatus;
interface Envelope<S extends IngestStream, T extends IngestItem> {
  protocol: 'campuspulse/1'; batch_id: string; node_id: string; boot_id: string;
  placement_id: string; capture_config_id: string; dataset: Dataset;
  stream: S; firmware_version: string; items: T[];
}
export type IngestBatch = Envelope<'ble_windows', BleWindow> | Envelope<'ble_reports', BleReport> | Envelope<'node_status', NodeStatus>;

export class IngestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'IngestError';
    this.status = status;
    this.code = code;
  }
}
const malformed = (code: string) => new IngestError(400, code, 'Invalid JSON request body.');
const invalid = (path: string): never => { throw new IngestError(422, 'invalid_ingest', `Invalid field: ${path}.`); };

/** Scan JSON grammar before JSON.parse so duplicate decoded keys cannot be silently overwritten. */
export function parseIngestJson(bytes: Uint8Array): unknown {
  let input: string;
  try { input = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw malformed('invalid_utf8'); }
  let i = 0;
  const space = () => { while (i < input.length && /[\x20\t\r\n]/.test(input[i])) i++; };
  const string = (): string => {
    const start = i++;
    while (i < input.length) {
      const c = input[i++];
      if (c === '"') {
        try { return JSON.parse(input.slice(start, i)) as string; }
        catch { throw malformed('invalid_json'); }
      }
      if (c === '\\') {
        if (i >= input.length) throw malformed('invalid_json');
        if (input[i] === 'u') i += 5;
        else i++;
      } else if (c.charCodeAt(0) < 0x20) throw malformed('invalid_json');
    }
    throw malformed('invalid_json');
  };
  const value = (depth: number): void => {
    if (depth > 64) throw malformed('invalid_json');
    space();
    const c = input[i];
    if (c === '{') {
      i++; space();
      const seen = new Set<string>();
      if (input[i] === '}') { i++; return; }
      while (true) {
        if (input[i] !== '"') throw malformed('invalid_json');
        const key = string();
        if (seen.has(key)) throw malformed('duplicate_json_key');
        seen.add(key); space();
        if (input[i++] !== ':') throw malformed('invalid_json');
        value(depth + 1); space();
        if (input[i] === '}') { i++; return; }
        if (input[i++] !== ',') throw malformed('invalid_json');
        space();
      }
    }
    if (c === '[') {
      i++; space();
      if (input[i] === ']') { i++; return; }
      while (true) {
        value(depth + 1); space();
        if (input[i] === ']') { i++; return; }
        if (input[i++] !== ',') throw malformed('invalid_json');
      }
    }
    if (c === '"') { string(); return; }
    const token = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(input.slice(i));
    if (!token) throw malformed('invalid_json');
    i += token[0].length;
  };
  value(0); space();
  if (i !== input.length) throw malformed('invalid_json');
  try { return JSON.parse(input) as unknown; }
  catch { throw malformed('invalid_json'); }
}

type ObjectValue = Record<string, unknown>;
const object = (v: unknown, path: string, required: string[], optional: string[] = []): ObjectValue => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) invalid(path);
  const o = v as ObjectValue;
  for (const key of required) if (!Object.hasOwn(o, key)) invalid(`${path}.${key}`);
  for (const key of Object.keys(o)) if (!required.includes(key) && !optional.includes(key)) invalid(path);
  return o;
};
const str = (v: unknown, path: string, re: RegExp): string => typeof v === 'string' && re.test(v) ? v : invalid(path);
const oneOf = <T extends string>(v: unknown, path: string, values: readonly T[]): T =>
  typeof v === 'string' && values.includes(v as T) ? v as T : invalid(path);
const int = (v: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : invalid(path);
const num = (v: unknown, path: string, min = 0, max = Number.MAX_VALUE): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : invalid(path);
const bool = (v: unknown, path: string): boolean => typeof v === 'boolean' ? v : invalid(path);
const nullableInt = (v: unknown, path: string, min = 0): number | null => v === null ? null : int(v, path, min);
const nullableNum = (v: unknown, path: string, min = 0): number | null => v === null ? null : num(v, path, min);
const idRe = /^[a-z0-9_-]{1,64}$/;
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const labelRe = /^[a-z][a-z0-9_]{0,63}$/;
const rawModes = ['off', 'all', 'sampled'] as const;
const streams = ['ble_windows', 'ble_reports', 'node_status'] as const;
const addressTypes = ['public', 'random', 'public_identity', 'random_identity', 'unknown'] as const;

/** Validate a trusted registry row before using it as authorization policy. */
export function validateCaptureConfig(value: unknown): CaptureConfig {
  const o = object(value, 'config', ['capture_config_id','node_id','placement_id','dataset','capture_profile','allowed_streams','scan','raw_capture','identity_scheme','accept_until','upload_policy']);
  const capture_config_id = str(o.capture_config_id, 'config.capture_config_id', idRe);
  const node_id = str(o.node_id, 'config.node_id', idRe);
  const placement_id = str(o.placement_id, 'config.placement_id', idRe);
  const dataset = oneOf(o.dataset, 'config.dataset', ['field','controlled_test','demo']);
  const capture_profile = oneOf(o.capture_profile, 'config.capture_profile', ['metrics','research_raw']);
  if (!Array.isArray(o.allowed_streams) || o.allowed_streams.length < 2 || o.allowed_streams.length > 3) invalid('config.allowed_streams');
  const allowed_streams = (o.allowed_streams as unknown[]).map((v, n) => oneOf(v, `config.allowed_streams[${n}]`, streams));
  if (new Set(allowed_streams).size !== allowed_streams.length ||
      !allowed_streams.includes('ble_windows') || !allowed_streams.includes('node_status') ||
      (capture_profile === 'metrics' ? allowed_streams.includes('ble_reports') : !allowed_streams.includes('ble_reports'))) invalid('config.allowed_streams');
  const s = object(o.scan, 'config.scan', ['stack','adapter_version','mode','interval_ms','window_ms','filter_duplicates','host_filter']);
  oneOf(s.stack, 'config.scan.stack', ['nimble']);
  const adapter_version = str(s.adapter_version, 'config.scan.adapter_version', /^[a-z0-9][a-z0-9._-]{0,79}$/);
  const scanMode = oneOf(s.mode, 'config.scan.mode', ['passive','active']);
  const interval_ms = int(s.interval_ms, 'config.scan.interval_ms', 1, 60000);
  const window_ms = int(s.window_ms, 'config.scan.window_ms', 1, interval_ms);
  const filter_duplicates = bool(s.filter_duplicates, 'config.scan.filter_duplicates');
  oneOf(s.host_filter, 'config.scan.host_filter', ['none']);
  const r = object(o.raw_capture, 'config.raw_capture', ['mode'], ['sample_every_n','selection']);
  const mode = oneOf(r.mode, 'config.raw_capture.mode', rawModes);
  let raw_capture: CaptureConfig['raw_capture'];
  if (mode === 'sampled') {
    object(r, 'config.raw_capture', ['mode','sample_every_n','selection']);
    const sample_every_n = int(r.sample_every_n, 'config.raw_capture.sample_every_n', 1, 0xffffffff);
    oneOf(r.selection, 'config.raw_capture.selection', ['seq_mod_n_eq_0']);
    raw_capture = { mode, sample_every_n, selection: 'seq_mod_n_eq_0' };
  } else {
    object(r, 'config.raw_capture', ['mode']);
    raw_capture = { mode };
  }
  if (capture_profile === 'metrics' ? mode !== 'off' : mode === 'off') invalid('config.raw_capture.mode');
  const identity_scheme = oneOf(o.identity_scheme, 'config.identity_scheme', ['mac','window_token','none']);
  const accept_until = str(o.accept_until, 'config.accept_until', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  if (!Number.isFinite(Date.parse(accept_until)) || new Date(accept_until).toISOString() !== accept_until) invalid('config.accept_until');
  const u = object(o.upload_policy, 'config.upload_policy', ['max_items','max_body_bytes','flush_max_age_ms','warn_pct','raw_pause_pct','critical_pct','resume_pct','overload_action']);
  const max_items = int(u.max_items, 'config.upload_policy.max_items', 1, 128);
  const max_body_bytes = int(u.max_body_bytes, 'config.upload_policy.max_body_bytes', 1, 65536);
  const flush_max_age_ms = int(u.flush_max_age_ms, 'config.upload_policy.flush_max_age_ms', 1);
  const resume_pct = int(u.resume_pct, 'config.upload_policy.resume_pct', 0, 100);
  const warn_pct = int(u.warn_pct, 'config.upload_policy.warn_pct', 0, 100);
  const raw_pause_pct = int(u.raw_pause_pct, 'config.upload_policy.raw_pause_pct', 0, 100);
  const critical_pct = int(u.critical_pct, 'config.upload_policy.critical_pct', 0, 100);
  if (!(resume_pct < warn_pct && warn_pct < raw_pause_pct && raw_pause_pct < critical_pct)) invalid('config.upload_policy');
  const overload_action = oneOf(u.overload_action, 'config.upload_policy.overload_action', ['pause_raw','pause_scan']);
  return { capture_config_id, node_id, placement_id, dataset, capture_profile, allowed_streams,
    scan: { stack: 'nimble', adapter_version, mode: scanMode, interval_ms, window_ms, filter_duplicates, host_filter: 'none' },
    raw_capture, identity_scheme, accept_until, upload_policy: { max_items, max_body_bytes, flush_max_age_ms,
      warn_pct, raw_pause_pct, critical_pct, resume_pct, overload_action } };
}

export function time(v: unknown, path: string): IngestTime {
  const o = object(v, path, ['mono_ms', 'utc_ms', 'clock_epoch', 'uncertainty_ms']);
  const utc_ms = o.utc_ms === null ? null : int(o.utc_ms, `${path}.utc_ms`, 1, 8640000000000000);
  const uncertainty_ms = nullableInt(o.uncertainty_ms, `${path}.uncertainty_ms`);
  if (utc_ms === null && uncertainty_ms !== null) invalid(`${path}.uncertainty_ms`);
  return { mono_ms: int(o.mono_ms, `${path}.mono_ms`), utc_ms,
    clock_epoch: int(o.clock_epoch, `${path}.clock_epoch`), uncertainty_ms };
}
function base(v: ObjectValue, path: string): BaseItem {
  return { seq: int(v.seq, `${path}.seq`, 1, 0xffffffff), time: time(v.time, `${path}.time`) };
}
export function windowItem(v: unknown, path: string): BleWindow {
  const o = object(v, path, ['seq','time','duration_ms','scan_enabled_ms','reports_seen','reports_aggregated','aggregation_drops','adv_reports','scan_response_reports','visible_identifiers','unique_table_capacity','unique_table_overflow','rssi','raw_capture','quality_flags'], ['indices']);
  const b = base(o, path);
  const duration_ms = int(o.duration_ms, `${path}.duration_ms`, 1000, 300000);
  if (b.time.mono_ms < duration_ms) invalid(`${path}.time.mono_ms`);
  const scan_enabled_ms = int(o.scan_enabled_ms, `${path}.scan_enabled_ms`, 0, duration_ms);
  const reports_seen = int(o.reports_seen, `${path}.reports_seen`);
  const reports_aggregated = int(o.reports_aggregated, `${path}.reports_aggregated`);
  const aggregation_drops = int(o.aggregation_drops, `${path}.aggregation_drops`);
  const adv_reports = int(o.adv_reports, `${path}.adv_reports`);
  const scan_response_reports = int(o.scan_response_reports, `${path}.scan_response_reports`);
  const visible_identifiers = int(o.visible_identifiers, `${path}.visible_identifiers`);
  const unique_table_capacity = int(o.unique_table_capacity, `${path}.unique_table_capacity`);
  const unique_table_overflow = bool(o.unique_table_overflow, `${path}.unique_table_overflow`);
  if (reports_seen !== reports_aggregated + aggregation_drops) invalid(`${path}.reports_seen`);
  if (reports_aggregated !== adv_reports + scan_response_reports) invalid(`${path}.reports_aggregated`);
  if (visible_identifiers > Math.min(reports_aggregated, unique_table_capacity)) invalid(`${path}.visible_identifiers`);
  const r = object(o.rssi, `${path}.rssi`, ['samples','min_dbm','max_dbm','mean_dbm']);
  const samples = int(r.samples, `${path}.rssi.samples`, 0, reports_aggregated);
  const min_dbm = r.min_dbm === null ? null : int(r.min_dbm, `${path}.rssi.min_dbm`, -127, 126);
  const max_dbm = r.max_dbm === null ? null : int(r.max_dbm, `${path}.rssi.max_dbm`, -127, 126);
  const mean_dbm = r.mean_dbm === null ? null : num(r.mean_dbm, `${path}.rssi.mean_dbm`, -127, 126);
  if (samples === 0 ? min_dbm !== null || max_dbm !== null || mean_dbm !== null :
    min_dbm === null || max_dbm === null || mean_dbm === null || min_dbm > max_dbm || mean_dbm < min_dbm || mean_dbm > max_dbm) invalid(`${path}.rssi`);
  const rc = object(o.raw_capture, `${path}.raw_capture`, ['mode','selected_reports','intentional_skips','pressure_skips','drops']);
  const mode = oneOf(rc.mode, `${path}.raw_capture.mode`, rawModes);
  const selected_reports = int(rc.selected_reports, `${path}.raw_capture.selected_reports`);
  const intentional_skips = int(rc.intentional_skips, `${path}.raw_capture.intentional_skips`);
  const pressure_skips = int(rc.pressure_skips, `${path}.raw_capture.pressure_skips`);
  const drops = int(rc.drops, `${path}.raw_capture.drops`);
  if (mode === 'off' ? selected_reports + intentional_skips + pressure_skips + drops !== 0 :
    selected_reports + intentional_skips + pressure_skips !== reports_seen || drops > selected_reports ||
    mode === 'all' && intentional_skips !== 0) invalid(`${path}.raw_capture`);
  if (!Array.isArray(o.quality_flags) || o.quality_flags.length > 32) invalid(`${path}.quality_flags`);
  const quality_flags = (o.quality_flags as unknown[]).map((flag, n) => str(flag, `${path}.quality_flags[${n}]`, labelRe));
  if (new Set(quality_flags).size !== quality_flags.length) invalid(`${path}.quality_flags`);
  let indices: BleWindow['indices'];
  if (o.indices !== undefined) {
    if (!Array.isArray(o.indices) || o.indices.length > 1) invalid(`${path}.indices`);
    indices = (o.indices as unknown[]).map((v, n) => {
      const p = `${path}.indices[${n}]`;
      const x = object(v, p, ['metric','value','unit','algorithm_id','calibration_id']);
      oneOf(x.metric, `${p}.metric`, ['report_rate']);
      oneOf(x.unit, `${p}.unit`, ['reports_per_scan_enabled_second']);
      oneOf(x.algorithm_id, `${p}.algorithm_id`, ['report-rate-v1']);
      if (x.calibration_id !== null || scan_enabled_ms === 0) invalid(p);
      const value = num(x.value, `${p}.value`);
      const expected = reports_aggregated * 1000 / scan_enabled_ms;
      if (Math.abs(value - expected) > Math.max(1e-6, expected * 1e-6)) invalid(`${p}.value`);
      return { metric: 'report_rate', value, unit: 'reports_per_scan_enabled_second', algorithm_id: 'report-rate-v1', calibration_id: null };
    });
  }
  return { ...b, duration_ms, scan_enabled_ms, reports_seen, reports_aggregated, aggregation_drops,
    adv_reports, scan_response_reports, visible_identifiers, unique_table_capacity, unique_table_overflow,
    rssi: { samples, min_dbm, max_dbm, mean_dbm }, raw_capture: { mode, selected_reports, intentional_skips, pressure_skips, drops },
    ...(indices === undefined ? {} : { indices }), quality_flags };
}
export function reportItem(v: unknown, path: string): BleReport {
  const o = object(v, path, ['seq','time','window_seq','identity','rssi_dbm','report_type','report_type_code','format','payload_length','payload_hex']);
  const b = base(o, path);
  const window_seq = int(o.window_seq, `${path}.window_seq`, 1, 0xffffffff);
  const io = object(o.identity, `${path}.identity`, ['scheme'], ['address','address_type','token']);
  const scheme = oneOf(io.scheme, `${path}.identity.scheme`, ['mac','window_token','none']);
  let identity: ReportIdentity;
  if (scheme === 'none') {
    object(io, `${path}.identity`, ['scheme']); identity = { scheme };
  } else {
    const address_type = oneOf(io.address_type, `${path}.identity.address_type`, addressTypes);
    if (scheme === 'mac') {
      object(io, `${path}.identity`, ['scheme','address','address_type']);
      identity = { scheme, address: str(io.address, `${path}.identity.address`, /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/), address_type };
    } else {
      object(io, `${path}.identity`, ['scheme','token','address_type']);
      identity = { scheme, token: str(io.token, `${path}.identity.token`, /^[0-9a-f]{32}$/), address_type };
    }
  }
  const rssi_dbm = o.rssi_dbm === null ? null : int(o.rssi_dbm, `${path}.rssi_dbm`, -127, 126);
  const report_type = oneOf(o.report_type, `${path}.report_type`, ['adv_ind','adv_direct_ind','adv_scan_ind','adv_nonconn_ind','scan_rsp','unknown']);
  const report_type_code = int(o.report_type_code, `${path}.report_type_code`, 0, 255);
  oneOf(o.format, `${path}.format`, ['legacy_ad']);
  const payload_length = int(o.payload_length, `${path}.payload_length`, 0, 31);
  const payload_hex = str(o.payload_hex, `${path}.payload_hex`, /^(?:[0-9a-f]{2}){0,31}$/);
  if (payload_hex.length !== payload_length * 2) invalid(`${path}.payload_hex`);
  return { ...b, window_seq, identity, rssi_dbm, report_type, report_type_code, format: 'legacy_ad', payload_length, payload_hex };
}
function streamCounts(v: unknown, path: string): Record<IngestStream, number> {
  const o = object(v, path, streams.slice());
  return { ble_windows: int(o.ble_windows, `${path}.ble_windows`), ble_reports: int(o.ble_reports, `${path}.ble_reports`), node_status: int(o.node_status, `${path}.node_status`) };
}
export function statusItem(v: unknown, path: string): NodeStatus {
  const o = object(v, path, ['seq','time','uptime_ms','scan_state','wifi_state','free_heap_bytes','queue_pending','queue_capacity','storage_free_bytes','raw_capture_state','loss_totals','buffer_health'], ['battery_mv','wifi_rssi_dbm']);
  const b = base(o, path);
  const uptime_ms = int(o.uptime_ms, `${path}.uptime_ms`);
  if (b.time.mono_ms > uptime_ms) invalid(`${path}.uptime_ms`);
  const queue_pending = streamCounts(o.queue_pending, `${path}.queue_pending`);
  const queue_capacity = streamCounts(o.queue_capacity, `${path}.queue_capacity`);
  for (const stream of streams) if (queue_pending[stream] > queue_capacity[stream]) invalid(`${path}.queue_pending.${stream}`);
  const lo = object(o.loss_totals, `${path}.loss_totals`, ['aggregation_drops','raw_queue_drops','storage_drops','windows_dropped','upload_failures','ack_failures','status_samples_coalesced','raw_pressure_skips']);
  const loss_totals = Object.fromEntries(Object.keys(lo).map(k => [k, int(lo[k], `${path}.loss_totals.${k}`)])) as unknown as NodeStatus['loss_totals'];
  const h = object(o.buffer_health, `${path}.buffer_health`, ['log_budget_bytes','used_bytes','unacked_bytes','reclaimable_bytes','incoming_local_Bps','newly_acknowledged_local_Bps','time_to_full_s','growth_state','pressure_level','pause_reason','raw_paused_ms','pre_pause_incoming_local_Bps']);
  const log_budget_bytes = int(h.log_budget_bytes, `${path}.buffer_health.log_budget_bytes`, 1);
  const used_bytes = int(h.used_bytes, `${path}.buffer_health.used_bytes`, 0, log_budget_bytes);
  const unacked_bytes = int(h.unacked_bytes, `${path}.buffer_health.unacked_bytes`, 0, used_bytes);
  const reclaimable_bytes = int(h.reclaimable_bytes, `${path}.buffer_health.reclaimable_bytes`, 0, used_bytes);
  if (unacked_bytes + reclaimable_bytes > used_bytes) invalid(`${path}.buffer_health`);
  const raw_paused_ms = int(h.raw_paused_ms, `${path}.buffer_health.raw_paused_ms`, 0, uptime_ms);
  const growth_state = str(h.growth_state, `${path}.buffer_health.growth_state`, labelRe);
  const pressure_level = str(h.pressure_level, `${path}.buffer_health.pressure_level`, labelRe);
  const incoming_local_Bps = nullableNum(h.incoming_local_Bps, `${path}.buffer_health.incoming_local_Bps`);
  const newly_acknowledged_local_Bps = nullableNum(h.newly_acknowledged_local_Bps, `${path}.buffer_health.newly_acknowledged_local_Bps`);
  const time_to_full_s = nullableNum(h.time_to_full_s, `${path}.buffer_health.time_to_full_s`);
  if (growth_state === 'unknown' && time_to_full_s !== null) invalid(`${path}.buffer_health.time_to_full_s`);
  if (growth_state === 'stable_or_draining' && time_to_full_s !== null) invalid(`${path}.buffer_health.time_to_full_s`);
  return { ...b, uptime_ms, scan_state: str(o.scan_state, `${path}.scan_state`, labelRe), wifi_state: str(o.wifi_state, `${path}.wifi_state`, labelRe),
    free_heap_bytes: int(o.free_heap_bytes, `${path}.free_heap_bytes`), queue_pending, queue_capacity,
    storage_free_bytes: int(o.storage_free_bytes, `${path}.storage_free_bytes`),
    raw_capture_state: str(o.raw_capture_state, `${path}.raw_capture_state`, labelRe), loss_totals,
    buffer_health: { log_budget_bytes, used_bytes, unacked_bytes, reclaimable_bytes, incoming_local_Bps,
      newly_acknowledged_local_Bps, time_to_full_s, growth_state, pressure_level,
      pause_reason: h.pause_reason === null ? null : str(h.pause_reason, `${path}.buffer_health.pause_reason`, labelRe),
      raw_paused_ms, pre_pause_incoming_local_Bps: nullableNum(h.pre_pause_incoming_local_Bps, `${path}.buffer_health.pre_pause_incoming_local_Bps`) },
    ...(o.battery_mv === undefined ? {} : { battery_mv: int(o.battery_mv, `${path}.battery_mv`, 0, 10000) }),
    ...(o.wifi_rssi_dbm === undefined ? {} : { wifi_rssi_dbm: int(o.wifi_rssi_dbm, `${path}.wifi_rssi_dbm`, -127, 0) }) };
}

export function validateEnvelope(value: unknown): IngestBatch {
  const o = object(value, 'batch', ['protocol','batch_id','node_id','boot_id','placement_id','capture_config_id','dataset','stream','firmware_version','items']);
  oneOf(o.protocol, 'batch.protocol', ['campuspulse/1']);
  const batch_id = str(o.batch_id, 'batch.batch_id', uuidRe);
  const boot_id = str(o.boot_id, 'batch.boot_id', uuidRe);
  const node_id = str(o.node_id, 'batch.node_id', idRe);
  const placement_id = str(o.placement_id, 'batch.placement_id', idRe);
  const capture_config_id = str(o.capture_config_id, 'batch.capture_config_id', idRe);
  const dataset = oneOf(o.dataset, 'batch.dataset', ['field','controlled_test','demo']);
  const stream = oneOf(o.stream, 'batch.stream', streams);
  const firmware_version = str(o.firmware_version, 'batch.firmware_version', /^[^\x00-\x1f\x7f]{1,80}$/);
  if (!Array.isArray(o.items) || o.items.length === 0 || o.items.length > 128) invalid('batch.items');
  const common = { protocol: 'campuspulse/1' as const, batch_id, node_id, boot_id, placement_id, capture_config_id, dataset, firmware_version };
  const items = (o.items as unknown[]).map((v, n) => stream === 'ble_windows' ? windowItem(v, `items[${n}]`) : stream === 'ble_reports' ? reportItem(v, `items[${n}]`) : statusItem(v, `items[${n}]`));
  for (let n = 1; n < items.length; n++) if (items[n].seq <= items[n - 1].seq) invalid(`items[${n}].seq`);
  for (let n = 1; n < items.length; n++) if (items[n].time.mono_ms < items[n - 1].time.mono_ms ||
    items[n].time.clock_epoch < items[n - 1].time.clock_epoch) invalid(`items[${n}].time`);
  if (stream === 'node_status' && items.length !== 1) invalid('batch.items');
  if (stream === 'ble_windows') return { ...common, stream, items: items as BleWindow[] };
  if (stream === 'ble_reports') return { ...common, stream, items: items as BleReport[] };
  return { ...common, stream, items: items as NodeStatus[] };
}

export function validateConfigBatch(batch: IngestBatch, config: CaptureConfig): void {
  if (batch.node_id !== config.node_id || batch.capture_config_id !== config.capture_config_id ||
      batch.placement_id !== config.placement_id || batch.dataset !== config.dataset) invalid('batch.config');
  if (!config.allowed_streams.includes(batch.stream) || batch.stream === 'ble_reports' &&
      (config.capture_profile !== 'research_raw' || config.raw_capture.mode === 'off')) invalid('batch.stream');
  if (batch.items.length > config.upload_policy.max_items) invalid('batch.items');
  if (batch.stream === 'ble_windows') {
    for (const [n, item] of batch.items.entries()) if (item.raw_capture.mode !== config.raw_capture.mode) invalid(`items[${n}].raw_capture.mode`);
  }
  if (batch.stream === 'ble_reports') {
    for (const [n, item] of batch.items.entries()) {
      if (item.identity.scheme !== config.identity_scheme) invalid(`items[${n}].identity.scheme`);
      if (config.raw_capture.mode === 'sampled' && item.seq % config.raw_capture.sample_every_n! !== 0) invalid(`items[${n}].seq`);
      if (config.scan.mode === 'passive' && item.report_type === 'scan_rsp') invalid(`items[${n}].report_type`);
    }
  }
}

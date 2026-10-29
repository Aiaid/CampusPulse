/** Explicit v2 policy and wire validation. The v1 validators remain unchanged. */
import { IngestError, validateCaptureConfig, time, windowItem, reportItem, statusItem,
  type CaptureConfig, type BleWindow, type BleReport, type NodeStatus, type IngestTime, type AddressType } from './ingest-validation';
import { COMPACT_VEHICLE_SCHEMA_VERSION, type CompactVehicleEvidence } from './vehicle-rules';

export const ID = /^[a-z0-9_-]{1,64}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const invalid = (path: string): never => { throw new IngestError(422, 'invalid_device_v2', `Invalid field: ${path}.`); };
export function object(value: unknown, path: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(path);
  const o = value as Record<string, unknown>;
  if (required.some(k => !Object.hasOwn(o, k)) || Object.keys(o).some(k => !required.includes(k) && !optional.includes(k))) invalid(path);
  return o;
}
export const integer = (value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid(path);
export const string = (value: unknown, path: string, re = ID): string => typeof value === 'string' && re.test(value) ? value : invalid(path);
export function choice<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : invalid(path);
}
export const V2_STREAMS = ['ble_windows', 'address_summaries', 'node_status', 'ble_reports'] as const;
export type V2Stream = typeof V2_STREAMS[number];
export interface CaptureConfigV2 extends Omit<CaptureConfig, 'capture_profile' | 'allowed_streams' | 'raw_capture' | 'identity_scheme'> {
  protocol: 'campuspulse/2';
  capture_profile: 'address_metrics';
  allowed_streams: V2Stream[];
  identity_scheme: 'mac';
  raw_capture: { mode: 'off' } | { mode: 'sampled'; sample_every_n: number; selection: 'seq_mod_n_eq_0'; max_reports_per_window: number };
  summary: { window_ms: number; bin_ms: number; max_addresses: number };
  control: { lease_ms: number };
}
export type AnyCaptureConfig = CaptureConfig | CaptureConfigV2;
export function validateAnyCaptureConfig(value: unknown): AnyCaptureConfig {
  return value && typeof value === 'object' && 'protocol' in value ? validateCaptureConfigV2(value) : validateCaptureConfig(value);
}
export function validateCaptureConfigV2(value: unknown): CaptureConfigV2 {
  const o = object(value, 'config', ['protocol','capture_config_id','node_id','placement_id','dataset','capture_profile','allowed_streams','scan','raw_capture','identity_scheme','accept_until','upload_policy','summary','control']);
  choice(o.protocol, 'config.protocol', ['campuspulse/2']);
  choice(o.capture_profile, 'config.capture_profile', ['address_metrics']);
  choice(o.identity_scheme, 'config.identity_scheme', ['mac']);
  const raw = object(o.raw_capture, 'config.raw_capture', ['mode'], ['sample_every_n','selection','max_reports_per_window']);
  const mode = choice(raw.mode, 'config.raw_capture.mode', ['off','sampled']);
  let raw_capture: CaptureConfigV2['raw_capture'];
  if (mode === 'off') { object(raw, 'config.raw_capture', ['mode']); raw_capture = { mode }; }
  else {
    object(raw, 'config.raw_capture', ['mode','sample_every_n','selection','max_reports_per_window']);
    raw_capture = { mode, sample_every_n: integer(raw.sample_every_n, 'config.raw_capture.sample_every_n', 1, 0xffffffff),
      selection: choice(raw.selection, 'config.raw_capture.selection', ['seq_mod_n_eq_0']),
      max_reports_per_window: integer(raw.max_reports_per_window, 'config.raw_capture.max_reports_per_window', 1, 16) };
  }
  if (!Array.isArray(o.allowed_streams)) invalid('config.allowed_streams');
  const allowed_streams = (o.allowed_streams as unknown[]).map(s => choice(s, 'config.allowed_streams', V2_STREAMS));
  const expected = mode === 'off' ? V2_STREAMS.slice(0, 3) : [...V2_STREAMS];
  if (allowed_streams.length !== expected.length || new Set(allowed_streams).size !== expected.length || expected.some(s => !allowed_streams.includes(s))) invalid('config.allowed_streams');
  const { protocol: _protocol, summary: _summary, control: _control, ...common } = o;
  const legacy = validateCaptureConfig({ ...common, capture_profile: mode === 'off' ? 'metrics' : 'research_raw',
    allowed_streams: allowed_streams.filter(s => s !== 'address_summaries'), raw_capture: mode === 'off' ? { mode } : {
      mode, sample_every_n: raw_capture.mode === 'sampled' ? raw_capture.sample_every_n : 1, selection: 'seq_mod_n_eq_0' } });
  const s = object(o.summary, 'config.summary', ['window_ms','bin_ms','max_addresses']);
  const window_ms = integer(s.window_ms, 'config.summary.window_ms', 1000, 300000);
  const bin_ms = integer(s.bin_ms, 'config.summary.bin_ms', 1000, window_ms);
  if (window_ms % bin_ms || window_ms / bin_ms > 60) invalid('config.summary.bin_ms');
  const max_addresses = integer(s.max_addresses, 'config.summary.max_addresses', 1, 128);
  const c = object(o.control, 'config.control', ['lease_ms']);
  const lease_ms = integer(c.lease_ms, 'config.control.lease_ms', 30000, 600000);
  return { ...legacy, protocol: 'campuspulse/2', capture_profile: 'address_metrics', identity_scheme: 'mac', allowed_streams,
    raw_capture, summary: { window_ms, bin_ms, max_addresses }, control: { lease_ms } };
}

export interface AddressSummary {
  seq: number; time: IngestTime; window_seq: number; duration_ms: number; bin_ms: number;
  address: string; address_type: AddressType; reports: number; adv_reports: number; scan_response_reports: number;
  first_offset_ms: number; last_offset_ms: number; rssi: BleWindow['rssi']; bins: number[];
  /** Absent on older firmware: unknown feature evidence, never a zero result. */
  vehicle_evidence?: CompactVehicleEvidence;
}
export interface NodeStatusV2 extends NodeStatus {
  queue_pending: Record<V2Stream, number>; queue_capacity: Record<V2Stream, number>;
  loss_totals: NodeStatus['loss_totals'] & { address_summaries_dropped?: number; address_table_overflow_reports?: number; accounting_overrun_reports?: number; unpersisted_window_reports?: number };
}
interface Envelope<S extends V2Stream, T> {
  protocol: 'campuspulse/2'; batch_id: string; node_id: string; boot_id: string; placement_id: string;
  capture_config_id: string; dataset: CaptureConfig['dataset']; stream: S; firmware_version: string; items: T[];
}
export type BatchV2 = Envelope<'ble_windows', BleWindow> | Envelope<'address_summaries', AddressSummary> |
  Envelope<'node_status', NodeStatusV2> | Envelope<'ble_reports', BleReport>;
function summaryItem(value: unknown, path: string): AddressSummary {
  const o = object(value, path, ['seq','time','window_seq','duration_ms','bin_ms','address','address_type','reports','adv_reports','scan_response_reports','first_offset_ms','last_offset_ms','rssi','bins'], ['vehicle_evidence']);
  const seq = integer(o.seq, `${path}.seq`, 1, 0xffffffff), timestamp = time(o.time, `${path}.time`);
  const window_seq = integer(o.window_seq, `${path}.window_seq`, 1, 0xffffffff);
  const duration_ms = integer(o.duration_ms, `${path}.duration_ms`, 1000, 300000);
  // A memory/policy stop can close a window before its configured first bin
  // ends. Keep that bin width and validate the ceil-sized partial bins below;
  // validateConfigBatchV2 still requires the exact assigned policy width.
  const bin_ms = integer(o.bin_ms, `${path}.bin_ms`, 1000, 300000);
  if (timestamp.mono_ms < duration_ms) invalid(`${path}.time`);
  const reports = integer(o.reports, `${path}.reports`, 1, 0xffffffff);
  const adv_reports = integer(o.adv_reports, `${path}.adv_reports`, 0, reports);
  const scan_response_reports = integer(o.scan_response_reports, `${path}.scan_response_reports`, 0, reports);
  if (adv_reports + scan_response_reports !== reports) invalid(`${path}.reports`);
  const first_offset_ms = integer(o.first_offset_ms, `${path}.first_offset_ms`, 0, duration_ms - 1);
  const last_offset_ms = integer(o.last_offset_ms, `${path}.last_offset_ms`, first_offset_ms, duration_ms - 1);
  if (!Array.isArray(o.bins) || o.bins.length !== Math.ceil(duration_ms / bin_ms) || o.bins.length > 60) invalid(`${path}.bins`);
  const bins = (o.bins as unknown[]).map(b => integer(b, `${path}.bins`, 0, reports));
  if (bins.reduce((a,b) => a+b, 0) !== reports || bins[Math.floor(first_offset_ms / bin_ms)] === 0 || bins[Math.floor(last_offset_ms / bin_ms)] === 0 ||
      bins.some((count, n) => count > 0 && (n < Math.floor(first_offset_ms/bin_ms) || n > Math.floor(last_offset_ms/bin_ms)))) invalid(`${path}.bins`);
  // Reuse exactly the v1 RSSI range/unknown rules, without accepting synthetic counters from the request.
  const validWindow = windowItem({ seq, time: timestamp, duration_ms, scan_enabled_ms: duration_ms, reports_seen: reports,
    reports_aggregated: reports, aggregation_drops: 0, adv_reports, scan_response_reports, visible_identifiers: 1,
    unique_table_capacity: 1, unique_table_overflow: false, rssi: o.rssi,
    raw_capture: { mode: 'off', selected_reports: 0, intentional_skips: 0, pressure_skips: 0, drops: 0 }, quality_flags: [] }, path);
  let vehicle_evidence: CompactVehicleEvidence | undefined;
  if (Object.hasOwn(o, 'vehicle_evidence')) {
    const featurePath = `${path}.vehicle_evidence`;
    const feature = object(o.vehicle_evidence, featurePath,
      ['schema_version','parsed_reports','malformed_reports','name_brand_mask','exclusion_mask','ecosystem_mask']);
    vehicle_evidence = {
      schema_version: choice(feature.schema_version, `${featurePath}.schema_version`, [COMPACT_VEHICLE_SCHEMA_VERSION]),
      parsed_reports: integer(feature.parsed_reports, `${featurePath}.parsed_reports`, 0, 0xffffffff),
      malformed_reports: integer(feature.malformed_reports, `${featurePath}.malformed_reports`, 0, 0xffffffff),
      name_brand_mask: integer(feature.name_brand_mask, `${featurePath}.name_brand_mask`, 0, (1 << 20) - 1),
      exclusion_mask: integer(feature.exclusion_mask, `${featurePath}.exclusion_mask`, 0, 2047),
      ecosystem_mask: integer(feature.ecosystem_mask, `${featurePath}.ecosystem_mask`, 0, 3),
    };
    if (vehicle_evidence.parsed_reports + vehicle_evidence.malformed_reports !== reports) invalid(`${featurePath}.reports`);
  }
  return { seq, time: timestamp, window_seq, duration_ms, bin_ms,
    address: string(o.address, `${path}.address`, /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/),
    address_type: choice(o.address_type, `${path}.address_type`, ['public','random','public_identity','random_identity','unknown']),
    reports, adv_reports, scan_response_reports, first_offset_ms, last_offset_ms, rssi: validWindow.rssi, bins,
    ...(vehicle_evidence === undefined ? {} : { vehicle_evidence }) };
}
function statusV2(value: unknown, path: string): NodeStatusV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(path);
  const o = value as Record<string, unknown>;
  const pending = object(o.queue_pending, `${path}.queue_pending`, [...V2_STREAMS]);
  const capacity = object(o.queue_capacity, `${path}.queue_capacity`, [...V2_STREAMS]);
  const addressPending = integer(pending.address_summaries, `${path}.queue_pending.address_summaries`);
  const addressCapacity = integer(capacity.address_summaries, `${path}.queue_capacity.address_summaries`, addressPending);
  const { address_summaries: _p, ...legacyPending } = pending;
  const { address_summaries: _c, ...legacyCapacity } = capacity;
  const loss = object(o.loss_totals, `${path}.loss_totals`, ['aggregation_drops','raw_queue_drops','storage_drops','windows_dropped','upload_failures','ack_failures','status_samples_coalesced','raw_pressure_skips'], ['address_summaries_dropped','address_table_overflow_reports','accounting_overrun_reports','unpersisted_window_reports']);
  const { address_summaries_dropped, address_table_overflow_reports, accounting_overrun_reports, unpersisted_window_reports, ...legacyLoss } = loss;
  const legacy = statusItem({ ...o, queue_pending: legacyPending, queue_capacity: legacyCapacity, loss_totals: legacyLoss }, path);
  return { ...legacy, queue_pending: { ...legacy.queue_pending, address_summaries: addressPending }, queue_capacity: { ...legacy.queue_capacity, address_summaries: addressCapacity },
    loss_totals: { ...legacy.loss_totals,
      ...(address_summaries_dropped === undefined ? {} : { address_summaries_dropped: integer(address_summaries_dropped, `${path}.loss_totals.address_summaries_dropped`) }),
      ...(address_table_overflow_reports === undefined ? {} : { address_table_overflow_reports: integer(address_table_overflow_reports, `${path}.loss_totals.address_table_overflow_reports`) }),
      ...(accounting_overrun_reports === undefined ? {} : { accounting_overrun_reports: integer(accounting_overrun_reports, `${path}.loss_totals.accounting_overrun_reports`) }),
      ...(unpersisted_window_reports === undefined ? {} : { unpersisted_window_reports: integer(unpersisted_window_reports, `${path}.loss_totals.unpersisted_window_reports`) }) } };
}
export function validateEnvelopeV2(value: unknown): BatchV2 {
  const o = object(value, 'batch', ['protocol','batch_id','node_id','boot_id','placement_id','capture_config_id','dataset','stream','firmware_version','items']);
  choice(o.protocol, 'batch.protocol', ['campuspulse/2']);
  const common = { protocol: 'campuspulse/2' as const, batch_id: string(o.batch_id, 'batch.batch_id', UUID), boot_id: string(o.boot_id, 'batch.boot_id', UUID),
    node_id: string(o.node_id, 'batch.node_id'), placement_id: string(o.placement_id, 'batch.placement_id'), capture_config_id: string(o.capture_config_id, 'batch.capture_config_id'),
    dataset: choice(o.dataset, 'batch.dataset', ['field','controlled_test','demo']), firmware_version: string(o.firmware_version, 'batch.firmware_version', /^[^\x00-\x1f\x7f]{1,80}$/) };
  const stream = choice(o.stream, 'batch.stream', V2_STREAMS);
  if (!Array.isArray(o.items) || o.items.length === 0 || o.items.length > 128 || stream === 'node_status' && o.items.length !== 1) invalid('batch.items');
  const items = (o.items as unknown[]).map((item,n) => stream === 'address_summaries' ? summaryItem(item, `items[${n}]`) : stream === 'node_status' ? statusV2(item, `items[${n}]`) : stream === 'ble_windows' ? windowItem(item, `items[${n}]`) : reportItem(item, `items[${n}]`));
  for (let n=1;n<items.length;n++) if (items[n].seq <= items[n-1].seq || items[n].time.mono_ms < items[n-1].time.mono_ms || items[n].time.clock_epoch < items[n-1].time.clock_epoch) invalid(`items[${n}]`);
  if (stream === 'address_summaries') return { ...common, stream, items: items as AddressSummary[] };
  if (stream === 'ble_windows') return { ...common, stream, items: items as BleWindow[] };
  if (stream === 'ble_reports') return { ...common, stream, items: items as BleReport[] };
  return { ...common, stream, items: items as NodeStatusV2[] };
}
export function validateConfigBatchV2(batch: BatchV2, config: CaptureConfigV2) {
  if (batch.node_id !== config.node_id || batch.capture_config_id !== config.capture_config_id || batch.placement_id !== config.placement_id || batch.dataset !== config.dataset) invalid('batch.config');
  if (!config.allowed_streams.includes(batch.stream)) invalid('batch.stream');
  if (batch.items.length > config.upload_policy.max_items) invalid('batch.items');
  if (batch.stream === 'address_summaries') for (const item of batch.items) {
    if (item.duration_ms > config.summary.window_ms || item.bin_ms !== config.summary.bin_ms || config.scan.mode === 'passive' && item.scan_response_reports !== 0) invalid('items.summary');
  }
  if (batch.stream === 'ble_windows') for (const item of batch.items) {
    if (item.duration_ms > config.summary.window_ms || item.unique_table_capacity !== config.summary.max_addresses || item.raw_capture.mode !== config.raw_capture.mode ||
        config.raw_capture.mode === 'sampled' && item.raw_capture.selected_reports > config.raw_capture.max_reports_per_window) invalid('items.window');
  }
  if (batch.stream === 'ble_reports') for (const item of batch.items) {
    if (config.raw_capture.mode !== 'sampled' || item.seq % config.raw_capture.sample_every_n !== 0 || item.identity.scheme !== 'mac' ||
      config.scan.mode === 'passive' && item.report_type === 'scan_rsp') invalid('items.raw');
  }
}

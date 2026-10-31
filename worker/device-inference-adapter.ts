/** Pure, local extraction only. The caller groups reports for one address/type/
 * window; this module does not associate reports or establish radio completeness.
 * Payloads are transient parser input and never appear in the returned object.
 */
import { PARSER_VERSION, parseAdvertisement } from './ble-ad';
import { PROTOCOL_FEATURE_VERSION, type DeviceProtocolFeatures } from './device-inference';

export const DEVICE_PROTOCOL_ADAPTER_VERSION = 'device-protocol-adapter-v1' as const;
export const MAX_PROTOCOL_REPORTS = 128;
export const MAX_PROTOCOL_VALUES = 128;
export interface DeviceProtocolReport {
  format: 'legacy' | 'extended';
  /** Extended fragments must be reassembled and verified by the caller first. */
  completeness: 'complete' | 'fragment' | 'unknown';
  payload_hex: string;
}
export interface DeviceProtocolExtractionInput {
  /** Complete means all caller-supplied reports, never all over-the-air traffic. */
  collection_scope: 'complete_supplied_reports' | 'sampled' | 'unknown';
  reports: readonly DeviceProtocolReport[];
}
export interface DeviceProtocolExtractionResult {
  adapter_version: typeof DEVICE_PROTOCOL_ADAPTER_VERSION;
  protocol_features: DeviceProtocolFeatures;
  quality: {
    collection_scope: DeviceProtocolExtractionInput['collection_scope'];
    supplied_reports: number;
    inspected_reports: number;
    parsed_reports: number;
    malformed_reports: number;
    incomplete_reports: number;
    out_of_bounds_reports: number;
    /** Indicates a bounded input/list was not fully represented. */
    overflow: boolean;
    complete_supplied_reports: boolean;
  };
  limitations: string[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const baseUuid16 = (uuid: string): number | null => {
  const match = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(uuid);
  return match ? Number.parseInt(match[1], 16) : null;
};

/** Fail closed on incomplete/malformed/bounded-away evidence. Even sampled
 * reports with valid AD bytes get unknown aggregate status: the current
 * inference contract cannot itself carry sampling or truncation limitations.
 * Lists are repeated observed values, not a complete inventory of services.
 * An AD complete-UUID-list flag describes that report and never the whole window.
 */
export function extractDeviceProtocolFeatures(input: DeviceProtocolExtractionInput): DeviceProtocolExtractionResult {
  const services: number[] = [];
  const appearances: number[] = [];
  const companies: number[] = [];
  const result: DeviceProtocolExtractionResult = {
    adapter_version: DEVICE_PROTOCOL_ADAPTER_VERSION,
    protocol_features: { schema_version: PROTOCOL_FEATURE_VERSION, extractor_version: PARSER_VERSION,
      parse_status: 'unknown', service_uuids16: services, appearances,
      manufacturer_company_ids: companies },
    quality: { collection_scope: 'unknown', supplied_reports: 0, inspected_reports: 0,
      parsed_reports: 0, malformed_reports: 0, incomplete_reports: 0,
      out_of_bounds_reports: 0, overflow: false, complete_supplied_reports: false },
    limitations: ['caller_scopes_reports_without_adapter_association', 'not_radio_complete',
      'observed_fields_only', 'cross_report_cooccurrence_not_established'],
  };
  const limit = (reason: string) => { if (!result.limitations.includes(reason)) result.limitations.push(reason); };
  if (!object(input) || Object.keys(input).some(key => !['collection_scope', 'reports'].includes(key))
    || !Array.isArray(input.reports) || !['complete_supplied_reports', 'sampled', 'unknown'].includes(input.collection_scope)) {
    limit('malformed_adapter_input');
    return result;
  }
  const quality = result.quality;
  quality.collection_scope = input.collection_scope;
  quality.supplied_reports = input.reports.length;
  if (input.collection_scope !== 'complete_supplied_reports') limit(`${input.collection_scope}_collection_scope`);
  if (input.reports.length === 0) limit('no_reports');
  if (input.reports.length > MAX_PROTOCOL_REPORTS) {
    quality.overflow = true;
    limit('report_limit_exceeded');
  }
  const append = (target: number[], value: number) => {
    if (target.length < MAX_PROTOCOL_VALUES) target.push(value);
    else { quality.overflow = true; limit('feature_limit_exceeded'); }
  };
  for (const report of input.reports.slice(0, MAX_PROTOCOL_REPORTS)) {
    quality.inspected_reports++;
    if (!object(report) || Object.keys(report).some(key => !['format', 'completeness', 'payload_hex'].includes(key))
      || typeof report.format !== 'string' || !['legacy', 'extended'].includes(report.format)
      || typeof report.payload_hex !== 'string' || typeof report.completeness !== 'string'
      || !['complete', 'fragment', 'unknown'].includes(report.completeness)) {
      quality.malformed_reports++;
      limit('malformed_report_input');
      continue;
    }
    // Check bounds before invoking the parser; never silently slice a payload.
    if (report.payload_hex.length > (report.format === 'legacy' ? 31 : 1650) * 2) {
      quality.out_of_bounds_reports++;
      limit('payload_limit_exceeded');
      continue;
    }
    if (report.completeness !== 'complete') {
      quality.incomplete_reports++;
      limit('incomplete_or_unknown_report');
      continue;
    }
    const parsed = parseAdvertisement(report.payload_hex);
    if (parsed.parse_status !== 'ok') {
      quality.malformed_reports++;
      limit('malformed_advertisement');
      continue;
    }
    quality.parsed_reports++;
    for (const field of [...parsed.service_uuids, ...parsed.service_data]) {
      const service = baseUuid16(field.uuid);
      if (service !== null) append(services, service);
    }
    for (const field of parsed.appearance) append(appearances, field.value);
    for (const field of parsed.manufacturer_data) append(companies, field.company_id);
  }
  quality.complete_supplied_reports = quality.collection_scope === 'complete_supplied_reports'
    && quality.parsed_reports > 0 && quality.parsed_reports === quality.supplied_reports && !quality.overflow;
  result.protocol_features.parse_status = quality.malformed_reports ? 'malformed'
    : quality.complete_supplied_reports ? 'ok' : 'unknown';
  return result;
}

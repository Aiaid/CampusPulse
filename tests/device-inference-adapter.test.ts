import { describe, expect, it } from 'vitest';
import { PARSER_VERSION } from '../worker/ble-ad';
import { DEVICE_INFERENCE_INPUT_VERSION, inferDevice, PROTOCOL_FEATURE_VERSION } from '../worker/device-inference';
import {
  extractDeviceProtocolFeatures, MAX_PROTOCOL_REPORTS, MAX_PROTOCOL_VALUES,
  type DeviceProtocolExtractionInput, type DeviceProtocolReport,
} from '../worker/device-inference-adapter';

const report = (payload_hex: string, extra: Partial<DeviceProtocolReport> = {}): DeviceProtocolReport => ({
  format: 'legacy', completeness: 'complete', payload_hex, ...extra,
});
const extract = (reports: DeviceProtocolReport[], collection_scope: DeviceProtocolExtractionInput['collection_scope'] = 'complete_supplied_reports') =>
  extractDeviceProtocolFeatures({ reports, collection_scope });
const infer = (protocol_features: ReturnType<typeof extract>['protocol_features']) => inferDevice({
  schema_version: DEVICE_INFERENCE_INPUT_VERSION, source: 'offline_replay', protocol_features,
});
const le = (value: number, width: number) => Array.from({ length: width }, (_, index) =>
  Math.floor(value / 2 ** (index * 8)) % 256).map(byte => byte.toString(16).padStart(2, '0')).join('');
const ad = (type: number, value: string) => le(value.length / 2 + 1, 1) + le(type, 1) + value;
const baseUuidLe = (value: number) => 'fb349b5f8000008000100000' + le(value, 4);

describe('local protocol extraction from explicitly scoped AD reports', () => {
  it('extracts service UUID and service-data fields of every width without private values', () => {
    const result = extract([
      report(ad(0x03, '1218') + ad(0x16, '2cfe112233') + ad(0x19, 'c103') + ad(0xff, '4c00aabb')),
      report(ad(0x05, '12180000') + ad(0x20, '2cfe0000aabb')),
      report(ad(0x07, baseUuidLe(0x1812)) + ad(0x21, baseUuidLe(0xfe2c)), { format: 'extended' }),
    ]);
    expect(result.protocol_features).toEqual({ schema_version: PROTOCOL_FEATURE_VERSION,
      extractor_version: PARSER_VERSION, parse_status: 'ok', service_uuids16: [0x1812, 0xfe2c, 0x1812, 0xfe2c, 0x1812, 0xfe2c],
      appearances: [0x03c1], manufacturer_company_ids: [0x004c] });
    expect(result.quality).toMatchObject({ supplied_reports: 3, parsed_reports: 3, complete_supplied_reports: true });
    expect(infer(result.protocol_features)).toMatchObject({ state: 'candidate', category: 'other' });
    expect(JSON.stringify(result)).not.toMatch(/112233|aabb|payload_hex|value_hex|data_hex|company_name/);
  });

  it('does not collapse arbitrary 32/128-bit UUIDs into assigned 16-bit services', () => {
    const result = extract([report(ad(0x05, '12180100') + ad(0x07, '12180000000000000000000000000000'))]);
    expect(result.protocol_features.service_uuids16).toEqual([]);
    expect(result.protocol_features.parse_status).toBe('ok');
  });

  it('preserves repeated values and explicit empty observations across reports', () => {
    expect(extract([report('')]).protocol_features).toMatchObject({ parse_status: 'ok',
      service_uuids16: [], appearances: [], manufacturer_company_ids: [] });
    const result = extract([report(ad(0x03, '12181218')), report(ad(0x19, 'c103') + ad(0x19, 'c203'))]);
    expect(result.protocol_features.service_uuids16).toEqual([0x1812, 0x1812]);
    expect(result.protocol_features.appearances).toEqual([0x03c1, 0x03c2]);
    expect(result.limitations).toContain('cross_report_cooccurrence_not_established');
    expect(result.limitations).toContain('not_radio_complete');
  });

  it('accepts exactly 31 legacy bytes and exactly 1650 explicitly complete extended bytes', () => {
    const legacy = ad(0xff, '4c00' + '00'.repeat(27));
    expect(legacy.length / 2).toBe(31);
    expect(extract([report(legacy)]).protocol_features.parse_status).toBe('ok');
    // Unrecognized AD types are valid and do not inflate feature lists.
    const extended = ad(0x30, '00'.repeat(254)).repeat(6) + ad(0x30, '00'.repeat(112));
    expect(extended.length / 2).toBe(1650);
    expect(extract([report(extended, { format: 'extended' })]).protocol_features.parse_status).toBe('ok');
    for (const item of [report(legacy + '00'), report(extended + '00', { format: 'extended' })]) {
      const result = extract([item]);
      expect(result.quality.out_of_bounds_reports).toBe(1);
      expect(result.protocol_features.parse_status).toBe('unknown');
      expect(result.quality.complete_supplied_reports).toBe(false);
    }
  });

  it.each(['fragment', 'unknown'] as const)('never parses an extended %s as a complete advertisement', completeness => {
    const result = extract([report(ad(0x03, '1218') + ad(0x19, 'c103'), { format: 'extended', completeness })]);
    expect(result.protocol_features).toMatchObject({ parse_status: 'unknown', service_uuids16: [], appearances: [] });
    expect(result.quality).toMatchObject({ parsed_reports: 0, incomplete_reports: 1, complete_supplied_reports: false });
    expect(infer(result.protocol_features).state).toBe('unknown');
  });

  it('retains malformed and truncation failures even alongside a complete usable report', () => {
    const valid = report(ad(0x03, '1218') + ad(0x19, 'c103'));
    for (const invalid of ['ff', '0', 'zz', ad(0x03, '121800'), ad(0x19, 'c1'), ad(0xff, '4c'), ad(0x16, '12')]) {
      const result = extract([valid, report(invalid)]);
      expect(result.protocol_features.parse_status).toBe('malformed');
      expect(result.quality).toMatchObject({ malformed_reports: 1, complete_supplied_reports: false });
      expect(infer(result.protocol_features).state).toBe('unknown');
    }
    const incomplete = extract([valid, report('', { completeness: 'fragment' })]);
    expect(incomplete.protocol_features.parse_status).toBe('unknown');
    expect(incomplete.quality.complete_supplied_reports).toBe(false);
  });

  it.each(['sampled', 'unknown'] as const)('exposes %s collection scope and blocks completeness-dependent inference', scope => {
    const result = extract([report(ad(0x03, '1218') + ad(0x19, 'c103'))], scope);
    expect(result.protocol_features.service_uuids16).toEqual([0x1812]);
    expect(result.protocol_features.parse_status).toBe('unknown');
    expect(result.quality).toMatchObject({ collection_scope: scope, parsed_reports: 1, complete_supplied_reports: false });
    expect(infer(result.protocol_features).state).toBe('unknown');
  });

  it('fails closed at report and feature limits instead of returning a complete prefix', () => {
    const reports = extract(Array.from({ length: MAX_PROTOCOL_REPORTS + 1 }, () => report('')));
    expect(reports.quality).toMatchObject({ inspected_reports: MAX_PROTOCOL_REPORTS, overflow: true, complete_supplied_reports: false });
    expect(reports.protocol_features.parse_status).toBe('unknown');
    for (const value of [ad(0x03, '1218'), ad(0x19, 'c103'), ad(0xff, '4c00')]) {
      const features = extract([report(value.repeat(MAX_PROTOCOL_VALUES + 1), { format: 'extended' })]);
      expect(features.quality).toMatchObject({ overflow: true, complete_supplied_reports: false });
      expect(features.protocol_features.parse_status).toBe('unknown');
      expect(Object.values(features.protocol_features).filter(Array.isArray).every(list => list.length <= MAX_PROTOCOL_VALUES)).toBe(true);
      expect(infer(features.protocol_features).state).toBe('unknown');
    }
  });

  it('validates runtime input and never echoes private unexpected fields', () => {
    const privateMarker = 'PRIVATE_TEST_MARKER';
    for (const input of [null, [], { reports: [] }, { collection_scope: 'future', reports: [] },
      { collection_scope: 'complete_supplied_reports', reports: [], address: privateMarker }]) {
      const result = extractDeviceProtocolFeatures(input as DeviceProtocolExtractionInput);
      expect(result.protocol_features.parse_status).toBe('unknown');
      expect(JSON.stringify(result)).not.toContain(privateMarker);
    }
    for (const invalid of [null, [], { ...report(''), completeness: undefined },
      { ...report(''), format: 'future' }, { ...report(''), payload_hex: 123 },
      { ...report(''), raw: privateMarker }, { ...report(''), name: privateMarker }]) {
      const result = extract([invalid as DeviceProtocolReport]);
      expect(result.protocol_features.parse_status).toBe('malformed');
      expect(JSON.stringify(result)).not.toContain(privateMarker);
    }
    expect(extract([])).toMatchObject({ protocol_features: { parse_status: 'unknown' },
      quality: { complete_supplied_reports: false } });
  });

  it('is deterministic, immutable, and discards names and manufacturer payloads', () => {
    const reports = [report(ad(0x09, '505249564154455f544553545f4d41524b4552'), { format: 'extended' })];
    const snapshot = structuredClone(reports);
    const first = extract(reports);
    expect(extract(reports)).toEqual(first);
    expect(reports).toEqual(snapshot);
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE_TEST_MARKER|50524956415445|names|payload_hex/);
  });
});

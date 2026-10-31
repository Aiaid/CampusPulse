import { describe, expect, it } from 'vitest';
import { PARSER_VERSION } from '../worker/ble-ad';
import {
  DEVICE_INFERENCE_INPUT_VERSION, DEVICE_INFERENCE_RULESET_VERSION, inferDevice,
  PROTOCOL_DICTIONARY_VERSION, PROTOCOL_FEATURE_VERSION,
  type DeviceInferenceInput, type DeviceProtocolFeatures,
} from '../worker/device-inference';
import { COMPACT_VEHICLE_SCHEMA_VERSION, type CompactVehicleEvidence } from '../worker/vehicle-rules';

const compact = (extra: Partial<CompactVehicleEvidence> = {}): CompactVehicleEvidence => ({
  schema_version: COMPACT_VEHICLE_SCHEMA_VERSION, parsed_reports: 1, malformed_reports: 0,
  name_brand_mask: 0, exclusion_mask: 0, ecosystem_mask: 0, ...extra,
});
const protocol = (extra: Partial<DeviceProtocolFeatures> = {}): DeviceProtocolFeatures => ({
  schema_version: PROTOCOL_FEATURE_VERSION, extractor_version: PARSER_VERSION, parse_status: 'ok',
  service_uuids16: [], appearances: [], manufacturer_company_ids: [], ...extra,
});
const input = (extra: Partial<DeviceInferenceInput> = {}): DeviceInferenceInput => ({
  schema_version: DEVICE_INFERENCE_INPUT_VERSION, source: 'offline_replay', ...extra,
});

describe('conservative, replayable device inference', () => {
  it('distinguishes missing, empty and malformed evidence', () => {
    const missing = inferDevice(input());
    expect(missing).toMatchObject({ category: 'unknown', state: 'unknown', evidence_grade: 'none' });
    expect(missing.limitations).toContain('compact_evidence_missing');
    expect(missing.limitations).toContain('protocol_features_missing');
    const empty = inferDevice(input({ compact_vehicle: compact(), protocol_features: protocol() }));
    expect(empty.state).toBe('unknown');
    expect(empty.limitations).not.toContain('compact_evidence_missing');
    expect(empty.limitations).not.toContain('missing_protocol_fields');
    expect(inferDevice(input({ compact_vehicle: compact({ parsed_reports: 0 }) })).limitations)
      .toContain('vehicle:no_parsed_reports');
    expect(inferDevice(input({ compact_vehicle: compact({ malformed_reports: 1 }) })).limitations)
      .toContain('vehicle:malformed_evidence');
  });

  it.each([
    [1, 'e_bike_related'], [1 << 5, 'car_related'],
  ] as const)('retains compact evidence and provenance for mask %i', (mask, category) => {
    const result = inferDevice(input({ compact_vehicle: compact({ name_brand_mask: mask }) }));
    expect(result).toMatchObject({ category, state: 'candidate', evidence_grade: 'brand_or_scheme_hint',
      source: 'offline_replay', ruleset_version: DEVICE_INFERENCE_RULESET_VERSION });
    expect(result.input_versions).toMatchObject({ schema: DEVICE_INFERENCE_INPUT_VERSION,
      compact_vehicle: COMPACT_VEHICLE_SCHEMA_VERSION, dictionary: PROTOCOL_DICTIONARY_VERSION });
    expect(result.evidence).toContainEqual(expect.objectContaining({ source: 'compact_vehicle', category }));
  });

  it('retains ecosystems as roles without converting shared modules into vehicles', () => {
    for (const evidence of [compact({ ecosystem_mask: 1 }), compact({ name_brand_mask: 1 << 6 })]) {
      const result = inferDevice(input({ compact_vehicle: evidence }));
      expect(result).toMatchObject({ category: 'unknown', state: 'unknown' });
      expect(result.roles).toEqual(['vehicle_ecosystem_candidate']);
      expect(result.evidence).not.toEqual([]);
    }
  });

  it('keeps incompatible car/e-bike matches as conflicts rather than picking a winner', () => {
    const result = inferDevice(input({ compact_vehicle: compact({ name_brand_mask: 1 | (1 << 5) }) }));
    expect(result).toMatchObject({ state: 'conflicting', category: 'unknown', evidence_grade: 'none' });
    expect(result.evidence.map(item => item.category)).toEqual(['e_bike_related', 'car_related']);
  });

  it('preserves the legacy exclusion policy without calling exclusions phones', () => {
    const result = inferDevice(input({ compact_vehicle: compact({ name_brand_mask: 1, exclusion_mask: 1 << 8 }) }));
    expect(result).toMatchObject({ category: 'unknown', state: 'unknown' });
    expect(result.exclusions).toEqual(['hid_service']);
    expect(result.limitations).toContain('vehicle:excluded_by_device_evidence');
    expect(result.evidence[0].category).toBe('e_bike_related');
  });

  it.each([0x03c1, 0x03c2])('requires both HID and a specific role for appearance %i', appearance => {
    const result = inferDevice(input({ protocol_features: protocol({ service_uuids16: [0x1812], appearances: [appearance] }) }));
    expect(result).toMatchObject({ category: 'other', state: 'candidate', evidence_grade: 'explicit_protocol_and_role' });
    expect(result.protocol_families).toEqual(['hid']);
    expect(inferDevice(input({ protocol_features: protocol({ appearances: [appearance] }) })).state).toBe('unknown');
    expect(inferDevice(input({ protocol_features: protocol({ service_uuids16: [0x1812] }) })).state).toBe('unknown');
  });

  it('does not treat HID alone as a blanket vehicle exclusion', () => {
    const result = inferDevice(input({ compact_vehicle: compact({ name_brand_mask: 1 }),
      protocol_features: protocol({ service_uuids16: [0x1812] }) }));
    expect(result).toMatchObject({ category: 'e_bike_related', state: 'candidate' });
    expect(result.protocol_families).toEqual(['hid']);
    expect(result.exclusions).toEqual([]);
    const conflicting = inferDevice(input({ compact_vehicle: compact({ name_brand_mask: 1 }),
      protocol_features: protocol({ service_uuids16: [0x1812], appearances: [0x03c1] }) }));
    expect(conflicting).toMatchObject({ category: 'unknown', state: 'conflicting' });
  });

  it('does not identify phones from company IDs, phone appearance or Fast Pair', () => {
    for (const features of [
      protocol({ manufacturer_company_ids: [0x004c] }),
      protocol({ manufacturer_company_ids: [0x00e0], appearances: [0x0040] }),
      protocol({ service_uuids16: [0xfe2c], appearances: [0x0040], manufacturer_company_ids: [0x004c] }),
      // Watch, tablet, HID digitizer tablet and Scan Parameters are counterexamples.
      protocol({ appearances: [0x00c0, 0x0087, 0x03c5], service_uuids16: [0x1813] }),
    ]) {
      const result = inferDevice(input({ protocol_features: features }));
      expect(result).toMatchObject({ category: 'unknown', state: 'unknown', evidence_grade: 'none' });
      expect(result.limitations).toContain('phone_rules_not_available');
    }
    const fastPair = inferDevice(input({ protocol_features: protocol({ service_uuids16: [0xfe2c] }) }));
    expect(fastPair.protocol_families).toEqual(['fast_pair_related']);
    expect(fastPair.evidence[0]).toMatchObject({ category: 'unknown', grade: 'protocol_hint' });
  });

  it('preserves field absence separately from known empty lists', () => {
    const result = inferDevice(input({ protocol_features: {
      schema_version: PROTOCOL_FEATURE_VERSION, extractor_version: PARSER_VERSION, parse_status: 'ok',
      appearances: [],
    } }));
    expect(result.missing_protocol_fields).toEqual(['service_uuids16', 'manufacturer_company_ids']);
    expect(result.limitations).toContain('missing_protocol_fields');
  });

  it('fails closed on malformed or unsupported compact input even with a usable protocol', () => {
    for (const evidence of [compact({ malformed_reports: 1 }), compact({ name_brand_mask: 1 << 20 }),
      { ...compact(), schema_version: 'future' }, { ...compact(), address: 'PRIVATE_TEST_MARKER' }]) {
      const result = inferDevice(input({ compact_vehicle: evidence as CompactVehicleEvidence,
        protocol_features: protocol({ service_uuids16: [0x1812], appearances: [0x03c1] }) }));
      expect(result).toMatchObject({ category: 'unknown', state: 'unknown' });
    }
  });

  it('fails closed on unknown fields, versions, malformed lists and unusable parse quality', () => {
    const badFeatures: unknown[] = [
      [], 'invalid', { ...protocol(), schema_version: 'future' },
      { ...protocol(), extractor_version: 'future' }, { ...protocol(), address: 'PRIVATE_TEST_MARKER' },
      { ...protocol(), service_uuids16: [0x10000] }, { ...protocol(), appearances: [NaN] },
      { ...protocol(), manufacturer_company_ids: [-1] }, { ...protocol(), appearances: 'keyboard' },
      { ...protocol(), service_uuids16: Array.from({ length: 129 }, () => 0x1812) },
      { ...protocol(), parse_status: 'malformed' }, { ...protocol(), parse_status: 'unknown' },
    ];
    for (const features of badFeatures) {
      const result = inferDevice(input({ compact_vehicle: compact({ name_brand_mask: 1 }),
        protocol_features: features as DeviceProtocolFeatures }));
      expect(result).toMatchObject({ category: 'unknown', state: 'unknown' });
    }
    for (const bad of [null, [], 'invalid', { ...input(), schema_version: 'future' },
      { ...input(), source: 'future' }, { ...input(), raw: 'PRIVATE_TEST_MARKER' }]) {
      expect(inferDevice(bad as DeviceInferenceInput)).toMatchObject({ category: 'unknown', state: 'unknown' });
    }
  });

  it('is deterministic, does not mutate inputs, and does not echo private unexpected fields', () => {
    const original = input({ compact_vehicle: compact({ name_brand_mask: 1 }),
      protocol_features: protocol({ service_uuids16: [0xfe2c, 0xfe2c] }) });
    const snapshot = structuredClone(original);
    const first = inferDevice(original);
    expect(inferDevice(original)).toEqual(first);
    expect(original).toEqual(snapshot);
    expect(first.protocol_families).toEqual(['fast_pair_related']);
    const serialized = JSON.stringify(inferDevice({ ...original, raw: 'PRIVATE_TEST_MARKER' } as DeviceInferenceInput));
    expect(serialized).not.toContain('PRIVATE_TEST_MARKER');
    expect(first.limitations).toContain('not_a_device_or_people_count');
    expect(first).not.toHaveProperty('estimated_total');
    expect(first).not.toHaveProperty('probability');
  });
});

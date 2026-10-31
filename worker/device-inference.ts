/** Offline/replayable candidate inference. This module performs no association,
 * counting, storage or networking and must receive evidence for one scoped
 * address/type/window from its caller. It never accepts raw names or addresses.
 * Vehicle matches retain the existing rules' provenance and limitations.
 */
import { PARSER_VERSION } from './ble-ad';
import {
  classifyCompactVehicleEvidence, COMPACT_VEHICLE_SCHEMA_VERSION, VEHICLE_RULESET_VERSION,
  type CompactVehicleEvidence, type VehicleCategory,
} from './vehicle-rules';

export const DEVICE_INFERENCE_INPUT_VERSION = 'device-inference-input-v1' as const;
export const DEVICE_INFERENCE_RESULT_VERSION = 'device-inference-result-v1' as const;
export const DEVICE_INFERENCE_RULESET_VERSION = 'device-inference-rules-v1' as const;
export const PROTOCOL_FEATURE_VERSION = 'device-protocol-features-v1' as const;
/** A deliberately small, frozen dictionary, not the complete SIG registry. */
export const PROTOCOL_DICTIONARY_VERSION = 'sig-hid-fast-pair-subset-2026-10-30' as const;

export type DeviceCategory = 'phone_related' | 'e_bike_related' | 'car_related' | 'other' | 'unknown';
export type InferenceSource = 'backend_compact' | 'offline_replay';
export type EvidenceGrade = 'brand_or_scheme_hint' | 'protocol_hint' | 'explicit_protocol_and_role';
export interface DeviceProtocolFeatures {
  schema_version: typeof PROTOCOL_FEATURE_VERSION;
  /** Only the existing parser is supported; callers must not invent a version. */
  extractor_version: typeof PARSER_VERSION;
  parse_status: 'ok' | 'malformed' | 'unknown';
  /** Absent/null means unknown; [] means collected and empty. Lists include
   * repeated AD fields and normalized Bluetooth-base UUIDs from all widths. */
  service_uuids16?: readonly number[] | null;
  appearances?: readonly number[] | null;
  manufacturer_company_ids?: readonly number[] | null;
}
export interface DeviceInferenceInput {
  schema_version: typeof DEVICE_INFERENCE_INPUT_VERSION;
  source: InferenceSource;
  compact_vehicle?: CompactVehicleEvidence | null;
  protocol_features?: DeviceProtocolFeatures | null;
}
export interface DeviceInferenceEvidence {
  source: 'compact_vehicle' | 'protocol_features';
  /** Public rule tokens only; observed values are intentionally omitted. */
  rule_id: string;
  category: DeviceCategory;
  grade: EvidenceGrade;
}
export interface DeviceInferenceResult {
  schema_version: typeof DEVICE_INFERENCE_RESULT_VERSION;
  ruleset_version: typeof DEVICE_INFERENCE_RULESET_VERSION;
  source: InferenceSource | null;
  input_versions: {
    schema: typeof DEVICE_INFERENCE_INPUT_VERSION | null;
    compact_vehicle: typeof COMPACT_VEHICLE_SCHEMA_VERSION | null;
    vehicle_rules: typeof VEHICLE_RULESET_VERSION | null;
    protocol_features: typeof PROTOCOL_FEATURE_VERSION | null;
    extractor: typeof PARSER_VERSION | null;
    dictionary: typeof PROTOCOL_DICTIONARY_VERSION;
  };
  category: DeviceCategory;
  state: 'candidate' | 'unknown' | 'conflicting';
  evidence_grade: EvidenceGrade | 'none';
  evidence: DeviceInferenceEvidence[];
  exclusions: string[];
  protocol_families: Array<'hid' | 'fast_pair_related'>;
  roles: Array<'vehicle_ecosystem_candidate' | 'keyboard_candidate' | 'mouse_candidate'>;
  missing_protocol_fields: Array<'service_uuids16' | 'appearances' | 'manufacturer_company_ids'>;
  limitations: string[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const uint16List = (value: unknown): boolean => value == null || (Array.isArray(value)
  && value.length <= 128 && value.every(item => typeof item === 'number'
    && Number.isInteger(item) && item >= 0 && item <= 0xffff));
const category = (value: VehicleCategory): DeviceCategory => value === 'vehicle_ecosystem' ? 'unknown' : value;

/** Deterministic pure function with fail-closed runtime validation. `phone_related`
 * is reserved: this version has no validated phone-specific protocol/model rule.
 * A company assignment, Phone appearance, FindMy label or Fast Pair hint cannot
 * establish a phone, terminal brand, AirTag, vehicle count or physical identity.
 */
export function inferDevice(input: DeviceInferenceInput): DeviceInferenceResult {
  const result: DeviceInferenceResult = {
    schema_version: DEVICE_INFERENCE_RESULT_VERSION, ruleset_version: DEVICE_INFERENCE_RULESET_VERSION,
    source: null,
    input_versions: { schema: null, compact_vehicle: null, vehicle_rules: null,
      protocol_features: null, extractor: null, dictionary: PROTOCOL_DICTIONARY_VERSION },
    category: 'unknown', state: 'unknown', evidence_grade: 'none', evidence: [], exclusions: [],
    protocol_families: [], roles: [], missing_protocol_fields: [],
    limitations: ['not_device_identity', 'not_a_device_or_people_count', 'presence_not_evaluated',
      'phone_rules_not_available'],
  };
  const limit = (reason: string) => { if (!result.limitations.includes(reason)) result.limitations.push(reason); };
  if (!object(input) || Object.keys(input).some(key => ![
    'schema_version', 'source', 'compact_vehicle', 'protocol_features',
  ].includes(key))) { limit('malformed_input'); return result; }
  if (input.schema_version !== DEVICE_INFERENCE_INPUT_VERSION) {
    limit('unsupported_input_version'); return result;
  }
  result.input_versions.schema = DEVICE_INFERENCE_INPUT_VERSION;
  if (input.source !== 'backend_compact' && input.source !== 'offline_replay') {
    limit('unsupported_source'); return result;
  }
  result.source = input.source;
  let blocked = false;
  let conflicting = false;
  const candidates = new Set<DeviceCategory>();
  if (input.compact_vehicle != null) {
    const vehicle = classifyCompactVehicleEvidence(input.compact_vehicle);
    if (input.compact_vehicle.schema_version === COMPACT_VEHICLE_SCHEMA_VERSION) {
      result.input_versions.compact_vehicle = COMPACT_VEHICLE_SCHEMA_VERSION;
      result.input_versions.vehicle_rules = VEHICLE_RULESET_VERSION;
    }
    for (const reason of vehicle.limitations) limit(`vehicle:${reason}`);
    blocked = vehicle.limitations.some(reason => [
      'malformed_evidence', 'unsupported_evidence_version', 'no_parsed_reports',
    ].includes(reason));
    conflicting = vehicle.limitations.includes('conflicting_vehicle_categories');
    result.evidence.push(...vehicle.evidence.map(item => ({ source: 'compact_vehicle' as const,
      rule_id: item.rule_id, category: category(item.category), grade: 'brand_or_scheme_hint' as const })));
    result.exclusions = [...new Set(vehicle.exclusions.map(item => item.rule_id))];
    if (vehicle.evidence.some(item => item.category === 'vehicle_ecosystem')) {
      result.roles.push('vehicle_ecosystem_candidate');
    }
    if (vehicle.category === 'e_bike_related' || vehicle.category === 'car_related') candidates.add(vehicle.category);
    // Preserve the deployed vehicle rules' exclusion policy, without inferring
    // that an HID-capable device is necessarily unrelated to vehicles.
    if (vehicle.exclusions.length) blocked = true;
  } else limit('compact_evidence_missing');

  const features = input.protocol_features;
  if (features == null) limit('protocol_features_missing');
  else if (!object(features)) { limit('malformed_protocol_features'); blocked = true; }
  else if (features.schema_version !== PROTOCOL_FEATURE_VERSION || features.extractor_version !== PARSER_VERSION) {
    limit('unsupported_protocol_version'); blocked = true;
  } else {
    result.input_versions.protocol_features = PROTOCOL_FEATURE_VERSION;
    result.input_versions.extractor = PARSER_VERSION;
    const fields = ['service_uuids16', 'appearances', 'manufacturer_company_ids'] as const;
    result.missing_protocol_fields = fields.filter(field => features[field] == null);
    if (result.missing_protocol_fields.length) limit('missing_protocol_fields');
    if (Object.keys(features).some(key => ![
      'schema_version', 'extractor_version', 'parse_status', ...fields,
    ].includes(key)) || !fields.every(field => uint16List(features[field]))) {
      limit('malformed_protocol_features'); blocked = true;
    } else if (features.parse_status !== 'ok') {
      limit(features.parse_status === 'malformed' ? 'malformed_protocol_features' : 'unknown_protocol_parse_status');
      blocked = true;
    } else {
      const services = features.service_uuids16 ?? [];
      const appearances = features.appearances ?? [];
      // SIG assigned numbers: 0x1812 HID, 0x03c1 keyboard, 0x03c2 mouse.
      // https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Assigned_Numbers/out/en/index-en.html
      if (services.includes(0x1812)) {
        result.protocol_families.push('hid');
        result.evidence.push({ source: 'protocol_features', rule_id: 'protocol:hid_service',
          category: 'unknown', grade: 'protocol_hint' });
        for (const [appearance, role] of [[0x03c1, 'keyboard'], [0x03c2, 'mouse']] as const) {
          if (!appearances.includes(appearance)) continue;
          result.roles.push(`${role}_candidate`);
          result.evidence.push({ source: 'protocol_features', rule_id: `protocol:hid_${role}_appearance`,
            category: 'other', grade: 'explicit_protocol_and_role' });
          candidates.add('other');
        }
      }
      // UUID alone is a related-protocol clue, not a model or provider validation.
      // https://developers.google.com/nearby/fast-pair/specifications/service/provider
      if (services.includes(0xfe2c)) {
        result.protocol_families.push('fast_pair_related');
        result.evidence.push({ source: 'protocol_features', rule_id: 'protocol:fast_pair_service_hint',
          category: 'unknown', grade: 'protocol_hint' });
      }
      if (appearances.includes(0x0040)) limit('phone_appearance_insufficient');
      if (features.manufacturer_company_ids?.length) limit('company_assignment_not_device_class');
    }
  }
  if (candidates.size > 1) conflicting = true;
  if (conflicting) { result.state = 'conflicting'; limit('conflicting_device_categories'); }
  else if (!blocked && candidates.size === 1) {
    result.category = [...candidates][0];
    result.state = 'candidate';
    result.evidence_grade = result.category === 'other' ? 'explicit_protocol_and_role' : 'brand_or_scheme_hint';
  }
  if (result.state === 'unknown') limit('insufficient_or_unusable_evidence');
  return result;
}

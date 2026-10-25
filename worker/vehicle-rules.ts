/**
 * Selected rule tables and ASCII matching are adapted from AI Passport Radar
 * main/veh_rules.c, dev_phone.c and ad_parse.h, imported at
 * 5fb8ab532414eb0029fc5ea131a03cb0993db180. MIT, Copyright (c) 2026 FoloToy.
 * The full notice is retained in firmware/ai-passport-radar/LICENSE.
 *
 * These are advertisement clues, not verified device identities or counts.
 * Intentional changes from Radar: separated vehicle categories; bounded brand
 * tokens; empirical module IDs only imply an ecosystem candidate; exclusions
 * always win; malformed inputs cannot yield a candidate. Generic UUIDs, packet
 * length, connectability and the old 10s dwell do not prove vehicle identity.
 */
import type { ParsedAdvertisement } from './ble-ad';

export const VEHICLE_RULESET_VERSION = 'campuspulse-vehicle-rules-v1' as const;
export const VEHICLE_EVIDENCE_VERSION = 'vehicle-evidence-v1' as const;
export const COMPACT_VEHICLE_SCHEMA_VERSION = 'radar-compact-v1' as const;
/** Historical presence policy only; this classifier does not apply it. */
export const LEGACY_VEHICLE_DWELL_MS = 10_000;

export type VehicleCategory = 'e_bike_related' | 'car_related' | 'vehicle_ecosystem' | 'unknown';
export type VehicleEvidenceField = 'names' | 'manufacturers' | 'service_uuids16' | 'appearances';
export interface VehicleEvidenceInput {
  schema_version?: typeof VEHICLE_EVIDENCE_VERSION;
  /** `ok` means the supplied evidence was parsed/validated, not device validation. */
  parse_status?: 'ok' | 'malformed' | 'unknown';
  /** Omission means not collected/unknown; [] means collected with no such field. */
  names?: readonly string[] | null;
  manufacturers?: readonly { company_id: number; apple_subtype?: number | null }[] | null;
  /** UUID-list and service-data values, already normalized to 16-bit integers. */
  service_uuids16?: readonly number[] | null;
  appearances?: readonly number[] | null;
  connectable?: boolean | null;
  has_uuid128?: boolean | null;
}
export interface VehicleEvidenceMatch {
  rule_id: string;
  source: 'name' | 'manufacturer';
  category: VehicleCategory;
  /** A fixed rule token or assigned integer, never a full observed name/address. */
  matched_value: string | number;
}
export interface VehicleExclusion {
  rule_id: string;
  source: 'name' | 'manufacturer' | 'service_uuid' | 'appearance';
  matched_value: string | number;
}
export type VehicleLimitation =
  | 'not_a_vehicle_count' | 'presence_not_evaluated' | 'missing_evidence_fields'
  | 'malformed_evidence' | 'unknown_parse_status' | 'unsupported_evidence_version'
  | 'unrecognized_evidence_fields' | 'generic_radio_traits_not_vehicle_evidence'
  | 'ambiguous_legacy_name' | 'legacy_module_identity_unverified'
  | 'conflicting_vehicle_categories' | 'excluded_by_device_evidence'
  | 'no_positive_vehicle_evidence' | 'compact_evidence_missing' | 'no_parsed_reports';
export interface VehicleClassification {
  ruleset_version: typeof VEHICLE_RULESET_VERSION;
  category: VehicleCategory;
  confidence: 'rule_based_candidate' | 'none';
  evidence: VehicleEvidenceMatch[];
  exclusions: VehicleExclusion[];
  missing_fields: VehicleEvidenceField[];
  limitations: VehicleLimitation[];
}
/** Optional versioned per-address evidence. The five numeric C fields total 16
 * bytes; JSON representation is larger. Omit when firmware did not collect it.
 * Names/addresses/payloads are intentionally not part of this object. */
export interface CompactVehicleEvidence {
  schema_version: typeof COMPACT_VEHICLE_SCHEMA_VERSION;
  parsed_reports: number;
  malformed_reports: number;
  name_brand_mask: number;
  exclusion_mask: number;
  ecosystem_mask: number;
}
/** Frozen wire bit order; coordinated with cp_vehicle.h. */
export const COMPACT_VEHICLE_EXCLUSIONS = [
  ['peripheral_name', 'name'], ['phone_name', 'name'], ['office_company', 'manufacturer'],
  ['phone_vendor_company', 'manufacturer'], ['consumer_electronics_company', 'manufacturer'],
  ['phone_related_apple_subtype', 'manufacturer'], ['fast_pair_related_service', 'service_uuid'],
  ['legacy_gadget_service', 'service_uuid'], ['hid_service', 'service_uuid'],
  ['phone_appearance', 'appearance'], ['gadget_appearance', 'appearance'],
] as const;

// Exact imported primitive tables. The tests compare these helpers to compiled
// imported C independently; that equivalence does not extend to the classifier.
export const RADAR_VEHICLE_NAME_PATTERNS = [
  'yadea', 'aima', 'tailg', 'luyuan', 'zeeho', 'byd', 'ninebot', 'segway',
  'soco', 'sunra', 'niu-', '^yd', '^tl_', 'xiaodao', 'lima', '^niu',
  'smartbike', 'bdb-pke', '^ebike', '^zub',
] as const;
const OFFICE_COMPANIES = new Set([
  0x0065, 0x011b, 0x0040, 0x0004, 0x018b, 0x01a9, 0x01f1,
  0x025d, 0x065f, 0x0755, 0x041e, 0x0381, 0x02ea,
]);
const PHONE_COMPANIES = new Set([
  0x00e0, 0x0075, 0x0837, 0x8486, 0x027d, 0x09c6, 0x038f,
  0x079a, 0x072f, 0x08a4, 0x03ab, 0x08ca, 0x02c5, 0x0008,
]);
const GADGET_SERVICES = new Set([0xfdf7, 0xfd92, 0xfebe]);
const PERIPHERAL_NAMES = [
  'mouse', 'keyboard', 'kbd', 'trackpad', 'touchpad', 'buds', 'earbud', 'airpod',
  'headphone', 'headset', 'speaker', 'watch', 'band', 'pen', 'stylus', 'printer',
  'ikf', 'qcy', 'edifier', 'soundcore', 'baseus', 'jbl', 'bose', 'deli',
  'desktop-', 'laptop-', 'tws',
] as const;
const PHONE_NAMES = [
  'iphone', 'galaxy', 'pixel', 'redmi', 'huawei', 'honor', 'oneplus',
  'oppo', 'vivo', 'xiaomi', 'mi ', 'realme',
] as const;
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, char => char.toLowerCase());
const legacyNameMatches = (name: string, pattern: string): boolean => pattern.startsWith('^')
  ? asciiLower(name).startsWith(pattern.slice(1)) : asciiLower(name).includes(pattern);

export const radarNameIsVehicle = (name: string): boolean => RADAR_VEHICLE_NAME_PATTERNS.some(pattern => legacyNameMatches(name, pattern));
export const radarCompanyIsOffice = (companyId: number): boolean => OFFICE_COMPANIES.has(companyId);
export const radarCompanyIsPhoneVendor = (companyId: number): boolean => PHONE_COMPANIES.has(companyId);
export const radarServiceIsGadget = (service: number): boolean => GADGET_SERVICES.has(service);
export const radarNameIsPeripheral = (name: string): boolean => PERIPHERAL_NAMES.some(word => asciiLower(name).includes(word));
/** Parity with dev_phone_is_phone when only a name is supplied. */
export const radarNameIsPhone = (name: string): boolean => !radarNameIsPeripheral(name)
  && PHONE_NAMES.some(word => asciiLower(name).includes(word));
export function radarAppearanceIsGadget(value: number): boolean {
  return [[0x0080, 0x008f], [0x00c0, 0x00c2], [0x0300, 0x03ff],
    [0x0440, 0x044f], [0x0480, 0x048f], [0x0540, 0x057f]]
    .some(([min, max]) => value >= min && value <= max);
}

function boundedNameMatch(name: string, pattern: string): boolean {
  const lower = asciiLower(name);
  if (pattern === '^yd') return /^yd(?:[0-9 _-]|$)/.test(lower);
  if (pattern === '^niu') return /^niu(?:[ _-]|$)/.test(lower);
  if (pattern === '^ebike') return /^ebike(?:[^a-z]|$)/.test(lower);
  if (pattern.startsWith('^')) return lower.startsWith(pattern.slice(1));
  // Deliberately stricter than the imported substring match (e.g. "Laima").
  return new RegExp(`(?:^|[^a-z])${pattern}(?=$|[^a-z])`).test(lower);
}
function categoryForName(pattern: string): VehicleCategory {
  if (pattern === 'byd') return 'car_related';
  if (['ninebot', 'segway', 'smartbike', 'bdb-pke'].includes(pattern)) return 'vehicle_ecosystem';
  if (pattern === '^zub') return 'unknown'; // Upstream itself leaves identity unconfirmed.
  return 'e_bike_related';
}
const EVIDENCE_FIELDS: VehicleEvidenceField[] = ['names', 'manufacturers', 'service_uuids16', 'appearances'];
const INPUT_FIELDS = new Set<string>(['schema_version', 'parse_status', ...EVIDENCE_FIELDS, 'connectable', 'has_uuid128']);
const isUint = (value: unknown, max: number): value is number => typeof value === 'number'
  && Number.isInteger(value) && value >= 0 && value <= max;
const optionalArray = (value: unknown, predicate: (item: unknown) => boolean): boolean =>
  value == null || (Array.isArray(value) && value.length <= 128 && value.every(predicate));

function emptyClassification(): VehicleClassification {
  return {
    ruleset_version: VEHICLE_RULESET_VERSION, category: 'unknown', confidence: 'none',
    evidence: [], exclusions: [], missing_fields: [],
    limitations: ['not_a_vehicle_count', 'presence_not_evaluated'],
  };
}
function completeClassification(result: VehicleClassification): VehicleClassification {
  const limit = (value: VehicleLimitation) => { if (!result.limitations.includes(value)) result.limitations.push(value); };
  const categories = new Set(result.evidence.map(item => item.category).filter(value => value !== 'unknown'));
  if (categories.has('e_bike_related') && categories.has('car_related')) limit('conflicting_vehicle_categories');
  if (result.exclusions.length) limit('excluded_by_device_evidence');
  if (!categories.size) limit('no_positive_vehicle_evidence');
  if (!result.exclusions.length && !result.limitations.includes('conflicting_vehicle_categories')
      && !result.limitations.includes('malformed_evidence') && !result.limitations.includes('no_parsed_reports')) {
    result.category = categories.has('e_bike_related') ? 'e_bike_related'
      : categories.has('car_related') ? 'car_related'
        : categories.has('vehicle_ecosystem') ? 'vehicle_ecosystem' : 'unknown';
  }
  if (result.category !== 'unknown') result.confidence = 'rule_based_candidate';
  return result;
}

/**
 * Pure per-report/per-summary classifier. No address association, timing or
 * counting happens here. Compact input must be authenticated/validated by its
 * caller; raw bytes remain the caller's evidence, never this result's payload.
 */
export function classifyVehicleEvidence(input: VehicleEvidenceInput): VehicleClassification {
  const result = emptyClassification();
  const limit = (value: VehicleLimitation) => { if (!result.limitations.includes(value)) result.limitations.push(value); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    limit('malformed_evidence');
    return result;
  }
  result.missing_fields = EVIDENCE_FIELDS.filter(key => input[key] == null);
  if (result.missing_fields.length) limit('missing_evidence_fields');
  if (Object.keys(input).some(key => !INPUT_FIELDS.has(key))) limit('unrecognized_evidence_fields');
  if (input.schema_version !== undefined && input.schema_version !== VEHICLE_EVIDENCE_VERSION) {
    limit('unsupported_evidence_version');
    return result;
  }
  if (input.parse_status !== 'ok') {
    limit(input.parse_status === 'malformed' ? 'malformed_evidence' : 'unknown_parse_status');
    return result;
  }
  const valid = optionalArray(input.names, item => typeof item === 'string' && item.length <= 248
      && !/[\p{Cc}\p{Cf}\ufffd]/u.test(item))
    && optionalArray(input.manufacturers, item => !!item && typeof item === 'object'
      && isUint((item as { company_id?: unknown }).company_id, 0xffff)
      && ((item as { apple_subtype?: unknown }).apple_subtype == null
        || isUint((item as { apple_subtype?: unknown }).apple_subtype, 0xff)))
    && optionalArray(input.service_uuids16, item => isUint(item, 0xffff))
    && optionalArray(input.appearances, item => isUint(item, 0xffff))
    && (input.connectable == null || typeof input.connectable === 'boolean')
    && (input.has_uuid128 == null || typeof input.has_uuid128 === 'boolean');
  if (!valid) { limit('malformed_evidence'); return result; }
  if (input.has_uuid128 || input.connectable) limit('generic_radio_traits_not_vehicle_evidence');

  const addEvidence = (evidence: VehicleEvidenceMatch) => {
    if (!result.evidence.some(item => item.rule_id === evidence.rule_id)) result.evidence.push(evidence);
  };
  const exclude = (rule_id: string, source: VehicleExclusion['source'], matched_value: string | number) => {
    if (!result.exclusions.some(item => item.rule_id === rule_id && item.matched_value === matched_value)) {
      result.exclusions.push({ rule_id, source, matched_value });
    }
  };
  for (const name of input.names ?? []) {
    for (const pattern of RADAR_VEHICLE_NAME_PATTERNS) {
      if (!boundedNameMatch(name, pattern)) continue;
      const category = categoryForName(pattern);
      addEvidence({ rule_id: `name:${pattern}`, source: 'name', category, matched_value: pattern });
      if (category === 'unknown') limit('ambiguous_legacy_name');
    }
    const lower = asciiLower(name);
    for (const word of PERIPHERAL_NAMES) if (lower.includes(word)) exclude('peripheral_name', 'name', word);
    if (radarNameIsPhone(name)) {
      for (const word of PHONE_NAMES) if (lower.includes(word)) exclude('phone_name', 'name', word);
    }
  }
  for (const item of input.manufacturers ?? []) {
    if (radarCompanyIsOffice(item.company_id)) exclude('office_company', 'manufacturer', item.company_id);
    if (radarCompanyIsPhoneVendor(item.company_id)) exclude('phone_vendor_company', 'manufacturer', item.company_id);
    if ([0x004c, 0x0006].includes(item.company_id)) exclude('consumer_electronics_company', 'manufacturer', item.company_id);
    if (item.company_id === 0x004c && item.apple_subtype != null && [0x0c, 0x0f, 0x10].includes(item.apple_subtype)) {
      exclude('phone_related_apple_subtype', 'manufacturer', item.apple_subtype);
    }
    if ([0x0020, 0x1010].includes(item.company_id)) {
      addEvidence({ rule_id: `legacy_module:${item.company_id}`, source: 'manufacturer', category: 'vehicle_ecosystem', matched_value: item.company_id });
      limit('legacy_module_identity_unverified');
    }
  }
  for (const service of input.service_uuids16 ?? []) {
    if ([0xfe2c, 0xfe26].includes(service)) exclude('fast_pair_related_service', 'service_uuid', service);
    if (radarServiceIsGadget(service)) exclude('legacy_gadget_service', 'service_uuid', service);
    if (service === 0x1812) exclude('hid_service', 'service_uuid', service);
    // 0x1813 is Scan Parameters, not HID as claimed in the old ad_parse.h.
    // SIG: https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Assigned_Numbers/out/en/index-en.html
  }
  for (const appearance of input.appearances ?? []) {
    if (appearance === 0x0040) exclude('phone_appearance', 'appearance', appearance);
    if (radarAppearanceIsGadget(appearance)) exclude('gadget_appearance', 'appearance', appearance);
  }
  return completeClassification(result);
}

/** Decode only known, validated bits. Unknown versions/bits fail closed. A
 * malformed report anywhere in this address/window makes its candidate abstain;
 * valid-report clues remain available for explanation. No dwell is fabricated. */
export function classifyCompactVehicleEvidence(input?: CompactVehicleEvidence | null): VehicleClassification {
  const result = emptyClassification();
  if (input == null) {
    result.limitations.push('compact_evidence_missing');
    return result;
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    result.limitations.push('malformed_evidence');
    return result;
  }
  if (input.schema_version !== COMPACT_VEHICLE_SCHEMA_VERSION) {
    result.limitations.push('unsupported_evidence_version');
    return result;
  }
  const keys = ['schema_version', 'parsed_reports', 'malformed_reports', 'name_brand_mask', 'exclusion_mask', 'ecosystem_mask'];
  const valid = Object.keys(input).every(key => keys.includes(key))
    && isUint(input.parsed_reports, 0xffffffff) && isUint(input.malformed_reports, 0xffffffff)
    && isUint(input.name_brand_mask, 0xfffff) && isUint(input.exclusion_mask, 0x07ff)
    && isUint(input.ecosystem_mask, 0x0003)
    && (input.parsed_reports > 0 || (input.name_brand_mask === 0 && input.exclusion_mask === 0 && input.ecosystem_mask === 0));
  if (!valid) {
    result.limitations.push('malformed_evidence');
    return result;
  }
  if (input.malformed_reports) result.limitations.push('malformed_evidence');
  if (!input.parsed_reports) result.limitations.push('no_parsed_reports');
  for (let bit = 0; bit < RADAR_VEHICLE_NAME_PATTERNS.length; bit++) {
    if (!(input.name_brand_mask & (1 << bit))) continue;
    const pattern = RADAR_VEHICLE_NAME_PATTERNS[bit];
    const category = categoryForName(pattern);
    result.evidence.push({ rule_id: `name:${pattern}`, source: 'name', category, matched_value: pattern });
    if (category === 'unknown') result.limitations.push('ambiguous_legacy_name');
  }
  for (let bit = 0; bit < COMPACT_VEHICLE_EXCLUSIONS.length; bit++) {
    if (!(input.exclusion_mask & (1 << bit))) continue;
    const [rule_id, source] = COMPACT_VEHICLE_EXCLUSIONS[bit];
    result.exclusions.push({ rule_id, source, matched_value: `compact_bit:${bit}` });
  }
  for (const [bit, companyId] of [0x0020, 0x1010].entries()) {
    if (!(input.ecosystem_mask & (1 << bit))) continue;
    result.evidence.push({ rule_id: `legacy_module:${companyId}`, source: 'manufacturer', category: 'vehicle_ecosystem', matched_value: companyId });
  }
  if (input.ecosystem_mask) result.limitations.push('legacy_module_identity_unverified');
  return completeClassification(result);
}

/** Use every repeated AD field; do not copy the C parser's first/last-field loss. */
export function classifyVehicleAdvertisement(
  parsed: ParsedAdvertisement,
  context: { connectable?: boolean | null } = {},
): VehicleClassification {
  const service16 = [...parsed.service_uuids, ...parsed.service_data]
    // Bluetooth-base UUIDs may be carried in wider fields as well. Exclusions
    // follow the value, not just the encoding width used by the advertiser.
    .filter(item => /^0000[0-9a-f]{4}-0000-1000-8000-00805f9b34fb$/i.test(item.uuid))
    .map(item => Number.parseInt(item.uuid.slice(0, 8), 16));
  return classifyVehicleEvidence({
    schema_version: VEHICLE_EVIDENCE_VERSION,
    parse_status: parsed.parse_status,
    names: parsed.names.map(item => item.display_text),
    manufacturers: parsed.manufacturer_data.map(item => ({
      company_id: item.company_id,
      apple_subtype: item.company_id === 0x004c && item.vendor_data_length > 0
        ? Number.parseInt(item.vendor_data_hex.slice(0, 2), 16) : null,
    })),
    service_uuids16: service16,
    appearances: parsed.appearance.map(item => item.value),
    connectable: context.connectable ?? null,
    has_uuid128: [...parsed.service_uuids, ...parsed.service_data].some(item => item.source_width_bits === 128),
  });
}

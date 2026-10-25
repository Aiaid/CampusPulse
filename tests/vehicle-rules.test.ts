import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAdvertisement } from '../worker/ble-ad';
import {
  classifyCompactVehicleEvidence, classifyVehicleAdvertisement, classifyVehicleEvidence,
  COMPACT_VEHICLE_EXCLUSIONS, COMPACT_VEHICLE_SCHEMA_VERSION, LEGACY_VEHICLE_DWELL_MS,
  RADAR_VEHICLE_NAME_PATTERNS, radarAppearanceIsGadget, radarCompanyIsOffice,
  radarCompanyIsPhoneVendor, radarNameIsPeripheral, radarNameIsPhone,
  radarNameIsVehicle, radarServiceIsGadget, VEHICLE_EVIDENCE_VERSION,
  VEHICLE_RULESET_VERSION, type CompactVehicleEvidence, type VehicleEvidenceInput,
} from '../worker/vehicle-rules';

// Only authored synthetic evidence: no captures, real addresses or personal names.
const ad = (type: number, value: string) => (value.length / 2 + 1).toString(16).padStart(2, '0')
  + type.toString(16).padStart(2, '0') + value;
const nameAd = (name: string) => ad(0x09, Buffer.from(name).toString('hex'));
const classify = (name: string, more = '') => classifyVehicleAdvertisement(parseAdvertisement(nameAd(name) + more));
const full = (extra: Partial<VehicleEvidenceInput> = {}): VehicleEvidenceInput => ({
  schema_version: VEHICLE_EVIDENCE_VERSION, parse_status: 'ok', names: [],
  manufacturers: [], service_uuids16: [], appearances: [], ...extra,
});

describe('versioned vehicle candidate evidence', () => {
  it.each([
    ['YADEA-SYNTHETIC', 'e_bike_related'], ['AIMA SYNTHETIC', 'e_bike_related'],
    ['TAILG-SYNTHETIC', 'e_bike_related'], ['LUYUAN-SYNTHETIC', 'e_bike_related'],
    ['ZEEHO-SYNTHETIC', 'e_bike_related'], ['YD00000000', 'e_bike_related'],
    ['TL_SYNTHETIC', 'e_bike_related'], ['NIU SYNTHETIC', 'e_bike_related'],
    ['EBIKE(SYNTHETIC)', 'e_bike_related'], ['BYD SYNTHETIC', 'car_related'],
    ['Segway SYNTHETIC', 'vehicle_ecosystem'], ['Ninebot SYNTHETIC', 'vehicle_ecosystem'],
    ['SmartBike SYNTHETIC', 'vehicle_ecosystem'], ['bdb-PKE-SYNTHETIC', 'vehicle_ecosystem'],
  ])('separates %s as %s without claiming physical identity', (name, category) => {
    const result = classify(name);
    expect(result).toMatchObject({ ruleset_version: VEHICLE_RULESET_VERSION, category, confidence: 'rule_based_candidate' });
    expect(result.limitations).toContain('not_a_vehicle_count');
    expect(result.limitations).toContain('presence_not_evaluated');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  });

  it('keeps BYD car keys out of e-bike candidates even with a generic private UUID', () => {
    const result = classify('BYD SYNTHETIC', ad(0x07, 'ffeeddccbbaa99887766554433221100'));
    expect(result.category).toBe('car_related');
    expect(result.evidence.every(item => item.category !== 'e_bike_related')).toBe(true);
  });

  it.each(['CodySynthetic', 'LaimaSynthetic', 'NIUTRITION', 'YDUMMY', 'genius', 'micar', 'Q_UNKNOWN'])
  ('does not promote the unrelated synthetic name %s', name => {
    expect(classify(name)).toMatchObject({ category: 'unknown', confidence: 'none' });
  });

  it('records unconfirmed upstream ZUB hints without identifying their vehicle type', () => {
    const result = classify('ZUB_SYNTHETIC');
    expect(result.category).toBe('unknown');
    expect(result.evidence).toEqual([{ rule_id: 'name:^zub', source: 'name', category: 'unknown', matched_value: '^zub' }]);
    expect(result.limitations).toContain('ambiguous_legacy_name');
  });

  it.each([0x0020, 0x1010])('limits empirical manufacturer hint %i to the vehicle ecosystem', company_id => {
    const result = classifyVehicleEvidence(full({ manufacturers: [{ company_id }] }));
    expect(result.category).toBe('vehicle_ecosystem');
    expect(result.limitations).toContain('legacy_module_identity_unverified');
  });

  it('does not promote connectability, generic private UUIDs, payload size or unknown services', () => {
    const payloads = ['', ad(0x07, 'ffeeddccbbaa99887766554433221100'), ad(0xff, 'ffffaabb'),
      ad(0xff, 'ffff00112233445566778899aabb'), ad(0x03, '3412'), ad(0x19, '0000')];
    for (const payload of payloads) {
      expect(classifyVehicleAdvertisement(parseAdvertisement(payload), { connectable: true }))
        .toMatchObject({ category: 'unknown', confidence: 'none', evidence: [] });
    }
    // Long manufacturer data is not a positive proof or a veto on a real clue.
    expect(classify('AIMA SYNTHETIC', ad(0xff, 'ffff00112233445566778899aabb')).category).toBe('e_bike_related');
  });

  it.each([
    ['office', ad(0xff, '6500'), 'office_company'],
    ['phone vendor', ad(0xff, '7500'), 'phone_vendor_company'],
    ['Apple short subtype', ad(0xff, '4c000f'), 'consumer_electronics_company'],
    ['Microsoft', ad(0xff, '0600'), 'consumer_electronics_company'],
    ['phone appearance', ad(0x19, '4000'), 'phone_appearance'],
    ['watch appearance', ad(0x19, 'c200'), 'gadget_appearance'],
    ['HID appearance', ad(0x19, 'c703'), 'gadget_appearance'],
    ['HID list', ad(0x03, '1218'), 'hid_service'],
    ['Fast Pair list', ad(0x03, '2cfe'), 'fast_pair_related_service'],
    ['Fast Pair service data', ad(0x16, '2cfe00'), 'fast_pair_related_service'],
    ['gadget list', ad(0x03, 'f7fd'), 'legacy_gadget_service'],
    ['gadget data', ad(0x16, '92fd00'), 'legacy_gadget_service'],
  ])('makes %s exclusion win over a vehicle brand', (_label, more, rule_id) => {
    const result = classify('YADEA SYNTHETIC', more);
    expect(result.category).toBe('unknown');
    expect(result.confidence).toBe('none');
    expect(result.evidence.some(item => item.category === 'e_bike_related')).toBe(true);
    expect(result.exclusions.some(item => item.rule_id === rule_id)).toBe(true);
  });

  it.each(['YADEA SYNTHETIC keyboard', 'AIMA SYNTHETIC Pixel', 'NIU SYNTHETIC TWS'])
  ('does not let a vehicle brand override phone/accessory names: %s', name => {
    expect(classify(name).category).toBe('unknown');
    expect(classify(name).exclusions.length).toBeGreaterThan(0);
  });

  it('checks every repeated manufacturer, service and appearance field', () => {
    const cases = [
      ad(0xff, '6500') + ad(0xff, '2000'),
      ad(0x16, '0f1800') + ad(0x16, 'f7fd00'),
      ad(0x19, 'c703') + ad(0x19, '0000'),
    ];
    for (const more of cases) expect(classify('YADEA SYNTHETIC', more).category).toBe('unknown');
  });

  it('does not repeat the inherited incorrect 0x1813 HID label/exclusion', () => {
    expect(classify('YADEA SYNTHETIC', ad(0x03, '1318')).category).toBe('e_bike_related');
    expect(classify('YADEA SYNTHETIC', ad(0x03, '1218')).category).toBe('unknown');
  });

  it('normalizes assigned UUID exclusions carried in wider Bluetooth-base fields', () => {
    expect(classify('YADEA SYNTHETIC', ad(0x05, '2cfe0000')).category).toBe('unknown');
    expect(classify('YADEA SYNTHETIC', ad(0x07, 'fb349b5f80000080001000002cfe0000')).category).toBe('unknown');
    expect(classify('YADEA SYNTHETIC', ad(0x21, 'fb349b5f80000080001000001218000000')).category).toBe('unknown');
  });

  it('abstains on conflicting car/e-bike names instead of selecting the first', () => {
    const result = classify('BYD SYNTHETIC', nameAd('YADEA SYNTHETIC'));
    expect(result.category).toBe('unknown');
    expect(result.limitations).toContain('conflicting_vehicle_categories');
  });

  it('keeps all known clue categories but prefers a specific non-conflicting category', () => {
    const result = classify('BYD SYNTHETIC', ad(0xff, '2000'));
    expect(result.category).toBe('car_related');
    expect(result.evidence.map(item => item.category)).toEqual(['car_related', 'vehicle_ecosystem']);
  });

  it('never identifies malformed AD even when a preceding field held a positive name', () => {
    const result = classify('YADEA SYNTHETIC', '050941');
    expect(result).toMatchObject({ category: 'unknown', confidence: 'none', evidence: [] });
    expect(result.limitations).toContain('malformed_evidence');
    expect(classifyVehicleAdvertisement(parseAdvertisement(nameAd('YADEA') + ad(0x09, 'c080'))).category).toBe('unknown');
  });

  it('distinguishes absent evidence from valid empty evidence', () => {
    const absent = classifyVehicleEvidence({});
    expect(absent.missing_fields).toEqual(['names', 'manufacturers', 'service_uuids16', 'appearances']);
    expect(absent.limitations).toContain('unknown_parse_status');
    expect(classifyVehicleEvidence(full()).missing_fields).toEqual([]);
    const partial = classifyVehicleEvidence({ parse_status: 'ok', names: ['YADEA SYNTHETIC'] });
    expect(partial.category).toBe('e_bike_related');
    expect(partial.limitations).toContain('missing_evidence_fields');
  });

  it('rejects unsupported versions and malformed runtime compact evidence without throwing', () => {
    const bad = [
      null, [], { names: 'YADEA' }, { names: [null] }, { names: ['YADEA\u0000'] },
      { manufacturers: [{ company_id: -1 }] }, { manufacturers: [{ company_id: 1, apple_subtype: 256 }] },
      { service_uuids16: [0x10000] }, { appearances: [0.5] }, { connectable: 'true' },
      { has_uuid128: 1 }, { names: Array.from({ length: 129 }, () => 'YADEA') },
    ];
    for (const fields of bad) {
      const input = fields === null || Array.isArray(fields) ? fields : { ...full(), ...fields };
      const result = classifyVehicleEvidence(input as VehicleEvidenceInput);
      expect(result.category).toBe('unknown');
      expect(result.limitations).toContain('malformed_evidence');
    }
    const result = classifyVehicleEvidence({ ...full({ names: ['YADEA'] }), schema_version: 'future' } as unknown as VehicleEvidenceInput);
    expect(result.category).toBe('unknown');
    expect(result.limitations).toContain('unsupported_evidence_version');
    expect(classifyVehicleEvidence({ ...full(), future_field: true } as VehicleEvidenceInput).limitations).toContain('unrecognized_evidence_fields');
  });

  it('gives the same candidate result for parsed AD and equivalent compact evidence', () => {
    const fromRaw = classify('YADEA SYNTHETIC', ad(0xff, '2000') + ad(0x03, '0f18'));
    const fromCompact = classifyVehicleEvidence(full({
      names: ['YADEA SYNTHETIC'], manufacturers: [{ company_id: 0x0020, apple_subtype: null }],
      service_uuids16: [0x180f], connectable: null, has_uuid128: false,
    }));
    expect(fromCompact).toEqual(fromRaw);
    expect(LEGACY_VEHICLE_DWELL_MS).toBe(10_000);
    expect(fromRaw.limitations).toContain('presence_not_evaluated');
  });

  it('does not mutate evidence supplied by a caller or leak full observed names', () => {
    const input = full({ names: ['YADEA SYNTHETIC'], manufacturers: [{ company_id: 0x0020 }] });
    const before = structuredClone(input);
    const first = classifyVehicleEvidence(input);
    expect(input).toEqual(before);
    expect(classifyVehicleEvidence(input)).toEqual(first);
    expect(JSON.stringify(first)).not.toContain('SYNTHETIC');
  });
});

describe('compact evidence and the independent C collector implementation', () => {
  let directory: string;
  let executable: string;
  const compact = (extra: Partial<CompactVehicleEvidence> = {}): CompactVehicleEvidence => ({
    schema_version: COMPACT_VEHICLE_SCHEMA_VERSION, parsed_reports: 1, malformed_reports: 0,
    name_brand_mask: 0, exclusion_mask: 0, ecosystem_mask: 0, ...extra,
  });
  const decode = (line: string): CompactVehicleEvidence => {
    const [parsed_reports, malformed_reports, name_brand_mask, exclusion_mask, ecosystem_mask] = line.split(':').map(Number);
    return compact({ parsed_reports, malformed_reports, name_brand_mask, exclusion_mask, ecosystem_mask });
  };
  const extract = (payloads: string[], merge = false): CompactVehicleEvidence[] =>
    execFileSync(executable, [merge ? 'merge' : 'single', ...payloads], { encoding: 'utf8' })
      .trim().split('\n').map(decode);
  const semantic = (result: ReturnType<typeof classifyVehicleEvidence>) => ({
    category: result.category, confidence: result.confidence,
    evidence: result.evidence.map(item => item.rule_id).sort(),
    exclusions: [...new Set(result.exclusions.map(item => item.rule_id))].sort(),
  });
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'campuspulse-compact-parity-'));
    executable = join(directory, 'compact');
    const source = join(directory, 'compare.c');
    writeFileSync(source, `#include <stdio.h>
#include <string.h>
#include "cp_vehicle.h"
static void print_state(const cp_vehicle_evidence_t *e) {
  printf("%u:%u:%u:%u:%u\\n", e->parsed_reports, e->malformed_reports,
    e->name_brand_mask, e->exclusion_mask, e->ecosystem_mask);
}
int main(int argc, char **argv) {
  if (sizeof(cp_vehicle_evidence_t) != 16 || argc < 2) return 2;
  if (!strcmp(argv[1], "tables")) {
    for (unsigned value = 0; value <= 65535; ++value) {
      uint8_t low = value & 255, high = value >> 8;
      uint8_t payload[] = {3,255,low,high,3,25,low,high,3,3,low,high};
      cp_vehicle_evidence_t e = {0};
      if (!cp_vehicle_observe(&e, payload, sizeof payload)) return 3;
      if (e.exclusion_mask || e.ecosystem_mask)
        printf("%u:%u:%u\\n", value, e.exclusion_mask, e.ecosystem_mask);
    }
    return 0;
  }
  int merge = !strcmp(argv[1], "merge");
  cp_vehicle_evidence_t e = {0};
  for (int arg = 2; arg < argc; ++arg) {
    uint8_t bytes[256];
    size_t length = strlen(argv[arg]) / 2;
    if (length > sizeof bytes || strlen(argv[arg]) % 2) return 4;
    for (size_t i = 0; i < length; ++i) {
      unsigned value;
      if (sscanf(argv[arg] + i * 2, "%2x", &value) != 1) return 5;
      bytes[i] = (uint8_t)value;
    }
    if (!merge) e = (cp_vehicle_evidence_t){0};
    if (!cp_vehicle_observe(&e, bytes, length)) return 6;
    if (!merge) print_state(&e);
  }
  if (merge) print_state(&e);
  return 0;
}
`);
    const component = fileURLToPath(new URL('../firmware/components/cp_vehicle/', import.meta.url));
    execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-I', join(component, 'include'),
      source, join(component, 'cp_vehicle.c'), '-o', executable], { stdio: 'pipe' });
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it('distinguishes missing, enabled-but-empty and valid-empty evidence', () => {
    expect(classifyCompactVehicleEvidence().limitations).toContain('compact_evidence_missing');
    expect(classifyCompactVehicleEvidence(compact({ parsed_reports: 0 })).limitations).toContain('no_parsed_reports');
    const validEmpty = classifyCompactVehicleEvidence(compact());
    expect(validEmpty.category).toBe('unknown');
    expect(validEmpty.limitations).toContain('no_positive_vehicle_evidence');
    expect(validEmpty.limitations).not.toContain('no_parsed_reports');
  });

  it('rejects unknown versions/bits, invalid counters and clues with zero valid reports', () => {
    for (const extra of [
      { name_brand_mask: 1 << 20 }, { exclusion_mask: 1 << 11 }, { ecosystem_mask: 4 },
      { parsed_reports: -1 }, { malformed_reports: 0x1_0000_0000 }, { parsed_reports: 1.5 },
      { parsed_reports: 0, name_brand_mask: 1 }, { ignored_future_field: 1 },
    ]) {
      const result = classifyCompactVehicleEvidence(compact(extra));
      expect(result.category).toBe('unknown');
      expect(result.limitations).toContain('malformed_evidence');
    }
    const wrongVersion = compact({ schema_version: 'future' as typeof COMPACT_VEHICLE_SCHEMA_VERSION });
    expect(classifyCompactVehicleEvidence(wrongVersion).limitations).toContain('unsupported_evidence_version');
  });

  it('matches C and TS effective name/category/exclusion behavior with synthetic inputs', () => {
    const names = RADAR_VEHICLE_NAME_PATTERNS.flatMap(pattern => {
      const word = pattern.replace('^', '');
      return [word, `${word.toUpperCase()}-SYNTH`, `X${word}`, `X ${word} SYNTH`];
    });
    names.push('YD00000', 'NIUTRITION', 'LaimaSynthetic', 'YADEA keyboard', 'YADEA Pixel',
      'YADEA TWS', 'YADEA 中文', '中文YADEA', 'YADEA\u202e', 'YADEA\u0000');
    const payloads = names.map(nameAd);
    expect(payloads.every(payload => payload.length <= 62)).toBe(true);
    const evidence = extract(payloads);
    for (let i = 0; i < payloads.length; i++) {
      const raw = classifyVehicleAdvertisement(parseAdvertisement(payloads[i]));
      expect(semantic(classifyCompactVehicleEvidence(evidence[i])), names[i]).toEqual(semantic(raw));
    }
  });

  it('matches all uint16 company, appearance and service exclusions and module hints', () => {
    const actual = execFileSync(executable, ['tables'], { encoding: 'utf8' }).trim().split('\n');
    const expected: string[] = [];
    for (let value = 0; value <= 0xffff; value++) {
      const result = classifyVehicleEvidence(full({
        manufacturers: [{ company_id: value }], appearances: [value], service_uuids16: [value],
      }));
      let exclusions = 0;
      for (const item of result.exclusions) exclusions |= 1 << COMPACT_VEHICLE_EXCLUSIONS.findIndex(([rule]) => rule === item.rule_id);
      const ecosystem = value === 0x0020 ? 1 : value === 0x1010 ? 2 : 0;
      if (exclusions || ecosystem) expected.push(`${value}:${exclusions}:${ecosystem}`);
    }
    expect(actual).toEqual(expected);
  }, 20_000);

  it('checks every AD field, wider Bluetooth UUID encodings, and all Apple subtypes', () => {
    const payloads = [
      nameAd('YADEA') + ad(0xff, '6500') + ad(0xff, '2000'),
      nameAd('YADEA') + ad(0x16, '0f1800') + ad(0x16, 'f7fd00'),
      nameAd('YADEA') + ad(0x19, 'c703') + ad(0x19, '0000'),
      nameAd('YADEA') + nameAd('BYD'),
      nameAd('YADEA') + ad(0x05, '2cfe0000'),
      nameAd('YADEA') + ad(0x07, 'fb349b5f80000080001000002cfe0000'),
      nameAd('YADEA') + ad(0x21, 'fb349b5f80000080001000001218000000'),
      nameAd('YADEA') + ad(0x03, '1318'),
      ...Array.from({ length: 256 }, (_, value) => nameAd('YADEA') + ad(0xff, '4c00' + value.toString(16).padStart(2, '0'))),
    ];
    expect(payloads.every(payload => payload.length <= 62)).toBe(true);
    const evidence = extract(payloads);
    for (let i = 0; i < payloads.length; i++) {
      expect(semantic(classifyCompactVehicleEvidence(evidence[i])))
        .toEqual(semantic(classifyVehicleAdvertisement(parseAdvertisement(payloads[i]))));
    }
  });

  it('discards malformed report clues atomically and abstains if a window contains one', () => {
    const evidence = extract([nameAd('BYD'), nameAd('YADEA') + '050941'], true)[0];
    expect(evidence).toEqual(compact({ parsed_reports: 1, malformed_reports: 1, name_brand_mask: 1 << 5 }));
    const result = classifyCompactVehicleEvidence(evidence);
    expect(result.category).toBe('unknown');
    expect(result.evidence.map(item => item.category)).toEqual(['car_related']);
    expect(result.limitations).toContain('malformed_evidence');
  });

  it('rejects invalid UTF-8/control names and structural lengths consistently', () => {
    const payloads = [
      ad(0x09, 'c080'), ad(0x09, 'eda080'), ad(0x09, 'f4908080'), ad(0x09, 'e282'),
      ad(0x09, 'c2ad'), ad(0x09, 'efbfbd'), ad(0x09, 'e2808f'), ad(0x09, 'c280'),
      ad(0x03, '0f'), ad(0xff, '34'), ad(0x16, '34'), ad(0x01, ''), ad(0x0a, '0102'), ad(0x19, '34'),
      '0109', '', '00' + nameAd('YADEA'), nameAd('YADEA') + '00' + '050941',
    ];
    const evidence = extract(payloads);
    for (let i = 0; i < payloads.length; i++) {
      const raw = classifyVehicleAdvertisement(parseAdvertisement(payloads[i]));
      expect(semantic(classifyCompactVehicleEvidence(evidence[i])), payloads[i]).toEqual(semantic(raw));
      expect(evidence[i].malformed_reports === 1).toBe(raw.limitations.includes('malformed_evidence'));
    }
  });

  it('agrees on strict parsing of a deterministic synthetic byte corpus', () => {
    let seed = 0x5a17;
    const payloads = Array.from({ length: 512 }, (_, index) => {
      const bytes = Array.from({ length: index % 32 }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return (seed >>> 24).toString(16).padStart(2, '0');
      });
      return bytes.join('');
    });
    const evidence = extract(payloads);
    for (let i = 0; i < payloads.length; i++) {
      const raw = classifyVehicleAdvertisement(parseAdvertisement(payloads[i]));
      expect(semantic(classifyCompactVehicleEvidence(evidence[i]))).toEqual(semantic(raw));
      expect(evidence[i].malformed_reports === 1).toBe(raw.limitations.includes('malformed_evidence'));
    }
  });
});

describe('independent parity with the actual imported C primitives', () => {
  let directory: string;
  let executable: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'campuspulse-vehicle-parity-'));
    executable = join(directory, 'radar-primitives');
    const source = join(directory, 'compare.c');
    writeFileSync(source, `#include <stdio.h>
#include <string.h>
#include "veh_rules.h"
#include "dev_phone.h"
int main(int argc, char **argv) {
  if (argc == 1) {
    for (unsigned value = 0; value <= 65535; ++value) {
      unsigned bits = veh_rules_manu_is_office(value)
        | (veh_rules_appearance_is_gadget(value) << 1)
        | (veh_rules_svc16_is_gadget(value) << 2)
        | (dev_phone_vendor(value) << 3);
      if (bits) printf("%u:%u\\n", value, bits);
    }
  } else {
    for (int i = 1; i < argc; ++i) {
      size_t n = strlen(argv[i]);
      if (n > sizeof(((scan_facts_t *)0)->name)) return 2;
      scan_facts_t facts = {0};
      facts.has_name = n > 0;
      facts.name_len = (uint8_t)n;
      memcpy(facts.name, argv[i], n);
      unsigned bits = veh_rules_name_is_vehicle(facts.name, facts.name_len)
        | (dev_phone_is_phone(&facts) << 1)
        | (dev_phone_is_peripheral(&facts) << 2);
      printf("%u\\n", bits);
    }
  }
  return 0;
}
`);
    const imported = fileURLToPath(new URL('../firmware/ai-passport-radar/main/', import.meta.url));
    execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-I', imported,
      source, join(imported, 'veh_rules.c'), join(imported, 'dev_phone.c'), '-o', executable], { stdio: 'pipe' });
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it('matches every uint16 value for four exact imported lookup functions', () => {
    const actual = execFileSync(executable, [], { encoding: 'utf8' }).trim().split('\n');
    const typescript: string[] = [];
    for (let value = 0; value <= 0xffff; value++) {
      const bits = Number(radarCompanyIsOffice(value)) | (Number(radarAppearanceIsGadget(value)) << 1)
        | (Number(radarServiceIsGadget(value)) << 2) | (Number(radarCompanyIsPhoneVendor(value)) << 3);
      if (bits) typescript.push(`${value}:${bits}`);
    }
    expect(typescript).toEqual(actual);
  });

  it('matches imported name-only primitives on every pattern and synthetic counterexample', () => {
    const names = [...RADAR_VEHICLE_NAME_PATTERNS.flatMap(pattern => {
      const word = pattern.replace('^', '');
      return [word, word.toUpperCase(), `${word}-SYNTH`, `X${word}`, `X ${word} SYNTH`];
    }), 'CodySynthetic', 'LaimaSynthetic', 'genius', 'NIUTRITION', 'Pixel Buds',
    'YADEA keyboard', 'vivo TWS', 'HUAWEI M-Pencil', 'iKF SYNTH', 'DESKTOP-SYNTH',
    'iPhone SYNTH', 'Galaxy SYNTH', 'Xiaomi SYNTH', 'MI SYNTH', 'unknown', ''];
    expect(names.every(name => Buffer.byteLength(name) <= 24)).toBe(true);
    const actual = execFileSync(executable, names, { encoding: 'utf8' }).trim().split('\n').map(Number);
    const typescript = names.map(name => Number(radarNameIsVehicle(name))
      | (Number(radarNameIsPhone(name)) << 1) | (Number(radarNameIsPeripheral(name)) << 2));
    expect(typescript).toEqual(actual);
  });

  it('documents intentional strict classification differences instead of claiming full parity', () => {
    expect(radarNameIsVehicle('LaimaSynthetic')).toBe(true);
    expect(classify('LaimaSynthetic').category).toBe('unknown');
    expect(radarNameIsVehicle('BYD SYNTHETIC')).toBe(true);
    expect(classify('BYD SYNTHETIC').category).toBe('car_related');
    expect(radarNameIsVehicle('ZUB_SYNTHETIC')).toBe(true);
    expect(classify('ZUB_SYNTHETIC').category).toBe('unknown');
    expect(radarNameIsVehicle('YADEA keyboard')).toBe(true);
    expect(classify('YADEA keyboard').category).toBe('unknown');
  });
});

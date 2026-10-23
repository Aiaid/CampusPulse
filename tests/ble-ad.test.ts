import { describe, expect, it } from 'vitest';
import { parseAdvertisement, PARSER_VERSION, RULESET_VERSION } from '../worker/ble-ad';

const ad = (type: number, valueHex: string): string => {
  const length = valueHex.length / 2 + 1;
  return length.toString(16).padStart(2, '0') + type.toString(16).padStart(2, '0') + valueHex;
};

describe('legacy AD parser', () => {
  it('matches the synthetic protocol example while leaving classification unasserted by the name', () => {
    const parsed = parseAdvertisement('02010609094e49552044454d4f03030f1805ffffff1122');
    expect(parsed.parser_version).toBe(PARSER_VERSION);
    expect(parsed.parse_status).toBe('ok');
    expect(parsed.elements.map(({ offset, type, value_hex }) => ({ offset, type, value_hex }))).toEqual([
      { offset: 0, type: 1, value_hex: '06' },
      { offset: 3, type: 9, value_hex: '4e49552044454d4f' },
      { offset: 13, type: 3, value_hex: '0f18' },
      { offset: 17, type: 255, value_hex: 'ffff1122' },
    ]);
    expect(parsed.names).toEqual([{ ad_offset: 3, complete: true, bytes_hex: '4e49552044454d4f', display_text: 'NIU DEMO' }]);
    expect(parsed.service_uuids).toEqual([{ ad_offset: 13, ad_type: 3, source_width_bits: 16, uuid: '0000180f-0000-1000-8000-00805f9b34fb' }]);
    expect(parsed.manufacturer_data).toEqual([{ ad_offset: 17, ad_length: 5, company_id: 65535, company_name: null, vendor_data_hex: '1122', vendor_data_length: 2 }]);
    expect(parsed.classification).toEqual({ category: 'unknown', confidence: 'none', rule_id: null, ruleset_version: RULESET_VERSION, evidence: [] });
  });

  it('normalizes 16, 32 and 128 bit UUIDs from their respective little-endian fields', () => {
    const parsed = parseAdvertisement([
      ad(0x02, '0f180a18'),
      ad(0x05, '78563412'),
      ad(0x07, 'ffeeddccbbaa99887766554433221100'),
      ad(0x16, '0f18aabb'),
      ad(0x20, '78563412cc'),
      ad(0x21, 'ffeeddccbbaa99887766554433221100dd'),
    ].join(''));
    expect(parsed.parse_status).toBe('ok');
    expect(parsed.service_uuids.map(item => [item.source_width_bits, item.uuid])).toEqual([
      [16, '0000180f-0000-1000-8000-00805f9b34fb'],
      [16, '0000180a-0000-1000-8000-00805f9b34fb'],
      [32, '12345678-0000-1000-8000-00805f9b34fb'],
      [128, '00112233-4455-6677-8899-aabbccddeeff'],
    ]);
    expect(parsed.service_data.map(item => [item.source_width_bits, item.uuid, item.data_hex])).toEqual([
      [16, '0000180f-0000-1000-8000-00805f9b34fb', 'aabb'],
      [32, '12345678-0000-1000-8000-00805f9b34fb', 'cc'],
      [128, '00112233-4455-6677-8899-aabbccddeeff', 'dd'],
    ]);
    expect(parsed.service_uuids).toHaveLength(4);
    expect(parsed.service_data).toHaveLength(3);
  });

  it('preserves repeated and unknown elements, both name kinds, and standard scalar fields', () => {
    const parsed = parseAdvertisement([
      ad(0x08, '4100'), ad(0x09, '42'), ad(0xee, 'beef'), ad(0xee, 'aa'),
      ad(0xff, '3412'), ad(0xff, '7856abcd'), ad(0x01, '06'), ad(0x0a, 'fe'),
      ad(0x19, '3412'),
    ].join(''));
    expect(parsed.parse_status).toBe('ok');
    expect(parsed.elements.map(item => item.type)).toEqual([8, 9, 238, 238, 255, 255, 1, 10, 25]);
    expect(parsed.elements.filter(item => item.type === 238).map(item => item.value_hex)).toEqual(['beef', 'aa']);
    expect(parsed.names.map(item => [item.complete, item.bytes_hex, item.display_text])).toEqual([
      [false, '4100', 'A\ufffd'], [true, '42', 'B'],
    ]);
    expect(parsed.manufacturer_data.map(item => [item.company_id, item.vendor_data_hex, item.vendor_data_length])).toEqual([
      [0x1234, '', 0], [0x5678, 'abcd', 2],
    ]);
    expect(parsed.flags).toEqual([{ ad_offset: parsed.elements[6].offset, value: 6 }]);
    expect(parsed.tx_power).toEqual([{ ad_offset: parsed.elements[7].offset, dbm: -2 }]);
    expect(parsed.appearance).toEqual([{ ad_offset: parsed.elements[8].offset, value: 0x1234 }]);
  });

  it('replaces malformed UTF-8 for display while preserving name bytes', () => {
    const parsed = parseAdvertisement(ad(0x09, '41e282'));
    expect(parsed.parse_status).toBe('ok');
    expect(parsed.names[0]).toMatchObject({ bytes_hex: '41e282', display_text: 'A\ufffd' });
    expect(parseAdvertisement(ad(0x09, '41e2808f42')).names[0]).toMatchObject({
      bytes_hex: '41e2808f42', display_text: 'A\ufffdB',
    });
  });

  it('stops at a zero length terminator', () => {
    const parsed = parseAdvertisement(ad(0x01, '06') + '00' + ad(0x09, '41'));
    expect(parsed.parse_status).toBe('ok');
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.names).toEqual([]);
  });

  it('marks an AD overrun malformed without inventing a partial element', () => {
    const parsed = parseAdvertisement(ad(0x01, '06') + '050941');
    expect(parsed.parse_status).toBe('malformed');
    expect(parsed.elements).toEqual([{ offset: 0, ad_length: 2, type: 1, value_hex: '06' }]);
    expect(parsed.classification.category).toBe('unknown');
    expect(parsed.classification.evidence).toEqual([]);
  });

  it('marks broken standard field lengths and invalid hex malformed', () => {
    for (const payload of [ad(0x03, '0f'), ad(0xff, '34'), ad(0x16, '34'), ad(0x01, ''), ad(0x0a, '0102'), ad(0x19, '34'), '02010', '0201gg']) {
      const parsed = parseAdvertisement(payload);
      expect(parsed.parse_status, payload).toBe('malformed');
      expect(parsed.classification).toMatchObject({ category: 'unknown', confidence: 'none', evidence: [] });
    }
  });
});

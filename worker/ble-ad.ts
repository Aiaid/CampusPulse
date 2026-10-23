/** Derived legacy AD data only. The caller owns the original payload and source IDs. */
export const PARSER_VERSION = 'ble-ad-v1';
export const RULESET_VERSION = 'unclassified-v1';

export interface AdElement {
  /** Offset of the AD length byte, starting at zero. */
  offset: number;
  /** AD length byte: type byte plus value bytes. */
  ad_length: number;
  type: number;
  value_hex: string;
}

export interface ParsedAdvertisement {
  parser_version: typeof PARSER_VERSION;
  parse_status: 'ok' | 'malformed';
  elements: AdElement[];
  names: Array<{ ad_offset: number; complete: boolean; bytes_hex: string; display_text: string }>;
  service_uuids: Array<{ ad_offset: number; ad_type: number; source_width_bits: 16 | 32 | 128; uuid: string }>;
  manufacturer_data: Array<{
    ad_offset: number;
    ad_length: number;
    company_id: number;
    company_name: null;
    vendor_data_hex: string;
    vendor_data_length: number;
  }>;
  service_data: Array<{ ad_offset: number; ad_type: number; source_width_bits: 16 | 32 | 128; uuid: string; data_hex: string }>;
  flags: Array<{ ad_offset: number; value: number }>;
  tx_power: Array<{ ad_offset: number; dbm: number }>;
  appearance: Array<{ ad_offset: number; value: number }>;
  ruleset_version: typeof RULESET_VERSION;
  classification: {
    category: 'unknown';
    confidence: 'none';
    rule_id: null;
    ruleset_version: typeof RULESET_VERSION;
    evidence: [];
  };
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const littleEndianNumber = (bytes: Uint8Array): number => bytes.reduce((value, byte, index) => value + byte * 2 ** (8 * index), 0);

function uuid(bytes: Uint8Array): string {
  const reversed = hex(Uint8Array.from(bytes).reverse());
  if (bytes.length === 2 || bytes.length === 4) {
    return `${reversed.padStart(8, '0')}-0000-1000-8000-00805f9b34fb`;
  }
  return `${reversed.slice(0, 8)}-${reversed.slice(8, 12)}-${reversed.slice(12, 16)}-${reversed.slice(16, 20)}-${reversed.slice(20)}`;
}

const displayDecoder = new TextDecoder('utf-8', { fatal: false });
function displayText(bytes: Uint8Array): string {
  // Replacement characters make malformed UTF-8 and control/bidi formatting
  // visible without changing the separately retained evidence bytes.
  return displayDecoder.decode(bytes).replace(/[\p{Cc}\p{Cf}]/gu, '\ufffd');
}

/**
 * Parse one legacy advertisement or scan response, without joining reports.
 * Invalid hex or any overrun/invalid standard field yields malformed. The
 * original payload must remain stored by the caller even in that case.
 */
export function parseAdvertisement(payloadHex: string): ParsedAdvertisement {
  const result: ParsedAdvertisement = {
    parser_version: PARSER_VERSION,
    parse_status: 'ok',
    elements: [],
    names: [],
    service_uuids: [],
    manufacturer_data: [],
    service_data: [],
    flags: [],
    tx_power: [],
    appearance: [],
    ruleset_version: RULESET_VERSION,
    classification: {
      category: 'unknown', confidence: 'none', rule_id: null,
      ruleset_version: RULESET_VERSION, evidence: [],
    },
  };

  if (payloadHex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(payloadHex)) {
    result.parse_status = 'malformed';
    return result;
  }

  const bytes = new Uint8Array(payloadHex.match(/../g)?.map(pair => Number.parseInt(pair, 16)) ?? []);
  for (let offset = 0; offset < bytes.length;) {
    const length = bytes[offset];
    if (length === 0) break;
    const end = offset + 1 + length;
    if (end > bytes.length) {
      result.parse_status = 'malformed';
      break;
    }
    const type = bytes[offset + 1];
    const value = bytes.subarray(offset + 2, end);
    result.elements.push({ offset, ad_length: length, type, value_hex: hex(value) });

    if (type === 0x08 || type === 0x09) {
      result.names.push({ ad_offset: offset, complete: type === 0x09, bytes_hex: hex(value), display_text: displayText(value) });
    } else if ([0x02, 0x03, 0x04, 0x05, 0x06, 0x07].includes(type)) {
      const width = (type === 0x02 || type === 0x03 ? 16 : type === 0x04 || type === 0x05 ? 32 : 128) as 16 | 32 | 128;
      const size = width / 8;
      if (value.length % size !== 0) result.parse_status = 'malformed';
      for (let index = 0; index + size <= value.length; index += size) {
        result.service_uuids.push({ ad_offset: offset, ad_type: type, source_width_bits: width, uuid: uuid(value.subarray(index, index + size)) });
      }
    } else if (type === 0xff) {
      if (value.length < 2) result.parse_status = 'malformed';
      else result.manufacturer_data.push({
        ad_offset: offset, ad_length: length, company_id: littleEndianNumber(value.subarray(0, 2)),
        company_name: null, vendor_data_hex: hex(value.subarray(2)), vendor_data_length: value.length - 2,
      });
    } else if (type === 0x16 || type === 0x20 || type === 0x21) {
      const width = (type === 0x16 ? 16 : type === 0x20 ? 32 : 128) as 16 | 32 | 128;
      const size = width / 8;
      if (value.length < size) result.parse_status = 'malformed';
      else result.service_data.push({ ad_offset: offset, ad_type: type, source_width_bits: width, uuid: uuid(value.subarray(0, size)), data_hex: hex(value.subarray(size)) });
    } else if (type === 0x01) {
      if (value.length !== 1) result.parse_status = 'malformed';
      else result.flags.push({ ad_offset: offset, value: value[0] });
    } else if (type === 0x0a) {
      if (value.length !== 1) result.parse_status = 'malformed';
      else result.tx_power.push({ ad_offset: offset, dbm: value[0] > 127 ? value[0] - 256 : value[0] });
    } else if (type === 0x19) {
      if (value.length !== 2) result.parse_status = 'malformed';
      else result.appearance.push({ ad_offset: offset, value: littleEndianNumber(value) });
    }
    offset = end;
  }
  return result;
}

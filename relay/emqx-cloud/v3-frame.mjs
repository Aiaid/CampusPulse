export const V3_HEADER_BYTES = 8;
export const MAX_ORIGINAL_BODY = 8192;
export const MAX_V3_WIRE = MAX_ORIGINAL_BODY + V3_HEADER_BYTES;

/** Shared validation for the private dispatch metadata, never device identity. */
export function validV3Metadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'receiptOnly,subop' &&
    Number.isInteger(value.subop) && value.subop >= 1 && value.subop <= 5 &&
    typeof value.receiptOnly === 'boolean' &&
    (!value.receiptOnly || value.subop === 3 || value.subop === 4);
}

/** A recognized magic must pass framing validation; it never falls back to v2. */
export function parseV3Frame(wire) {
  if (wire.length < 4 || wire[0] !== 0x43 || wire[1] !== 0x50 ||
      wire[2] !== 0x56 || wire[3] !== 0x33) return undefined;
  if (wire.length < V3_HEADER_BYTES || wire.length > MAX_V3_WIRE ||
      wire[4] !== 1 || wire[7] !== 0 || (wire[6] & ~1) !== 0) throw new Error('invalid_frame');
  const v3 = {subop: wire[5], receiptOnly: (wire[6] & 1) !== 0};
  if (!validV3Metadata(v3) || (v3.subop === 2 && wire.length !== V3_HEADER_BYTES))
    throw new Error('invalid_frame');
  return {v3, body: wire.subarray(V3_HEADER_BYTES)};
}

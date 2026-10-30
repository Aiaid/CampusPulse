/** Structural CPRAW v1 verification only. No addresses or payloads are returned. */
export interface CprawValidation {
  status: 'valid' | 'interrupted_tail' | 'invalid';
  parser_version: 'cpraw/1-validator/1';
  valid_bytes: number;
  truncated_offset: number | null;
  reports: number | null;
}

const MAGIC = [0x43, 0x50, 0x52, 0x41, 0x57, 0x0d, 0x0a, 0x1a];
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
export function cprawCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function u32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);
}
function crcValid(bytes: Uint8Array): boolean {
  return cprawCrc32(bytes.subarray(0, -4)) === u32(bytes, bytes.length - 4);
}
function frameValid(frame: Uint8Array): boolean {
  if (frame[5] || frame[6] || frame[7] || !crcValid(frame)) return false;
  const length = frame.length - 12, body = frame.subarray(8, -4);
  switch (frame[4]) {
    case 1: {
      if (length < 43) return false;
      const payload = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint16(16, true);
      return payload <= 1650 && length === 43 + payload && body[27] <= 1;
    }
    case 2: return length === 56;
    case 3: return length === 16;
    case 4: return length === 21 && (body[20] === 1 || body[20] === 2);
    default: return false;
  }
}

/** At most a chunk plus one incomplete frame is buffered per call. */
export class CprawValidator {
  private pending = new Uint8Array(0);
  private header = false;
  private invalid = false;
  private validBytes = 0;
  private reports = 0;
  private session: string | null = null;
  private anchors = 0;
  private lastAnchor: { mono_us: string; utc_epoch_seconds: string; uncertainty_us: number; source: number } | null = null;
  private maxBuffer = 0;

  /** Private registry data, never part of device receipts or ordinary logs. */
  privateSummary() { return { session_hex: this.session, anchor_frames: this.anchors, last_anchor: this.lastAnchor }; }
  get peakBufferBytes() { return this.maxBuffer; }

  write(bytes: Uint8Array): void {
    if (this.invalid) return;
    const input = new Uint8Array(this.pending.length + bytes.length);
    this.maxBuffer = Math.max(this.maxBuffer, input.length);
    input.set(this.pending); input.set(bytes, this.pending.length);
    let pos = 0;
    if (!this.header) {
      if (input.length < 32) { this.pending = input; return; }
      const view = new DataView(input.buffer);
      if (!MAGIC.every((byte, index) => input[index] === byte) || view.getUint16(8, true) !== 1 ||
          view.getUint16(10, true) !== 32 || !crcValid(input.subarray(0, 32))) {
        this.invalid = true; this.pending = new Uint8Array(0); return;
      }
      this.header = true; this.validBytes = 32; pos = 32;
      this.session = Array.from(input.subarray(12, 28), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    while (input.length - pos >= 4) {
      const size = u32(input, pos);
      if (size < 12 || size > 1728) { this.invalid = true; break; }
      if (input.length - pos < size) break;
      const frame = input.subarray(pos, pos + size);
      if (!frameValid(frame)) { this.invalid = true; break; }
      if (frame[4] === 1) this.reports++;
      if (frame[4] === 4) {
        const body = new DataView(frame.buffer, frame.byteOffset + 8, frame.length - 12);
        this.anchors++;
        this.lastAnchor = { mono_us: body.getBigUint64(0, true).toString(), utc_epoch_seconds: body.getBigUint64(8, true).toString(),
          uncertainty_us: body.getUint32(16, true), source: body.getUint8(20) };
      }
      pos += size; this.validBytes += size;
    }
    this.pending = this.invalid ? new Uint8Array(0) : input.slice(pos);
  }

  finish(): CprawValidation {
    if (!this.header) this.invalid = true;
    if (!this.invalid && this.pending.length >= 4) {
      // Match decode.py: a later CRC-valid known frame contradicts a short tail.
      for (let pos = 1; pos + 12 <= this.pending.length; pos++) {
        const size = u32(this.pending, pos);
        if (size < 12 || size > 1728 || pos + size > this.pending.length) continue;
        const frame = this.pending.subarray(pos, pos + size);
        if (frame[4] >= 1 && frame[4] <= 4 && !frame[5] && !frame[6] && !frame[7] && crcValid(frame)) {
          this.invalid = true; break;
        }
      }
    }
    const truncated = !this.invalid && this.pending.length > 0;
    return { status: this.invalid ? 'invalid' : truncated ? 'interrupted_tail' : 'valid',
      parser_version: 'cpraw/1-validator/1', valid_bytes: this.validBytes,
      truncated_offset: truncated ? this.validBytes : null,
      reports: this.invalid ? null : this.reports };
  }
}

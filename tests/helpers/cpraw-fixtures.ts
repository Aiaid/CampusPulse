import { createHash } from 'node:crypto';
import { cprawCrc32 } from '../../worker/cpraw-format';
import { CPRAW_CHUNK_BYTES, CPRAW_PROTOCOL, type CprawManifest } from '../../worker/cpraw-manifest';

export const cprawHash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const CPRAW_ID = '11111111-1111-4111-8111-111111111111';
export function cprawHeader(): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(32), view = new DataView(header.buffer);
  header.set([67, 80, 82, 65, 87, 13, 10, 26]);
  view.setUint16(8, 1, true); view.setUint16(10, 32, true);
  view.setUint32(28, cprawCrc32(header.subarray(0, 28)), true);
  return header;
}
export function cprawFrame(type: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(body.length + 12), view = new DataView(frame.buffer);
  view.setUint32(0, frame.length, true); frame[4] = type; frame.set(body, 8);
  view.setUint32(frame.length - 4, cprawCrc32(frame.subarray(0, -4)), true);
  return frame;
}
export function cprawReport(payload = 31, extended = false): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(43 + payload);
  new DataView(body.buffer).setUint16(16, payload, true); body[27] = extended ? 1 : 0;
  return cprawFrame(1, body);
}
export function concatCpraw(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
export function cprawManifest(file: Uint8Array, uploadId = CPRAW_ID): { manifest: CprawManifest; bytes: Uint8Array<ArrayBuffer>; hash: string; chunks: Uint8Array<ArrayBuffer>[] } {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < file.length; offset += CPRAW_CHUNK_BYTES) chunks.push(Uint8Array.from(file.subarray(offset, offset + CPRAW_CHUNK_BYTES)));
  const manifest: CprawManifest = { protocol: CPRAW_PROTOCOL, upload_id: uploadId, archive_policy_id: 'synthetic-import', format: 'cpraw/1',
    file_bytes: file.length, file_sha256: cprawHash(file), chunk_bytes: CPRAW_CHUNK_BYTES,
    chunks: chunks.map((bytes, index) => ({ index, offset: index * CPRAW_CHUNK_BYTES, bytes: bytes.length, sha256: cprawHash(bytes) })), source: 'tf_card_copy' };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  return { manifest, bytes, hash: cprawHash(bytes), chunks };
}
export function maximumCprawFile(): Uint8Array<ArrayBuffer> {
  const maximum = 16_780_672, full = Math.floor((maximum - 32) / 1705);
  // 30 bytes remain after maximum-size reports. Shorten the penultimate
  // report by 25 bytes so a valid zero-payload report fills the last 55 bytes.
  const report = cprawReport(1650, true);
  return concatCpraw(cprawHeader(), ...Array.from({ length: full - 1 }, () => report), cprawReport(1625, true), cprawReport(0));
}

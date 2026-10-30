import { IngestError, parseIngestJson } from './ingest-validation';

export const CPRAW_PROTOCOL = 'campuspulse/cpraw-archive/1';
export const CPRAW_CHUNK_BYTES = 65_536;
export const CPRAW_MAX_FILE_BYTES = 16_780_672;
export const CPRAW_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CPRAW_SHA256 = /^[0-9a-f]{64}$/;
export interface CprawChunk { index: number; offset: number; bytes: number; sha256: string }
export interface CprawManifest {
  protocol: typeof CPRAW_PROTOCOL;
  upload_id: string;
  archive_policy_id: string;
  format: 'cpraw/1';
  file_bytes: number;
  file_sha256: string;
  chunk_bytes: typeof CPRAW_CHUNK_BYTES;
  chunks: CprawChunk[];
  source: 'usb_export' | 'tf_card_copy';
}
const invalid = (): never => { throw new IngestError(422, 'invalid_manifest', 'Invalid archive manifest.'); };
function fields(value: unknown, names: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== names.length || names.some(key => !Object.hasOwn(result, key))) return invalid();
  return result;
}
export function parseCprawManifest(bytes: Uint8Array): CprawManifest {
  const value = fields(parseIngestJson(bytes), ['protocol', 'upload_id', 'archive_policy_id', 'format', 'file_bytes', 'file_sha256', 'chunk_bytes', 'chunks', 'source']);
  if (value.protocol !== CPRAW_PROTOCOL || value.format !== 'cpraw/1' ||
      typeof value.upload_id !== 'string' || !CPRAW_UUID.test(value.upload_id) ||
      typeof value.archive_policy_id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(value.archive_policy_id) ||
      typeof value.file_sha256 !== 'string' || !CPRAW_SHA256.test(value.file_sha256) ||
      typeof value.file_bytes !== 'number' || !Number.isSafeInteger(value.file_bytes) || value.file_bytes < 0 ||
      value.chunk_bytes !== CPRAW_CHUNK_BYTES || !Array.isArray(value.chunks) ||
      typeof value.source !== 'string' || !['usb_export', 'tf_card_copy'].includes(value.source)) return invalid();
  if (value.file_bytes > CPRAW_MAX_FILE_BYTES || value.chunks.length > 257)
    throw new IngestError(413, 'file_too_large', 'Archive exceeds the file limit.');
  if (value.chunks.length !== Math.ceil(value.file_bytes / CPRAW_CHUNK_BYTES)) return invalid();
  const fileBytes = value.file_bytes;
  const chunks = value.chunks.map((chunk, index): CprawChunk => {
    const c = fields(chunk, ['index', 'offset', 'bytes', 'sha256']);
    if (c.index !== index || c.offset !== index * CPRAW_CHUNK_BYTES ||
        c.bytes !== Math.min(CPRAW_CHUNK_BYTES, fileBytes - index * CPRAW_CHUNK_BYTES) ||
        typeof c.sha256 !== 'string' || !CPRAW_SHA256.test(c.sha256)) return invalid();
    return { index, offset: c.offset as number, bytes: c.bytes as number, sha256: c.sha256 };
  });
  if (fileBytes === 0 && value.file_sha256 !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') return invalid();
  return { protocol: CPRAW_PROTOCOL, upload_id: value.upload_id, archive_policy_id: value.archive_policy_id,
    format: 'cpraw/1', file_bytes: fileBytes, file_sha256: value.file_sha256,
    chunk_bytes: CPRAW_CHUNK_BYTES, chunks, source: value.source as CprawManifest['source'] };
}

/** Check the stream, not just Content-Length; retain at most one bounded body. */
export async function readCprawBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const announced = request.headers.get('Content-Length');
  if (announced !== null && (!/^\d+$/.test(announced) || !Number.isSafeInteger(Number(announced))))
    throw new IngestError(422, 'invalid_length', 'Invalid body length.');
  if (announced !== null && Number(announced) > limit)
    throw new IngestError(413, 'payload_too_large', 'Request exceeds the byte limit.');
  const result = new Uint8Array(limit);
  const reader = request.body?.getReader();
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (length + value.byteLength > limit) {
          await reader.cancel();
          throw new IngestError(413, 'payload_too_large', 'Request exceeds the byte limit.');
        }
        result.set(value, length); length += value.byteLength;
      }
    } finally { reader.releaseLock(); }
  }
  if (announced !== null && Number(announced) !== length)
    throw new IngestError(422, 'length_mismatch', 'Body length does not match its declaration.');
  return result.slice(0, length);
}

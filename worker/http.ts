import type { Env } from './types';
import { IngestError } from './strict-json';

export const MAX_INGEST_BYTES = 65536;
export const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
export async function readBytes(request: Request, limit = MAX_INGEST_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new IngestError(415, 'content_type', 'Use application/json.');
  if (request.headers.has('Content-Encoding')) throw new IngestError(415, 'content_encoding', 'Compressed requests are not supported.');
  const reader = request.body?.getReader();
  if (!reader) throw new IngestError(400, 'invalid_json', 'A JSON body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new IngestError(413, 'payload_too_large', 'Request exceeds the byte limit.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function sameOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) throw new IngestError(403, 'origin_rejected', 'Cross-origin requests are not accepted.');
}
export async function device(request: Request, env: Env): Promise<string> {
  sameOrigin(request);
  const authorization = request.headers.get('Authorization') ?? '';
  if (!/^Bearer [!-~]{16,256}$/.test(authorization)) throw new IngestError(401, 'unauthorized', 'Device credential required.');
  const hash = await sha256(new TextEncoder().encode(authorization.slice(7)));
  const row = await env.DB.prepare('SELECT id FROM device_nodes WHERE credential_sha256 = ? AND enabled = 1').bind(hash).first<{ id: string }>();
  if (!row) throw new IngestError(401, 'unauthorized', 'Device credential required.');
  return row.id;
}
export async function authorizeResearch(request: Request, env: Env) {
  sameOrigin(request);
  if (!env.RESEARCH_TOKEN) throw new IngestError(503, 'research_not_configured', 'Research access is not configured.');
  const [actual, expected] = await Promise.all([
    sha256(new TextEncoder().encode(request.headers.get('Authorization') ?? '')),
    sha256(new TextEncoder().encode(`Bearer ${env.RESEARCH_TOKEN}`)),
  ]);
  let mismatch = 0;
  for (let i = 0; i < actual.length; i++) mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  if (mismatch) throw new IngestError(401, 'unauthorized', 'Research credential required.');
}

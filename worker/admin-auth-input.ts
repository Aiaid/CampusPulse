import { IngestError, parseIngestJson } from './ingest-validation';
import { readBytes } from './ingest';

export function authObject(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IngestError(422, 'invalid_auth_input', 'Provide the supported authentication fields.');
  const o = value as Record<string, unknown>;
  if (required.some(k => !Object.hasOwn(o, k)) || Object.keys(o).some(k => !required.includes(k) && !optional.includes(k)))
    throw new IngestError(422, 'invalid_auth_input', 'Provide the supported authentication fields.');
  return o;
}
export const authBody = async (request: Request, limit = 32768) => parseIngestJson(await readBytes(request, limit));
export function authName(value: unknown): string {
  if (typeof value !== 'string' || !/^[^\x00-\x1f\x7f]{1,80}$/.test(value) || !value.trim())
    throw new IngestError(422, 'invalid_name', 'Use a name of 1–80 printable characters.');
  return value;
}

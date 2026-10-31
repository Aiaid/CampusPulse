import { IngestError } from './strict-json';

export const ID = /^[a-z0-9_-]{1,64}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const invalid = (path: string): never => { throw new IngestError(422, 'invalid_device_v3', `Invalid field: ${path}.`); };
export function object(value: unknown, path: string, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(path);
  const o = value as Record<string, unknown>;
  if (required.some(k => !Object.hasOwn(o, k)) || Object.keys(o).some(k => !required.includes(k) && !optional.includes(k))) invalid(path);
  return o;
}
export const integer = (value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid(path);
export const string = (value: unknown, path: string, re = ID): string => typeof value === 'string' && re.test(value) ? value : invalid(path);
export function choice<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : invalid(path);
}

import type { Env } from './types';
import { IngestError } from './strict-json';

export interface RuntimeSettings {
  site_name: string;
  default_mode: 'demo' | 'field';
  stale_after_seconds: number;
  observation_ttl_minutes: number;
  default_raw_retention_hours: number;
  default_aggregate_retention_days: number;
}
const keys = ['site_name', 'default_mode', 'stale_after_seconds', 'observation_ttl_minutes', 'default_raw_retention_hours', 'default_aggregate_retention_days'];

export function validateSettings(value: unknown): RuntimeSettings {
  const fail = (): never => { throw new IngestError(422, 'invalid_settings', 'Provide all supported settings with valid values.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const o = value as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || Object.keys(o).some(key => !keys.includes(key))) return fail();
  if (typeof o.site_name !== 'string' || !/^[^\x00-\x1f\x7f]{1,80}$/.test(o.site_name) || !o.site_name.trim() ||
      typeof o.default_mode !== 'string' || !['demo', 'field'].includes(o.default_mode)) return fail();
  for (const [key, min, max] of [
    ['stale_after_seconds', 30, 604800], ['observation_ttl_minutes', 1, 1440],
    ['default_raw_retention_hours', 1, 8760], ['default_aggregate_retention_days', 1, 3650],
  ] as const) if (typeof o[key] !== 'number' || !Number.isSafeInteger(o[key]) || o[key] < min || o[key] > max) return fail();
  return o as unknown as RuntimeSettings;
}

export async function readSettingsRecord(env: Env): Promise<{ settings: RuntimeSettings; revision: number }> {
  const row = await env.DB.prepare('SELECT settings_json,revision FROM admin_settings WHERE id = 1').first<{ settings_json: string; revision: number }>();
  if (!row) throw new IngestError(503, 'settings_unavailable', 'Runtime settings are unavailable.');
  try { return { settings: validateSettings(JSON.parse(row.settings_json)), revision: row.revision }; }
  catch { throw new IngestError(503, 'settings_unavailable', 'Runtime settings are unavailable.'); }
}
export async function readRuntimeSettings(env: Env): Promise<RuntimeSettings> {
  return (await readSettingsRecord(env)).settings;
}
export async function readPublicSettings(env: Env): Promise<Pick<RuntimeSettings, 'site_name' | 'default_mode'>> {
  const { site_name, default_mode } = await readRuntimeSettings(env);
  return { site_name, default_mode };
}

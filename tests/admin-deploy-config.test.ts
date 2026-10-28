import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = resolve('scripts/cloudflare-config.mjs');
function generate(extra: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'campuspulse-auth-deploy-'));
  try {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'wrangler.jsonc'), readFileSync(resolve('wrangler.jsonc')));
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: {
      PATH: process.env.PATH,
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      CLOUDFLARE_D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111',
      CLOUDFLARE_R2_RAW_BUCKET: 'synthetic-private-auth-fixture',
      OPERATOR_TOKEN: 'synthetic-unused-config-test-operator',
      MQTT_PROVISIONING_KEY: 'synthetic-unused-config-test-mqtt-key',
      ADMIN_TOKEN: 'synthetic-unused-config-test-admin',
      RESEARCH_TOKEN: 'synthetic-unused-config-test-research',
      ...extra,
    } });
    const path = join(root, '.wrangler/deploy/wrangler.json');
    return { status: result.status, config: existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('trusted administrator deployment origin', () => {
  it('uses explicit trust configuration and preserves native crypto/private storage bindings', () => {
    const result = generate({ ADMIN_WEBAUTHN_ORIGIN: 'https://admin.example.test/', ADMIN_WEBAUTHN_RP_ID: 'admin.example.test', DEPLOYMENT_URL: 'https://other.example.test' });
    expect(result.status).toBe(0);
    expect(result.config.vars).toEqual({ ADMIN_WEBAUTHN_ORIGIN: 'https://admin.example.test', ADMIN_WEBAUTHN_RP_ID: 'admin.example.test' });
    expect(result.config.compatibility_flags).toContain('nodejs_compat');
    expect(result.config.r2_buckets).toEqual([{ binding: 'RAW_BUCKET', bucket_name: 'synthetic-private-auth-fixture' }]);
    expect(JSON.stringify(result.config)).not.toContain('ADMIN_TOKEN');
  });
  it('can derive the RP from an explicitly configured deployment origin', () => {
    const result = generate({ DEPLOYMENT_URL: 'https://pulse.fixture.test' });
    expect(result.status).toBe(0);
    expect(result.config.vars.ADMIN_WEBAUTHN_RP_ID).toBe('pulse.fixture.test');
  });
  it.each([
    { ADMIN_WEBAUTHN_ORIGIN: 'http://admin.example.test' },
    { ADMIN_WEBAUTHN_ORIGIN: 'https://admin.example.test/path' },
    { ADMIN_WEBAUTHN_ORIGIN: 'https://admin.example.test?changed=1' },
    { ADMIN_WEBAUTHN_ORIGIN: 'https://admin.example.test/#changed' },
    { ADMIN_WEBAUTHN_ORIGIN: 'https://synthetic:fixture@admin.example.test' },
    { ADMIN_WEBAUTHN_ORIGIN: 'https://admin.example.test', ADMIN_WEBAUTHN_RP_ID: 'example.test' },
    { ADMIN_WEBAUTHN_RP_ID: 'admin.example.test' },
  ])('rejects untrusted or mismatched origin configuration before producing deploy config', values => {
    const result = generate(Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
    expect(result.status).not.toBe(0);
    expect(result.config).toBeNull();
  });
});

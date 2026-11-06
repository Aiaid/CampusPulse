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
      DEVICE_V3_STARTUP_ENABLED: extra.DEVICE_V3_CONTROL_ENABLED==='false'||extra.DEVICE_V3_STATISTICS_ENABLED==='false'?'false':'true',
      DEVICE_V3_CLOCK_KEY_ID: 'cp-clock-20261102',
      DEVICE_V3_CLOCK_AUDIENCE: 'https://pulse.anend.net',
      DEVICE_V3_CLOCK_MAX_ERROR_MS: '1000',
      DEVICE_V3_CLOCK_PRIVATE_KEY_JWK: 'synthetic-unused-config-test-clock-key',
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
    expect(result.config.vars).toMatchObject({ ADMIN_WEBAUTHN_ORIGIN: 'https://admin.example.test', ADMIN_WEBAUTHN_RP_ID: 'admin.example.test' });
    expect(result.config.compatibility_flags).toContain('nodejs_compat');
    expect(result.config.r2_buckets).toEqual([{ binding: 'RAW_BUCKET', bucket_name: 'synthetic-private-auth-fixture' }]);
    // Secret names must be declared so Wrangler loads private local variables;
    // their actual values must never become public vars/configuration.
    expect(result.config.secrets.required).toContain('ADMIN_TOKEN');
    expect(result.config.vars).not.toHaveProperty('ADMIN_TOKEN');
    expect(result.config.vars).not.toHaveProperty('MQTT_PROVISIONING_KEY');
    expect(result.config.vars).not.toHaveProperty('DEVICE_V3_CLOCK_PRIVATE_KEY_JWK');
    for (const value of ['synthetic-unused-config-test-admin','synthetic-unused-config-test-operator',
      'synthetic-unused-config-test-research','synthetic-unused-config-test-mqtt-key','synthetic-unused-config-test-clock-key']) {
      expect(JSON.stringify(result.config)).not.toContain(value);
    }
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

describe('small-statistics release configuration', () => {
  it('enables only the reviewed small-statistics producer without external rollout variables', () => {
    const result = generate({});
    expect(result.status).toBe(0);
    expect(result.config.vars).toEqual({ DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true',
      DEVICE_V3_PRODUCER_VERSIONS: '["cp-v3-small/1"]', DEVICE_V3_INGEST_ENABLED: 'false', CPRAW_ARCHIVE_ENABLED: '0',
      DEVICE_V3_SIMULATOR_NODE_IDS: '[]',
      DEVICE_V3_SIMULATOR_CONTINUOUS_NODE_IDS: '[]',
      DEVICE_V3_STARTUP_ENABLED:'true',DEVICE_V3_CLOCK_KEY_ID:'cp-clock-20261102',DEVICE_V3_CLOCK_AUDIENCE:'https://pulse.anend.net',DEVICE_V3_CLOCK_MAX_ERROR_MS:'1000' });
    expect(result.config.triggers.crons).toEqual(['*/15 * * * *']);
    expect(result.config.d1_databases[0].migrations_dir).toMatch(/migrations$/);
    expect(JSON.parse(readFileSync(resolve('wrangler.jsonc'), 'utf8')).vars.DEVICE_V3_STARTUP_ENABLED).toBe('false');
  });
  it.each<Record<string, string>>([
    { DEVICE_V3_STATISTICS_ENABLED: 'false' },
    { DEVICE_V3_CONTROL_ENABLED: 'false', DEVICE_V3_STATISTICS_ENABLED: 'false' },
  ])('permits explicit shutdown gates: %j', extra => {
    const result = generate(extra);
    expect(result.status).toBe(0);
    expect(result.config.vars).toMatchObject(extra);
    expect(result.config.vars.DEVICE_V3_INGEST_ENABLED).toBe('false');
    expect(result.config.vars.CPRAW_ARCHIVE_ENABLED).toBe('0');
  });
  it('canonicalizes an equivalent single reviewed producer list', () => {
    const result = generate({ DEVICE_V3_PRODUCER_VERSIONS: '[ "cp-v3-small/1" ]' });
    expect(result.status).toBe(0);
    expect(result.config.vars.DEVICE_V3_PRODUCER_VERSIONS).toBe('["cp-v3-small/1"]');
  });
  it('admits exact virtual node configuration without changing producer or raw gates', () => {
    const result = generate({ DEVICE_V3_SIMULATOR_NODE_IDS: '[ "sim-live-fixture-1", "sim-live-fixture-2" ]' });
    expect(result.status).toBe(0);
    expect(result.config.vars).toMatchObject({ DEVICE_V3_SIMULATOR_NODE_IDS: '["sim-live-fixture-1","sim-live-fixture-2"]',
      DEVICE_V3_PRODUCER_VERSIONS: '["cp-v3-small/1"]', DEVICE_V3_INGEST_ENABLED: 'false', CPRAW_ARCHIVE_ENABLED: '0' });
  });
  it('permits continuous operation only for an explicit subset of admitted virtual nodes', () => {
    const result = generate({ DEVICE_V3_SIMULATOR_NODE_IDS: '["sim-live-fixture-1","sim-live-fixture-2"]',
      DEVICE_V3_SIMULATOR_CONTINUOUS_NODE_IDS: '[ "sim-live-fixture-2" ]' });
    expect(result.status).toBe(0);
    expect(result.config.vars.DEVICE_V3_SIMULATOR_CONTINUOUS_NODE_IDS).toBe('["sim-live-fixture-2"]');
    expect(result.config.vars.DEVICE_V3_PRODUCER_VERSIONS).toBe('["cp-v3-small/1"]');
  });
  it.each(['invalid', 'null', '{}', '["sim-live-fixture-2"]', '["real-node"]', '["sim-live-fixture-1","sim-live-fixture-1"]'])(
    'rejects malformed or unadmitted continuous simulator scope: %s', nodes => {
      const result = generate({ DEVICE_V3_SIMULATOR_NODE_IDS: '["sim-live-fixture-1"]', DEVICE_V3_SIMULATOR_CONTINUOUS_NODE_IDS: nodes });
      expect(result.status).not.toBe(0);
      expect(result.config).toBeNull();
    });
  it.each(['', 'invalid', 'null', '{}', '"sim-live-fixture"', '["sim-live-fixture","sim-live-fixture"]',
    '["real-node"]', '["sim-live-"]', '["sim-live-*"]', '["sim-live-Fixture"]', '[42]',
    JSON.stringify([`sim-live-${'x'.repeat(56)}`]), JSON.stringify(Array.from({ length: 17 }, (_, i) => `sim-live-fixture-${i}`))])(
    'rejects malformed or broad virtual node configuration: %s', nodes => {
      const result = generate({ DEVICE_V3_SIMULATOR_NODE_IDS: nodes });
      expect(result.status).not.toBe(0);
      expect(result.config).toBeNull();
    });
  it.each<Record<string, string>>([
    { DEVICE_V3_CONTROL_ENABLED: 'false' },
    { DEVICE_V3_CONTROL_ENABLED: 'TRUE' },
    { DEVICE_V3_STATISTICS_ENABLED: '1' },
    { DEVICE_V3_STATISTICS_ENABLED: '' },
    { DEVICE_V3_STARTUP_ENABLED: '1' },
    { DEVICE_V3_STARTUP_ENABLED: 'true', DEVICE_V3_CONTROL_ENABLED:'false', DEVICE_V3_STATISTICS_ENABLED:'false' },
    { DEVICE_V3_INGEST_ENABLED: 'true' },
    { CPRAW_ARCHIVE_ENABLED: '1' },
    { DEVICE_V3_PRODUCER_VERSIONS: 'invalid' },
    { DEVICE_V3_PRODUCER_VERSIONS: '"cp-v3-small/1"' },
    { DEVICE_V3_PRODUCER_VERSIONS: '[]' },
    { DEVICE_V3_PRODUCER_VERSIONS: '["cp-v3-small/1","cp-v3-producer/1"]' },
    { DEVICE_V3_PRODUCER_VERSIONS: '["cp-v3-small/1","cp-v3-small/1"]' },
    { DEVICE_V3_PRODUCER_VERSIONS: '["synthetic-statistics/1"]' },
  ])('rejects invalid gates or release expansion before writing a config: %j', extra => {
    const result = generate(extra);
    expect(result.status).not.toBe(0);
    expect(result.config).toBeNull();
  });
});

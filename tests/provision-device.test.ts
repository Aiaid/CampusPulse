import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { buildProvisioningSql, buildProvisioningStatements, validatePlacement } from '../scripts/provision-device.mjs';
import type { CaptureConfig } from '../worker/ingest-validation';

const config = JSON.parse(readFileSync(new URL('../docs/specs/examples/capture-config.fixture.json', import.meta.url), 'utf8')) as CaptureConfig;
const placement = { id: config.placement_id, node_id: config.node_id, place_id: 'library', valid_from_ms: 0, valid_until_ms: null };
const token = "synthetic-'credential-with-punctuation";
const clone = <T>(value: T): T => structuredClone(value);
const script = new URL('../scripts/provision-device.mjs', import.meta.url);

describe('new-node provisioning', () => {
  it('generates runnable SQL with only a credential digest and immutable registry rows', () => {
    const sql = buildProvisioningSql(config, placement, token);
    const statements = buildProvisioningStatements(config, placement, token);
    expect(sql).not.toContain(token);
    expect(statements).toHaveLength(3);
    expect(sql).not.toContain('BEGIN TRANSACTION;');
    expect(sql).not.toContain('COMMIT;');
    for (const statement of statements) expect(sql).toContain(statement);
    expect(sql).toContain('INSERT INTO device_nodes');
    expect(sql).not.toContain('OR REPLACE');
    const db = new DatabaseSync(':memory:');
    try {
      for (const migration of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
        db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
      }
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(sql);
      const node = db.prepare('SELECT credential_sha256 FROM device_nodes WHERE id = ?').get(config.node_id) as { credential_sha256: string };
      expect(node.credential_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(node.credential_sha256).not.toContain(token);
      const row = db.prepare('SELECT config_json,raw_retention_hours,aggregate_retention_days FROM capture_configs WHERE id = ?').get(config.capture_config_id) as { config_json: string; raw_retention_hours: number; aggregate_retention_days: number };
      expect(JSON.parse(row.config_json)).toEqual(config);
      expect(row.raw_retention_hours).toBe(24);
      expect(row.aggregate_retention_days).toBe(7);
      expect(() => db.exec(sql)).toThrow();
    } finally { db.close(); }
  });

  it('rejects invalid placement and configuration without generating SQL', () => {
    const badPlace = { ...placement, place_id: "library');DROP TABLE device_nodes;--" };
    expect(() => validatePlacement(badPlace, config)).toThrow();
    expect(() => buildProvisioningSql(config, badPlace, token)).toThrow();
    expect(() => buildProvisioningSql(config, { ...placement, node_id: 'other' }, token)).toThrow();
    expect(() => buildProvisioningSql(config, { ...placement, valid_until_ms: 0 }, token)).toThrow();
    expect(() => buildProvisioningSql(config, { ...placement, unexpected: true }, token)).toThrow();
    const badConfig = clone(config); badConfig.upload_policy.warn_pct = 90;
    expect(() => buildProvisioningSql(badConfig, placement, token)).toThrow();
    expect(() => buildProvisioningSql(config, placement, 'short')).toThrow();
    expect(() => buildProvisioningSql(config, placement, `${token}\n`)).toThrow();
  });

  it('reads the private token file and writes a mode-600 ignored SQL file without exposing the token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'campuspulse-provision-'));
    const configFile = join(dir, 'config.json');
    const placeFile = join(dir, 'placement.json');
    const tokenFile = join(dir, 'device-token');
    const output = join(dir, 'provision.sql');
    writeFileSync(configFile, JSON.stringify(config));
    writeFileSync(placeFile, JSON.stringify(placement));
    writeFileSync(tokenFile, token, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    const run = spawnSync(process.execPath, ['--experimental-strip-types', script.pathname,
      '--config', configFile, '--placement', placeFile, '--token-file', tokenFile, '--output', output],
      { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(`${run.stdout}${run.stderr}`).not.toContain(token);
    expect(readFileSync(output, 'utf8')).not.toContain(token);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const retry = spawnSync(process.execPath, ['--experimental-strip-types', script.pathname,
      '--config', configFile, '--placement', placeFile, '--token-file', tokenFile, '--output', output],
      { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
    expect(retry.status).not.toBe(0);
    expect(`${retry.stdout}${retry.stderr}`).not.toContain(token);
  });

  it('rejects a tracked output path and a token file readable by other users', () => {
    const dir = mkdtempSync(join(tmpdir(), 'campuspulse-provision-'));
    const configFile = join(dir, 'config.json');
    const placeFile = join(dir, 'placement.json');
    const tokenFile = join(dir, 'device-token');
    writeFileSync(configFile, JSON.stringify(config));
    writeFileSync(placeFile, JSON.stringify(placement));
    writeFileSync(tokenFile, token, { mode: 0o644 });
    chmodSync(tokenFile, 0o644);
    const args = ['--experimental-strip-types', script.pathname, '--config', configFile,
      '--placement', placeFile, '--token-file', tokenFile, '--output', join(dir, 'output.sql')];
    const insecure = spawnSync(process.execPath, args, { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
    expect(insecure.status).not.toBe(0);
    chmodSync(tokenFile, 0o600);
    args[args.length - 1] = new URL('../package.json', import.meta.url).pathname;
    const tracked = spawnSync(process.execPath, args, { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
    expect(tracked.status).not.toBe(0);
    expect(`${tracked.stdout}${tracked.stderr}`).not.toContain(token);
  });
});

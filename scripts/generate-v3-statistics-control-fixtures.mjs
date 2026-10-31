#!/usr/bin/env node
/** Pure synthetic C/server parity fixtures. No device credentials or captures are read or emitted.
 * stdout: {schema,applied,failed,lease}; requestBytes is the exact UTF-8 JSON string.
 * Run as a separate process because both JavaScript and SQLite clocks are fixed.
 */
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const FIXED_MS = 1793318400000; // 2026-10-30T00:00:00.000Z; synthetic protocol clock.
const ActualDate = Date;
globalThis.Date = class SyntheticDate extends ActualDate {
  constructor(...args) { super(...(args.length ? args : [FIXED_MS])); }
  static now() { return FIXED_MS; }
};
const bundle = await build({ stdin: { contents: `
  export { handleDeviceV3Control } from './worker/device-v3-control';
  export { createAdminSession } from './worker/admin-auth';
  export { sha256 } from './worker/http';
  export { sqliteD1 } from './tests/helpers/ingestion';
  export { v3Ack, v3Registration } from './tests/helpers/device-v3-fixtures';
  export { statisticsCapabilities, statisticsPolicy } from './tests/helpers/v3-statistics-policy-fixtures';`,
  resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', external: ['node:*'] });
const { handleDeviceV3Control, createAdminSession, sha256, sqliteD1, v3Ack, v3Registration, statisticsCapabilities, statisticsPolicy } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const db = new DatabaseSync(':memory:');
try {
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  db.function('strftime', (format, _date) => {
    if (format === '%s') return String(FIXED_MS / 1000);
    if (format === '%f') return '00.000';
    if (format === '%Y-%m-%dT%H:%M:%fZ') return new Date().toISOString();
    throw new Error('Unexpected synthetic SQL date format');
  });
  const caps = statisticsCapabilities('synthetic-stats-notregister', FIXED_MS);
  const policy = await statisticsPolicy(caps, 'synthetic-place-notregister', 1, FIXED_MS);
  // Test-only transport principals are generated in memory and never included in fixtures.
  const token = crypto.randomUUID(), adminSecret = crypto.randomUUID(), origin = 'https://synthetic-statistics.example.test';
  db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').run(caps.node_id, await sha256(new TextEncoder().encode(token)));
  db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,0)').run(policy.custody.placement_id, caps.node_id, 'library');
  const session = await createAdminSession(adminSecret), now = new Date().toISOString();
  db.prepare('INSERT INTO admin_accounts(id,username,display_name,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('synthetic-admin', 'synthetic-admin', 'Synthetic fixture', 'unused', 'synthetic-user', now, now);
  db.prepare("INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms,role,account_id,auth_version) VALUES(?,?,?,'admin','synthetic-admin',1)")
    .run(session.hash, now, session.expires);
  const env = { DB: sqliteD1(db), DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true',
    DEVICE_V3_PRODUCER_VERSIONS: '["synthetic-statistics/1"]', ADMIN_TOKEN: adminSecret };
  async function send(path, request, admin = false) {
    const requestBytes = JSON.stringify(request), body_sha256 = await sha256(new TextEncoder().encode(requestBytes));
    const response = await handleDeviceV3Control(new Request(origin + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(admin ? { Origin: origin, Cookie: 'cp_admin_session=' + session.value } : { Authorization: 'Bearer ' + token }) },
      body: requestBytes }), env);
    const receipt = await response.json();
    if (response.status !== 200) throw new Error('Synthetic control fixture failed: ' + JSON.stringify(receipt));
    return { requestBytes, request, receipt, body_sha256 };
  }
  await send('/api/v3/device/capabilities', v3Registration(caps));
  await send('/api/v1/admin/device-v3/assignments', { policy, expected_generation: 0 }, true);
  const applied = await send('/api/v3/device/config/ack', await v3Ack(policy));
  const lease = await send('/api/v3/device/lease', { protocol: 'campuspulse/3', boot_id: caps.boot_id, policy_id: policy.policy_id,
    policy_sha256: applied.request.policy_sha256, assignment_generation: 1, contact_seq: 1, uptime_ms: 2000 });
  const next = await statisticsPolicy(caps, policy.custody.placement_id, 2, FIXED_MS);
  await send('/api/v1/admin/device-v3/assignments', { policy: next, expected_generation: 1 }, true);
  const failed = await send('/api/v3/device/config/ack', { ...await v3Ack(next, 2), state: 'failed', error_code: 'storage_failed' });
  process.stdout.write(JSON.stringify({ schema: 'v3-statistics-control-fixtures/1', applied, failed, lease }, null, 2) + '\n');
} finally {
  db.close(); globalThis.Date = ActualDate;
}

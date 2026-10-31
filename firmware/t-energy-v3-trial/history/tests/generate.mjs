// Entirely synthetic, in-memory backend evidence. No credentials/captures from disk.
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
let clock = 1793318400000;
const OriginalDate = Date;
globalThis.Date = class extends OriginalDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
};
const bundle = await build({ stdin: { contents: `
  export { handleDeviceV3Control } from './worker/device-v3-control';
  export { createAdminSession } from './worker/admin-auth';
  export { sha256 } from './worker/ingest';
  export { freezeDeviceConfigV3 } from './worker/device-v3-config';
  export { sqliteD1 } from './tests/helpers/ingestion';
  export { v3Ack, v3Registration } from './tests/helpers/device-v3-fixtures';
  export { statisticsCapabilities, statisticsPolicy } from './tests/helpers/v3-statistics-policy-fixtures';`,
  resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', external: ['node:*'] });
const api = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const db = new DatabaseSync(':memory:');
try {
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(root + '/migrations').filter(n => /^\d+.*\.sql$/.test(n)).sort())
    db.exec(readFileSync(root + '/migrations/' + name, 'utf8'));
  db.function('strftime', (format, _date) => {
    if (format === '%s') return String(Math.floor(clock / 1000));
    if (format === '%f') return '00.000';
    if (format === '%Y-%m-%dT%H:%M:%fZ') return new Date().toISOString();
    throw Error('Unexpected synthetic SQL date format');
  });
  const caps = api.statisticsCapabilities('synthetic-history-notregister', clock);
  caps.producer_version = 'cp-v3-small/1';
  const policy = await api.statisticsPolicy(caps, 'synthetic-history-place', 1, clock);
  const token = crypto.randomUUID(), adminSecret = crypto.randomUUID();
  const origin = 'https://synthetic-history.example.test';
  db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').run(caps.node_id, await api.sha256(new TextEncoder().encode(token)));
  db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,0)').run(policy.custody.placement_id, caps.node_id, 'library');
  const session = await api.createAdminSession(adminSecret), at = new Date().toISOString();
  db.prepare('INSERT INTO admin_accounts(id,username,display_name,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('synthetic-admin', 'synthetic-admin', 'Synthetic fixture', 'unused', 'synthetic-user', at, at);
  db.prepare("INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms,role,account_id,auth_version) VALUES(?,?,?,'admin','synthetic-admin',1)")
    .run(session.hash, at, session.expires);
  const env = { DB: api.sqliteD1(db), DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true',
    DEVICE_V3_PRODUCER_VERSIONS: '["cp-v3-small/1"]', ADMIN_TOKEN: adminSecret };
  async function send(path, request, admin = false) {
    const requestBytes = JSON.stringify(request);
    const response = await api.handleDeviceV3Control(new Request(origin + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(admin ? { Origin: origin, Cookie: 'cp_admin_session=' + session.value } : { Authorization: 'Bearer ' + token }) },
      body: requestBytes }), env);
    const receipt = await response.json();
    if (response.status !== 200) throw Error('Synthetic backend fixture failed: ' + JSON.stringify(receipt));
    return { requestBytes, receipt };
  }
  await send('/api/v3/device/capabilities', api.v3Registration(caps));
  await send('/api/v1/admin/device-v3/assignments', { policy, expected_generation: 0 }, true);
  const applied = await send('/api/v3/device/config/ack', await api.v3Ack(policy));
  const envelope = await api.freezeDeviceConfigV3(policy);
  const leaseRequest = { protocol: 'campuspulse/3', boot_id: caps.boot_id, policy_id: policy.policy_id,
    policy_sha256: envelope.policy_sha256, assignment_generation: 1, contact_seq: 1, uptime_ms: 61000 };
  clock += 60000;
  const contiguous = await send('/api/v3/device/lease', leaseRequest);
  clock += 180000;
  const gap = await send('/api/v3/device/lease', { ...leaseRequest, contact_seq: 2, uptime_ms: 241000 });
  const next = await api.statisticsPolicy(caps, policy.custody.placement_id, 2, clock);
  await send('/api/v1/admin/device-v3/assignments', { policy: next, expected_generation: 1 }, true);
  const failed = await send('/api/v3/device/config/ack', { ...await api.v3Ack(next, 2), state: 'failed', error_code: 'storage_failed' });
  const failedEnvelope = await api.freezeDeviceConfigV3(next);
  process.stdout.write(JSON.stringify({ caps, envelope, applied, contiguous, gap, failed, failedEnvelope }));
} finally { db.close();globalThis.Date = OriginalDate; }

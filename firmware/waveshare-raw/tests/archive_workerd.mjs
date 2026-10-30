// Synthetic stdio bridge to the actual local archive Worker. No public listener,
// production binding, capture file, external fetch or deployment is used.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundle = await build({ absWorkingDir: root, entryPoints: ['tests/helpers/cpraw-workerd.ts'],
  bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'],
  target: 'es2022', logLevel: 'silent' });
const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'cpraw-host-uploader-test', modules: true,
  script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'], r2Buckets: ['RAW_BUCKET'], bindings: { CPRAW_ARCHIVE_ENABLED: '1' },
  log: new Log(LogLevel.ERROR) }));
try {
  const db = await runtime.getD1Database('DB');
  await db.exec('CREATE TABLE device_nodes(id TEXT PRIMARY KEY,credential_sha256 TEXT,enabled INTEGER DEFAULT 1); CREATE TABLE placements(id TEXT,node_id TEXT,UNIQUE(id,node_id));');
  await db.exec(readFileSync(new URL('../../../migrations/0013_cpraw_archive.sql', import.meta.url), 'utf8')
    .replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES (?,?)')
    .bind('synthetic-node', createHash('sha256').update('synthetic-test-token-never-a-real-credential').digest('hex')).run();
  await db.prepare(`INSERT INTO cpraw_archive_policies
    (id,node_id,cpraw_archive,policy_kind,dataset,purpose,accept_until_ms,raw_retention_hours,max_file_bytes,max_files,max_pending_uploads,max_total_bytes)
    VALUES ('synthetic-import','synthetic-node',1,'offline_import','controlled_test','host uploader synthetic',?,1,16780672,20,10,335613440)`)
    .bind(Date.now() + 86400000).run();
  process.stdout.write('{"ready":true}\n');
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      const request = JSON.parse(line);
      if (!request.url.startsWith('https://synthetic.test/api/v1/cpraw/uploads/')) throw Error();
      const response = await runtime.dispatchFetch(request.url, { method: request.method,
        body: request.method === 'GET' ? undefined : Buffer.from(request.body, 'base64'), headers: request.headers });
      process.stdout.write(JSON.stringify({ status: response.status, headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()).toString('base64') }) + '\n');
    } catch {
      process.stdout.write('{"error":"synthetic_fixture_failed"}\n');
    }
  }
} finally {
  await runtime.dispose();
}

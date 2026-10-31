// Standalone local workerd/D1/R2 integration service. No cloud credentials are read.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_DATA_DIR = join(ROOT, 'data/v3-statistics-integration');
export const LEGACY_DATA_DIR = join(ROOT, 'data/v3-integration');
export const INTEGRATION_FLAGS = Object.freeze({
  DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true', DEVICE_V3_INGEST_ENABLED: 'false', CPRAW_ARCHIVE_ENABLED: '0',
  DEVICE_V3_PRODUCER_VERSIONS: '["synthetic-statistics/1","cp-v3-small/1"]',
  DEVICE_V3_EXTRACTOR_VERSIONS: '["cp-v3-stats/1"]',
});
export const LEGACY_INTEGRATION_FLAGS = Object.freeze({
  DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_INGEST_ENABLED: 'true', CPRAW_ARCHIVE_ENABLED: '1',
  DEVICE_V3_STATISTICS_ENABLED: 'false',
  DEVICE_V3_PRODUCER_VERSIONS: '["synthetic-only/1","cp-v3-producer/1"]',
  DEVICE_V3_EXTRACTOR_VERSIONS: '["cp-v3-ad/1","synthetic-extractor/1"]',
});
const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');

// Refuse symlinks rather than chmod/write through them. Runtime children inherit umask.
async function protectTree(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error('unsafe_storage_path');
  await chmod(path, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) for (const entry of await readdir(path)) await protectTree(join(path, entry));
}
async function privateWrite(path, value) {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = await open(temp, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(value, null, 2) + '\n'); } finally { await fd.close(); }
  const { rename } = await import('node:fs/promises');
  await rename(temp, path);
}

/** @param {{profile?: 'statistics'|'legacy-feature', host?: string, port?: number, dataDir?: string, httpsKeyPath?: string, httpsCertPath?: string, publicOrigin?: string, deviceIdentityPath?: string, tenergyIdentityPath?: string, maintenanceIntervalMs?: number, shutdownAfterMs?: number}} options */
export async function startIntegrationServer({ host = '127.0.0.1', port = 8799,
  profile = 'statistics', dataDir, httpsKeyPath, httpsCertPath, publicOrigin, tenergyIdentityPath,
  maintenanceIntervalMs = 60_000, shutdownAfterMs = 90 * 60_000,
  deviceIdentityPath = join(ROOT, 'captures/v3-device-trial/device-identity.json') } = {}) {
  if (!['statistics', 'legacy-feature'].includes(profile) || !host || !Number.isInteger(port) || port < 0 || port > 65535 || !!httpsKeyPath !== !!httpsCertPath ||
    !Number.isSafeInteger(maintenanceIntervalMs) || maintenanceIntervalMs < 10 ||
    !Number.isSafeInteger(shutdownAfterMs) || shutdownAfterMs < 1 || shutdownAfterMs > 2_147_483_647)
    throw new Error('invalid_server_options');
  if (publicOrigin && (new URL(publicOrigin).protocol !== 'https:' || new URL(publicOrigin).origin !== publicOrigin))
    throw new Error('invalid_public_origin');
  const identity = JSON.parse(await readFile(deviceIdentityPath, 'utf8'));
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(identity.node_id) || identity.node_id === 'v3-synthetic-node') throw new Error('invalid_device_identity');
  let tenergyIdentity;
  if (tenergyIdentityPath) {
    if (profile !== 'statistics') throw new Error('statistics_profile_required');
    const file = await lstat(tenergyIdentityPath);
    if (!file.isFile() || (file.mode & 0o777) !== 0o600) throw new Error('private_identity_required');
    tenergyIdentity = JSON.parse(await readFile(tenergyIdentityPath, 'utf8'));
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tenergyIdentity.node_id) ||
      [identity.node_id, 'v3-synthetic-node'].includes(tenergyIdentity.node_id)) throw new Error('invalid_tenergy_identity');
  }
  const cohorts = ['synthetic', 'device', ...(tenergyIdentity ? ['tenergy'] : [])];
  // This launcher owns only this directory, including permissions and lock.
  dataDir = resolve(dataDir ?? (profile === 'statistics' ? DEFAULT_DATA_DIR : LEGACY_DATA_DIR));
  process.umask(0o077);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await protectTree(dataDir);
  const lockPath = join(dataDir, 'server.lock');
  try {
    const oldPid = Number(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(oldPid) || oldPid < 1) throw new Error('invalid_server_lock');
    try { process.kill(oldPid, 0); throw new Error('integration_server_already_running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await rm(lockPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(String(process.pid)); await lock.close();
  let runtime, maintenanceTimer, shutdownTimer, finalMaintenance, maintenanceInFlight, disposing, db, config;
  let draining = false, lastMaintenance = null;
  let closedResolve;
  const closed = new Promise(resolve => { closedResolve = resolve; });
  const maintenancePath = join(dataDir, 'maintenance-status.json'), shutdownPath = join(dataDir, 'shutdown-status.json');
  const inventory = async () => {
    const rows = await db.prepare(`SELECT COUNT(*) source_count,MIN(expires_at_ms) earliest_expiry_ms,MAX(expires_at_ms) latest_expiry_ms
      FROM (SELECT expires_at_ms FROM ingestion_items_v3 UNION ALL SELECT expires_at_ms FROM cpraw_uploads WHERE state!='expired'
        UNION ALL SELECT expires_at_ms FROM statistics_windows_v3 WHERE item_json IS NOT NULL
        UNION ALL SELECT expires_at_ms FROM statistics_events_v3 WHERE item_json IS NOT NULL
        UNION ALL SELECT expires_at_ms FROM statistics_status_v3 WHERE item_json IS NOT NULL)`).first();
    return { source_count: Number(rows.source_count), earliest_expiry_ms: rows.earliest_expiry_ms, latest_expiry_ms: rows.latest_expiry_ms };
  };
  const runMaintenance = () => {
    if (maintenanceInFlight) return maintenanceInFlight;
    maintenanceInFlight = (async () => {
      try {
        const worker = await runtime.getWorker();
        const result = await worker.scheduled({ cron: '* * * * *', scheduledTime: new Date() });
        if (result.outcome !== 'ok') throw new Error('scheduled_failed');
        const row = await db.prepare('SELECT report_json FROM v3_integration_maintenance WHERE id=1').first();
        lastMaintenance = JSON.parse(row.report_json);
        Object.assign(lastMaintenance, { remaining: await inventory() });
      } catch { lastMaintenance = { checked_at_ms: Date.now(), status: 'failed', error: 'maintenance_failed' }; }
      await privateWrite(maintenancePath, lastMaintenance);
      return lastMaintenance;
    })().finally(() => { maintenanceInFlight = undefined; });
    return maintenanceInFlight;
  };
  const dispose = async () => {
    if (disposing) return disposing;
    disposing = (async () => {
      clearInterval(maintenanceTimer); clearTimeout(shutdownTimer);
      let report;
      try {
        if (finalMaintenance) {
          await db.prepare("INSERT INTO v3_integration_state(id) VALUES('draining') ON CONFLICT DO NOTHING").run();
          await runMaintenance();
          const remaining = await inventory();
          report = { checked_at_ms: Date.now(), status: lastMaintenance?.status !== 'ok' ? 'shutdown_retention_check_failed' : remaining.source_count ? 'stopped_with_retained_sources' : 'sources_drained', remaining,
            maintenance_status: lastMaintenance?.status ?? 'failed' };
          await privateWrite(shutdownPath, report);
        }
      } catch {
        report = { checked_at_ms: Date.now(), status: 'shutdown_retention_check_failed' };
        await privateWrite(shutdownPath, report);
      } finally {
        try { await runtime?.dispose(); await protectTree(dataDir); }
        finally { await rm(lockPath, { force: true }); closedResolve(report); }
      }
      return report;
    })();
    return disposing;
  };
  try {
    const configPath = join(dataDir, 'private-config.json');
    try { config = JSON.parse(await readFile(configPath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const archiveIds = profile === 'legacy-feature' ? { synthetic: 'v3-synthetic-cpraw', device: 'v3-device-cpraw' } : {};
      config = { schema: 'cp-v3-integration/1', profile, isolation: 'synthetic-controlled-test', operator_confirmed_isolated: true,
        adminSigningSecret: secret(), researchBearer: secret(),
        synthetic: { nodeId: 'v3-synthetic-node', placementId: 'v3-synthetic-placement', deviceBearer: secret(), ...(archiveIds.synthetic ? { archivePolicyId: archiveIds.synthetic } : {}) },
        device: { nodeId: identity.node_id, placementId: 'v3-controlled-placement', deviceBearer: secret(), ...(archiveIds.device ? { archivePolicyId: archiveIds.device } : {}) } };
      await privateWrite(configPath, config);
    }
    if (tenergyIdentity && !config.tenergy) config.tenergy = {
      nodeId: tenergyIdentity.node_id, placementId: 'v3-tenergy-placement', deviceBearer: secret(),
    };
    if (config.schema !== 'cp-v3-integration/1' || config.isolation !== 'synthetic-controlled-test' ||
      (config.profile ?? 'legacy-feature') !== profile ||
      config.operator_confirmed_isolated !== true || !/^[A-Za-z0-9_-]{43}$/.test(config.adminSigningSecret) ||
      config.device?.nodeId !== identity.node_id ||
      (!!config.tenergy !== !!tenergyIdentity) || (tenergyIdentity && config.tenergy?.nodeId !== tenergyIdentity.node_id) ||
      cohorts.some(name => {
        const n = config[name];
        return !n || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(n.nodeId) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(n.placementId) ||
          !/^[A-Za-z0-9_-]{43}$/.test(n.deviceBearer);
      }) || ['nodeId', 'placementId', 'deviceBearer'].some(key => new Set(cohorts.map(name => config[name]?.[key])).size !== cohorts.length))
      throw new Error('invalid_private_config');
    const bundle = await build({ absWorkingDir: ROOT, entryPoints: ['scripts/helpers/v3-integration-worker.ts'],
      bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'], target: 'es2022', logLevel: 'silent' });
    const tls = httpsKeyPath ? { httpsKey: await readFile(httpsKeyPath, 'utf8'), httpsCert: await readFile(httpsCertPath, 'utf8') } : {};
    runtime = new Miniflare(convertV4MiniflareOptions({ name: 'campuspulse-v3-isolated-integration',
      modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
      host, port, https: true, ...tls, publicUrl: publicOrigin, d1Databases: ['DB'], r2Buckets: ['RAW_BUCKET'],
      resourcePersistencePath: join(dataDir, 'storage'), resourceTmpPath: join(dataDir, 'tmp'),
      bindings: { ...(profile === 'statistics' ? INTEGRATION_FLAGS : LEGACY_INTEGRATION_FLAGS), ADMIN_TOKEN: config.adminSigningSecret, RESEARCH_TOKEN: config.researchBearer },
      log: new Log(LogLevel.NONE), logRequests: false }));
    db = await runtime.getD1Database('DB');
    await db.exec('CREATE TABLE IF NOT EXISTS v3_integration_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL); CREATE TABLE IF NOT EXISTS v3_integration_state(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS v3_integration_maintenance(id INTEGER PRIMARY KEY CHECK(id=1),report_json TEXT NOT NULL CHECK(json_valid(report_json)))');
    // Isolated diagnostics only: a fixed set of aggregate error counters. Never
    // retain request bodies, node identities, credentials or arbitrary messages.
    await db.exec(`CREATE TABLE IF NOT EXISTS v3_integration_rejections(
      code TEXT PRIMARY KEY CHECK(code IN ('v3_statistics_authority_missing','v3_statistics_capture_unauthorized','v3_statistics_window_conflict','v3_statistics_batch_conflict','v3_statistics_conflict','invalid_v3_statistics','v3_statistics_time_unprovable')),
      status INTEGER NOT NULL CHECK(status BETWEEN 400 AND 599),
      count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 1000000),last_at_ms INTEGER NOT NULL)`.replace(/\n/g, ' '));
    await db.prepare("DELETE FROM v3_integration_state WHERE id IN ('ready','draining')").run();
    for (const name of (await readdir(join(ROOT, 'migrations'))).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
      const sql = await readFile(join(ROOT, 'migrations', name), 'utf8');
      const applied = await db.prepare('SELECT sha256 FROM v3_integration_migrations WHERE name=?').bind(name).first();
      if (applied) { if (applied.sha256 !== hash(sql)) throw new Error('migration_changed'); continue; }
      await db.exec(sql.replace(/^--.*$/gm, '').replace(/\n/g, ' '));
      await db.prepare('INSERT INTO v3_integration_migrations(name,sha256) VALUES(?,?)').bind(name, hash(sql)).run();
    }
    const now = Date.now();
    for (const cohort of cohorts) {
      const n = config[cohort];
      await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?) ON CONFLICT(id) DO NOTHING').bind(n.nodeId, hash(n.deviceBearer)).run();
      const actual = await db.prepare('SELECT credential_sha256 FROM device_nodes WHERE id=?').bind(n.nodeId).first();
      if (actual?.credential_sha256 !== hash(n.deviceBearer)) throw new Error('node_credential_mismatch');
      const placement = await db.prepare('SELECT node_id FROM placements WHERE id=?').bind(n.placementId).first();
      if (!placement) await db.prepare('INSERT INTO placements(id,node_id,valid_from_ms) VALUES(?,?,0)').bind(n.placementId, n.nodeId).run();
      else if (placement.node_id !== n.nodeId) throw new Error('placement_mismatch');
      if (profile === 'legacy-feature') await db.prepare(`INSERT INTO cpraw_archive_policies(id,node_id,cpraw_archive,policy_kind,dataset,purpose,accept_until_ms,raw_retention_hours,max_file_bytes,max_files,max_pending_uploads,max_total_bytes,placement_id,placement_provenance)
        VALUES(?,?,1,'offline_import','controlled_test',?,?,1,16780672,100,10,1678067200,?,?) ON CONFLICT(id) DO NOTHING`)
        .bind(n.archivePolicyId, n.nodeId, `${cohort} isolated integration`, now + 7 * 86400000, n.placementId, 'Operator-assigned isolated integration placement; no physical location claim').run();
    }
    const time = new Date(now).toISOString(), id = secret(), expires = now + 8 * 3600000, unsigned = `${id}.${expires}`;
    const value = `${unsigned}.${createHmac('sha256', config.adminSigningSecret).update(unsigned).digest('base64url')}`;
    await db.prepare('INSERT INTO admin_accounts(id,username,display_name,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
      .bind('v3-isolated-admin', 'v3-isolated-admin', 'Isolated integration administrator', 'disabled-no-login-route', 'v3-isolated-admin', time, time).run();
    await db.prepare("INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms,role,account_id,auth_version) VALUES(?,?,?,'admin','v3-isolated-admin',1)").bind(hash(id), time, expires).run();
    const url = await runtime.ready;
    config.profile = profile;
    config.endpoint = publicOrigin ?? url.origin; config.allowedOrigin = config.endpoint; config.localEndpoint = url.origin;
    config.adminCookie = `cp_admin_session=${value}`; config.adminCookieExpiresAt = expires;
    for (const cohort of cohorts) Object.assign(config[cohort], {
      endpoint: config.endpoint, allowedOrigin: config.allowedOrigin, adminCookie: config.adminCookie,
      isolation: config.isolation, operator_confirmed_isolated: true,
      profile,
    });
    await privateWrite(configPath, config);
    await protectTree(dataDir);
    await db.prepare("INSERT INTO v3_integration_state(id) VALUES('ready')").run();
    finalMaintenance = true;
    let shutdownInFlight;
    const shutdownGracefully = () => {
      if (disposing) return disposing;
      if (shutdownInFlight) return shutdownInFlight;
      shutdownInFlight = (async () => {
        draining = true;
        await db.prepare("INSERT INTO v3_integration_state(id) VALUES('draining') ON CONFLICT DO NOTHING").run();
        await runMaintenance();
        const remaining = await inventory();
        await privateWrite(shutdownPath, { checked_at_ms: Date.now(), status: remaining.source_count ? 'draining_until_source_expiry' : 'sources_drained', remaining });
        if (!remaining.source_count && lastMaintenance?.status === 'ok') return dispose();
        return { status: 'draining_until_source_expiry', remaining };
      })().finally(() => { shutdownInFlight = undefined; });
      return shutdownInFlight;
    };
    // Explicit local operator operation only. Disable this synthetic node first;
    // never shorten TTLs or touch the controlled device's archive/source rows.
    const retireSyntheticArchives = async () => {
      if (profile !== 'legacy-feature') throw new Error('legacy_profile_required');
      await db.prepare('UPDATE device_nodes SET enabled=0 WHERE id=?').bind(config.synthetic.nodeId).run();
      // Include previously retired tombstones so an explicit retry can also
      // reconcile any delayed R2 write without changing an immutable receipt.
      const uploads = (await db.prepare('SELECT node_id,upload_id,manifest_sha256,manifest_json FROM cpraw_uploads WHERE node_id=?').bind(config.synthetic.nodeId).all()).results;
      let retired = 0;
      try {
        const bucket = await runtime.getR2Bucket('RAW_BUCKET');
        for (const upload of uploads) {
          await db.prepare("UPDATE cpraw_uploads SET state='deleting' WHERE node_id=? AND upload_id=? AND state IN ('open','committed')").bind(config.synthetic.nodeId, upload.upload_id).run();
          const manifest = JSON.parse(upload.manifest_json);
          const keys = manifest.chunks.map(c => `cpraw/${hash(config.synthetic.nodeId)}/${upload.upload_id}/${upload.manifest_sha256}/chunks/${c.index}/${c.sha256}.bin`);
          for (let i = 0; i < keys.length; i += 128) await bucket.delete(keys.slice(i, i + 128));
          await db.batch([
            db.prepare('UPDATE cpraw_chunks SET raw_object_key=NULL WHERE node_id=? AND upload_id=?').bind(config.synthetic.nodeId, upload.upload_id),
            db.prepare("UPDATE cpraw_uploads SET state='expired',private_summary_json=NULL,last_cleanup_at_ms=? WHERE node_id=? AND upload_id=? AND state IN ('deleting','expired')").bind(Date.now(), config.synthetic.nodeId, upload.upload_id),
          ]);
          retired++;
        }
      } catch {
        const report = { checked_at_ms: Date.now(), status: 'synthetic_archive_retirement_failed', retired_count: retired };
        await privateWrite(join(dataDir, 'synthetic-retirement-status.json'), report); return report;
      }
      const report = { checked_at_ms: Date.now(), status: 'ok', retired_count: retired };
      await privateWrite(join(dataDir, 'synthetic-retirement-status.json'), report); return report;
    };
    await runMaintenance();
    maintenanceTimer = setInterval(() => {
      void (draining ? shutdownGracefully() : runMaintenance()).catch(() => {});
    }, maintenanceIntervalMs); maintenanceTimer.unref();
    shutdownTimer = setTimeout(() => { void shutdownGracefully().catch(() => {}); }, shutdownAfterMs); shutdownTimer.unref();
    return { runtime, db, configPath, config, dispose, runMaintenance, shutdownGracefully, retireSyntheticArchives, closed };
  } catch (error) { await dispose(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {}, names = { '--profile': 'profile', '--host': 'host', '--port': 'port', '--data-dir': 'dataDir', '--https-key': 'httpsKeyPath', '--https-cert': 'httpsCertPath', '--public-origin': 'publicOrigin', '--device-identity': 'deviceIdentityPath', '--tenergy-identity': 'tenergyIdentityPath', '--shutdown-after-ms': 'shutdownAfterMs' };
    let retireSynthetic = false;
    for (let i = 2; i < process.argv.length; i++) {
      if (process.argv[i] === '--retire-synthetic-archives') { retireSynthetic = true; continue; }
      const name = names[process.argv[i]], value = process.argv[i + 1];
      if (!name || !value) throw new Error('invalid_arguments');
      options[name] = ['port', 'shutdownAfterMs'].includes(name) ? Number(value) : value;
      i++;
    }
    if (options.dataDir) {
      const within = [DEFAULT_DATA_DIR, LEGACY_DATA_DIR].some(root => {
        const child = relative(root, resolve(options.dataDir)); return !child.startsWith('..') && !isAbsolute(child);
      });
      if (!within) throw new Error('data_dir_outside_isolated_root');
    }
    if (retireSynthetic && options.profile !== 'legacy-feature') throw new Error('legacy_profile_required');
    const server = await startIntegrationServer(options);
    if (retireSynthetic && (await server.retireSyntheticArchives()).status !== 'ok') {
      await server.dispose(); throw new Error('synthetic_retirement_failed');
    }
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await server.dispose(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    process.stdout.write(JSON.stringify({ ready: true, privateConfig: server.configPath }) + '\n');
    void server.closed.then(() => { process.exit(0); });
  } catch { process.stderr.write('integration_server_failed\n'); process.exitCode = 1; }
}

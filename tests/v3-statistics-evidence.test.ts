import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { collectStatisticsEvidence, ISOLATED_ROOT, saveStatisticsEvidence, summarizeStatisticsEvidence } from '../scripts/v3-statistics-evidence.mjs';

const exec = promisify(execFile);
let dir: string, dbFile: string;
const synthetic = 'v3-synthetic-statistics-evidence', device = 'controlled-statistics-evidence';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const stamp = '2026-10-30T05:00:00.000Z', ms = Date.parse(stamp), privateValue = 'PRIVATE-ADDRESS-TOKEN-CREDENTIAL-EVIDENCE';
const bodyHash = 'a'.repeat(64), policyHash = 'b'.repeat(64);
const config = () => ({ schema: 'cp-v3-integration/1', profile: 'statistics', isolation: 'synthetic-controlled-test', operator_confirmed_isolated: true,
  adminSigningSecret: privateValue, synthetic: { nodeId: synthetic, deviceBearer: privateValue }, device: { nodeId: device, deviceBearer: privateValue } });

beforeEach(async () => {
  await mkdir(ISOLATED_ROOT, { recursive: true, mode: 0o700 });
  dir = await mkdtemp(join(ISOLATED_ROOT, '.evidence-test-'));
  const dbDir = join(dir, 'storage/d1/miniflare-D1DatabaseObject');
  await mkdir(dbDir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'private-config.json'), JSON.stringify(config()), { mode: 0o600 });
  dbFile = join(dbDir, 'actual.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE v3_integration_migrations(name TEXT,sha256 TEXT);
    CREATE TABLE v3_integration_state(id TEXT); INSERT INTO v3_integration_state VALUES('ready');
    CREATE TABLE device_capabilities_v3(node_id TEXT,capability_sha256 TEXT,registered_at TEXT,issued_at_ms INTEGER,expires_at_ms INTEGER);
    CREATE TABLE device_assignments_v3(node_id TEXT,generation INTEGER,policy_sha256 TEXT,assigned_at TEXT,policy_id TEXT);
    CREATE TABLE device_control_v3(node_id TEXT,desired_generation INTEGER,applied_generation INTEGER,registration_seq INTEGER,apply_seq INTEGER,registered_at TEXT);
    CREATE TABLE device_acknowledgements_v3(node_id TEXT,generation INTEGER,apply_seq INTEGER,state TEXT,body_sha256 TEXT,received_at TEXT);
    CREATE TABLE device_statistics_authorizations_v3(node_id TEXT,generation INTEGER);
    CREATE TABLE device_statistics_lease_spans_v3(node_id TEXT,generation INTEGER,span_seq INTEGER,start_ms INTEGER,end_ms INTEGER,accept_until_ms INTEGER);
    CREATE TABLE statistics_batches_v3(node_id TEXT,boot_id TEXT,batch_id TEXT,stream TEXT,generation INTEGER,policy_sha256 TEXT,body_sha256 TEXT,seq_first INTEGER,seq_last INTEGER,receipt_json TEXT,expires_at_ms INTEGER,retain_until_ms INTEGER);
    CREATE TABLE statistics_windows_v3(node_id TEXT,generation INTEGER,seq INTEGER,clock_epoch INTEGER,window_seq INTEGER,end_utc_ms INTEGER,duration_ms INTEGER,received_at_ms INTEGER,quality_mask INTEGER,extractor_version TEXT,ruleset_version TEXT,item_json TEXT);
    CREATE TABLE statistics_events_v3(node_id TEXT,generation INTEGER,event_id TEXT,seq INTEGER,revision INTEGER,item_sha256 TEXT,received_at_ms INTEGER,item_json TEXT);
    CREATE TABLE statistics_status_v3(node_id TEXT,seq INTEGER,uptime_ms INTEGER,clock_epoch INTEGER,window_drops INTEGER,event_drops INTEGER,status_coalesced INTEGER,upload_failures INTEGER,ack_failures INTEGER,retries INTEGER,item_json TEXT);
    CREATE TABLE public_sensor_projection_v2(node_id TEXT);
    CREATE TABLE public_observation_projection(id TEXT);`);
  for (const [node, seq] of [[device, 21], [synthetic, 1]] as const) {
    db.prepare('INSERT INTO device_capabilities_v3 VALUES(?,?,?,?,?)').run(node,bodyHash,stamp,ms,ms+3600000);
    db.prepare('INSERT INTO device_assignments_v3 VALUES(?,?,?,?,?)').run(node,1,policyHash,stamp,privateValue);
    db.prepare('INSERT INTO device_control_v3 VALUES(?,?,?,?,?,?)').run(node,1,1,1,1,stamp);
    db.prepare('INSERT INTO device_acknowledgements_v3 VALUES(?,?,?,?,?,?)').run(node,1,1,'applied',bodyHash,stamp);
    db.prepare('INSERT INTO device_statistics_lease_spans_v3 VALUES(?,?,?,?,?,?)').run(node,1,1,ms,ms+60000,ms+3600000);
    db.prepare('INSERT INTO statistics_windows_v3 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(node,1,seq,1,seq,ms,60000,ms,0,'cp-v3-stats/1','unclassified-v1',JSON.stringify({privateValue}));
    db.prepare('INSERT INTO statistics_events_v3 VALUES(?,?,?,?,?,?,?,?)').run(node,1,privateValue,seq,2,bodyHash,ms,JSON.stringify({privateValue}));
    db.prepare('INSERT INTO statistics_status_v3 VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(node,seq,60000,1,0,0,0,0,0,0,JSON.stringify({privateValue}));
    for (const stream of ['window_statistics','candidate_events','node_status']) {
      const receipt = { protocol:'campuspulse/3', schema:'device-statistics-receipt/3', node_id:node,boot_id:privateValue,batch_id:stream+privateValue,
        stream,body_sha256:bodyHash,seq_first:seq,seq_last:seq,accepted_count:1,assignment_generation:1,policy_id:privateValue,policy_sha256:policyHash,
        received_at:stamp,expires_at:new Date(ms+3600000).toISOString(),retain_until:new Date(ms+7200000).toISOString(),durability:'committed',custody:'small_statistics',receipt_id:'f9313820-b1fc-46f8-9e0d-0b5ea404b1b7' };
      db.prepare('INSERT INTO statistics_batches_v3 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(node,privateValue,stream+privateValue,stream,1,policyHash,bodyHash,seq,seq,JSON.stringify(receipt),ms+3600000,ms+7200000);
    }
  }
  db.close(); await chmod(dbFile,0o600);
  // A decoy metadata SQLite with identical tables must never be selected.
  await copyFile(dbFile,join(dbDir,'metadata.sqlite'));
  await chmod(join(dbDir,'metadata.sqlite'),0o600);
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(dir,{recursive:true,force:true}); });

async function snapshot(path = dir): Promise<Record<string,string>> {
  const files: Record<string,string> = {};
  for (const name of await readdir(path)) {
    const filename=join(path,name), stat=await lstat(filename);
    if (stat.isDirectory()) Object.assign(files,await snapshot(filename));
    else files[filename]=hash(await readFile(filename));
  }
  return files;
}

it('reads only configured cohort, reports statistics custody and never writes SQLite or contacts a service', async () => {
  const fetch = vi.fn(() => { throw new Error('no_network'); }); vi.stubGlobal('fetch',fetch);
  const before=await snapshot();
  const report=await collectStatisticsEvidence({dataDir:dir});
  expect(report.counts).toEqual({capabilities:1,assignments:1,applied:1,failed:0,lease_spans:1});
  expect(report.statistics_counts).toEqual({windows:1,event_latest:1,statuses:1,receipts:3});
  expect(report.windows[0]).toMatchObject({generation:1,seq:21,extractor_version:'cp-v3-stats/1'});
  expect(report.event_latest[0]).toMatchObject({revision:2,seq:21,item_sha256:bodyHash});
  expect(report.public_projection).toEqual({sensor_node_rows:0,sensor_total_rows:0,observation_total_rows:0});
  for (const stream of Object.values(report.streams) as any[]) {
    expect(stream.generations).toEqual([{generation:1,boot_sha256:hash(privateValue),receipts:1,seq_first:21,seq_last:21}]);
    expect(stream.batches[0].receipt_metadata_matches).toBe(true);
    expect(stream.batches[0].receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  expect((await collectStatisticsEvidence({dataDir:dir,cohort:'synthetic'})).windows[0].seq).toBe(1);
  const text=JSON.stringify(report);
  for (const value of [privateValue,device,synthetic,'item_json','receipt_json','event_id','Bearer','Cookie']) expect(text).not.toContain(value);
  expect(fetch).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
  expect(report.physical_validation).toBe('not_established');
  expect(summarizeStatisticsEvidence(report)).not.toHaveProperty('windows');
});

it('marks mismatched receipt metadata and excludes malicious freeform output fields', async () => {
  const db=new DatabaseSync(dbFile);
  db.prepare('UPDATE statistics_batches_v3 SET receipt_json=? WHERE node_id=? AND stream=?').run(JSON.stringify({node_id:privateValue}),device,'window_statistics');
  db.prepare('UPDATE statistics_windows_v3 SET extractor_version=?,ruleset_version=? WHERE node_id=?').run(privateValue,privateValue,device);
  db.prepare('UPDATE statistics_events_v3 SET item_sha256=? WHERE node_id=?').run(privateValue,device);
  db.close();
  const report=await collectStatisticsEvidence({dataDir:dir});
  expect(report.streams.window_statistics.batches[0].receipt_metadata_matches).toBe(false);
  expect(report.windows[0].extractor_version).toBeNull(); expect(report.event_latest[0].item_sha256).toBeNull();
  expect(JSON.stringify(report)).not.toContain(privateValue);
});

it.each(['node_id','boot_id','batch_id','stream','body_sha256','policy_id','policy_sha256','assignment_generation','seq_first','seq_last','accepted_count','expires_at','retain_until','custody','durability','receipt_id'])('rejects changed receipt metadata: %s', async field => {
  const db=new DatabaseSync(dbFile);
  const row=db.prepare('SELECT receipt_json FROM statistics_batches_v3 WHERE node_id=? AND stream=?').get(device,'window_statistics')!;
  const receipt=JSON.parse(row.receipt_json as string); receipt[field]=privateValue+'-changed';
  db.prepare('UPDATE statistics_batches_v3 SET receipt_json=? WHERE node_id=? AND stream=?').run(JSON.stringify(receipt),device,'window_statistics'); db.close();
  const report=await collectStatisticsEvidence({dataDir:dir});
  expect(report.streams.window_statistics.batches[0].receipt_metadata_matches).toBe(false);
  expect(JSON.stringify(report)).not.toContain(privateValue);
});

it('preserves boot boundaries and accepts a valid sequence range containing dropped items', async () => {
  const db=new DatabaseSync(dbFile);
  const row=db.prepare('SELECT receipt_json FROM statistics_batches_v3 WHERE node_id=? AND stream=?').get(device,'window_statistics')!;
  const receipt=JSON.parse(row.receipt_json as string); receipt.seq_last=23; receipt.accepted_count=2;
  db.prepare('UPDATE statistics_batches_v3 SET seq_last=23,receipt_json=? WHERE node_id=? AND stream=?').run(JSON.stringify(receipt),device,'window_statistics');
  db.prepare('INSERT INTO statistics_batches_v3 SELECT node_id,?,batch_id,stream,generation,policy_sha256,body_sha256,1,1,receipt_json,expires_at_ms,retain_until_ms FROM statistics_batches_v3 WHERE node_id=? AND stream=?').run('another-private-boot',device,'window_statistics'); db.close();
  const report=await collectStatisticsEvidence({dataDir:dir});
  expect(report.streams.window_statistics.generations).toHaveLength(2);
  expect(report.streams.window_statistics.batches.find(batch=>batch.seq_first===21)?.receipt_metadata_matches).toBe(true);
  expect(JSON.stringify(report)).not.toContain('another-private-boot');
});

it('flags bounded details without reducing totals', async () => {
  const db=new DatabaseSync(dbFile);
  db.prepare('INSERT INTO statistics_windows_v3 SELECT * FROM statistics_windows_v3 WHERE node_id=?').run(device);
  db.prepare('INSERT INTO statistics_batches_v3 SELECT * FROM statistics_batches_v3 WHERE node_id=? AND stream=?').run(device,'window_statistics'); db.close();
  const report=await collectStatisticsEvidence({dataDir:dir,limit:1});
  expect(report.statistics_counts.windows).toBe(2); expect(report.windows).toHaveLength(1); expect(report.details_truncated).toBe(true);
  expect(report.streams.window_statistics.details_truncated).toBe(true);
});

it('selects an explicit tenergy cohort and never falls back to device', async () => {
  await expect(collectStatisticsEvidence({dataDir:dir,cohort:'tenergy'})).rejects.toThrow('invalid_private_config');
  const nodeId='controlled-tenergy-evidence';
  await writeFile(join(dir,'private-config.json'),JSON.stringify({...config(),tenergy:{nodeId,deviceBearer:privateValue}}));
  const report=await collectStatisticsEvidence({dataDir:dir,cohort:'tenergy'});
  expect(report.node_sha256).toBe(hash(nodeId)); expect(report.counts.capabilities).toBe(0); expect(report.statistics_counts.receipts).toBe(0);
  expect(JSON.stringify(report)).not.toContain(nodeId);
  await writeFile(join(dir,'private-config.json'),JSON.stringify({...config(),tenergy:{nodeId:device}}));
  await expect(collectStatisticsEvidence({dataDir:dir,cohort:'tenergy'})).rejects.toThrow('cohort_identity_mismatch');
});

it('rejects legacy roots, config, permissions, symlinks, ambiguous DBs and missing readiness', async () => {
  await expect(collectStatisticsEvidence({dataDir:join(ISOLATED_ROOT,'../v3-integration')})).rejects.toThrow('outside_isolated_root');
  await expect(collectStatisticsEvidence({dataDir:dir,cohort:'other'} as any)).rejects.toThrow('invalid_cohort');
  await expect(collectStatisticsEvidence({dataDir:dir,limit:1001})).rejects.toThrow('invalid_limit');
  await writeFile(join(dir,'private-config.json'),JSON.stringify({...config(),profile:'legacy-feature'}));
  await expect(collectStatisticsEvidence({dataDir:dir})).rejects.toThrow('invalid_private_config');
  await writeFile(join(dir,'private-config.json'),JSON.stringify(config())); await chmod(join(dir,'private-config.json'),0o644);
  await expect(collectStatisticsEvidence({dataDir:dir})).rejects.toThrow('unsafe_private_path');
  await chmod(join(dir,'private-config.json'),0o600); await symlink(join(dir,'storage'),join(dir,'linked'));
  await expect(collectStatisticsEvidence({dataDir:join(dir,'linked')})).rejects.toThrow('unsafe_private_path');
  const extra=join(dir,'storage/d1/miniflare-D1DatabaseObject/duplicate.sqlite'); await copyFile(dbFile,extra); await chmod(extra,0o600);
  await expect(collectStatisticsEvidence({dataDir:dir})).rejects.toThrow('ambiguous_integration_database'); await rm(extra);
  const db=new DatabaseSync(dbFile); db.exec('DELETE FROM v3_integration_state'); db.close();
  await expect(collectStatisticsEvidence({dataDir:dir})).rejects.toThrow('integration_database_not_ready');
});

it('creates private reports only under the selected source reports directory without overwrite or symlink traversal', async () => {
  const report=await collectStatisticsEvidence({dataDir:dir});
  const output=join(dir,'reports/device.json'); await saveStatisticsEvidence(output,report,{dataDir:dir});
  expect((await lstat(output)).mode&0o777).toBe(0o600); expect((await lstat(join(dir,'reports'))).mode&0o777).toBe(0o700);
  expect(JSON.parse(await readFile(output,'utf8'))).toEqual(report);
  await expect(saveStatisticsEvidence(output,report,{dataDir:dir})).rejects.toThrow();
  await expect(saveStatisticsEvidence(join(dir,'not-reports.json'),report,{dataDir:dir})).rejects.toThrow('outside_isolated_root');
  await expect(saveStatisticsEvidence(join(ISOLATED_ROOT,'reports/cross-root.json'),report,{dataDir:dir})).rejects.toThrow('outside_isolated_root');
  await symlink(join(dir,'reports'),join(dir,'reports/linked'));
  await expect(saveStatisticsEvidence(join(dir,'reports/linked/no.json'),report,{dataDir:dir})).rejects.toThrow('unsafe_private_path');
});

it('CLI emits counts only and returns a constant error for unsafe arguments', async () => {
  const {stdout,stderr}=await exec(process.execPath,['scripts/v3-statistics-evidence.mjs','--data-dir',dir]);
  expect(JSON.parse(stdout).statistics_counts.receipts).toBe(3); expect(stderr).not.toContain(privateValue);
  for (const value of [privateValue,device,synthetic,'seq_first','body_sha256']) expect(stdout).not.toContain(value);
  try { await exec(process.execPath,['scripts/v3-statistics-evidence.mjs','--profile',privateValue]); throw new Error('expected failure'); }
  catch (error: any) { expect(error.stderr).toBe('v3_statistics_evidence_failed\n'); }
});

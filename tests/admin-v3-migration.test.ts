import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {expect,it} from 'vitest';
import {fixture,sqliteD1} from './helpers/ingestion';
import {statisticsFixture,seedStatistics} from './helpers/v3-statistics-fixtures';

it('adds V3 administrator indexes to an upgraded database without rewriting any retained evidence',async()=>{
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 try{
  const files=readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>/^\d+.*\.sql$/.test(n)).sort();
  for(const file of files.filter(n=>n<'0018_'))db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  const c=fixture('capture-config.fixture'),c2=fixture('capture-config-v2.fixture');
  db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').run(c.node_id,'a'.repeat(64));
  db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,0)').run(c.placement_id,c.node_id,'library');
  db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)').run(c.capture_config_id,c.node_id,c.placement_id,c.dataset,JSON.stringify(c),Date.parse(c.accept_until));
  db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)').run(c2.capture_config_id,c2.node_id,c2.placement_id,c2.dataset,JSON.stringify(c2),Date.parse(c2.accept_until));
  for(const [i,table] of ['ingestion_batches','ingestion_batches_v2'].entries())db.prepare(`INSERT INTO ${table}(node_id,batch_id,receipt_id,body_sha256,boot_id,stream,seq_first,seq_last,accepted_count,placement_id,capture_config_id,dataset,firmware_version,received_at,expires_at_ms,retain_until_ms) VALUES(?,?,?,?,?,'node_status',1,1,1,?,?,?,?,?,?,?)`)
   .run(c.node_id,`synthetic-history-${i}`,`synthetic-receipt-${i}`,'b'.repeat(64),`synthetic-boot-${i}`,c.placement_id,(i?c2:c).capture_config_id,c.dataset,'historical-fixture','2026-01-01T00:00:00.000Z',2000000000000,2000000000000);
  await seedStatistics(sqliteD1(db),await statisticsFixture(c.node_id,c.placement_id));
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>String(r.name));
  const snapshot=()=>Object.fromEntries(tables.map(name=>[name,db.prepare(`SELECT * FROM "${name}"`).all()]));
  const before=snapshot();db.exec(readFileSync(new URL('../migrations/0018_admin_v3_latest.sql',import.meta.url),'utf8'));
  expect(snapshot()).toEqual(before);expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%v3_admin%' ORDER BY name").all()).toHaveLength(3);
 }finally{db.close();}
});

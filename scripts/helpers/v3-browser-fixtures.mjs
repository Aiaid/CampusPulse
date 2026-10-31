// Synthetic local workerd fixtures only. No production clients or broker I/O.
import {build} from 'esbuild';
import {randomUUID,createHash} from 'node:crypto';
const compiled=await build({stdin:{contents:`export { statisticsFixture, seedStatistics, statisticsBatch } from './tests/helpers/v3-statistics-fixtures'; export { capabilityDigestV3 } from './worker/device-v3-config';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm'});
const tools=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
export const v3BrowserFlags={DEVICE_V3_CONTROL_ENABLED:'true',DEVICE_V3_STATISTICS_ENABLED:'true',DEVICE_V3_PRODUCER_VERSIONS:'["cp-v3-small/1"]'};
export async function seedV3BrowserWindow(db,base,{place='library',dataset='field',age=0,applied=true,visible=2,request=fetch}={}){
 const suffix=randomUUID(),node='synthetic-'+suffix,placement='placement-'+suffix,token='synthetic-token-'+suffix,now=Date.now()-age;
 await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(node,createHash('sha256').update(token).digest('hex')).run();
 const placeRow=dataset==='field'?await db.prepare('SELECT observation_kinds_json FROM places WHERE id=?').bind(place).first():null;
 const purposes=placeRow?.observation_kinds_json??'["activity","parking","elevator"]';
 await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms,observation_kinds_json) VALUES(?,?,?,?,?)').bind(placement,node,dataset==='field'?place:null,0,purposes).run();
 const f=await tools.statisticsFixture(node,placement,now);f.caps.producer_version='cp-v3-small/1';f.policy.custody.dataset=dataset;f.policy.custody.purpose=dataset==='field'?'site_observation':'controlled_test';
 f.policy.control.capability_sha256=await tools.capabilityDigestV3(f.caps);await tools.seedStatistics(db,f,applied);
 if(!applied)return {node,placement};
 const batch=await tools.statisticsBatch(f);batch.x[0].c=[0,0,0,0,visible,0];batch.x[0].x[0][1]=visible;
 const bytes=JSON.stringify(batch),response=await request(base+'/api/v3/statistics/ingest',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Body-SHA256':createHash('sha256').update(bytes).digest('hex')},body:bytes});
 if(response.status!==200)throw Error('Synthetic V3 ingest failed '+response.status+' '+JSON.stringify(await response.json()));
 const receipt=await response.json();const retry=await request(base+'/api/v3/statistics/ingest',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Body-SHA256':createHash('sha256').update(bytes).digest('hex')},body:bytes});
 if(retry.status!==200||JSON.stringify(await retry.json())!==JSON.stringify(receipt))throw Error('Synthetic V3 exact retry mismatch');
 return {node,placement};
}

// Reads numeric diagnostic fields only; never prints raw lines or identities.
import fs from 'node:fs';
export function analyze(text){
  const groups=new Map(),failures=[];let done=null;
  for(const line of text.split(/\r?\n/)){
    const at=line.indexOf('COMPARE_');if(at<0)continue;
    const [kind,...parts]=line.slice(at).trim().split(/\s+/);
    const f=Object.fromEntries(parts.map(p=>p.split('=')));
    if(kind==='COMPARE_DONE'){done={success:+f.success,expected:+f.expected,failed:+f.failed,complete:+f.complete,retained_transport:+f.retained_transport||0,budget_exhausted:+f.budget_exhausted};continue;}
    if(!['COMPARE_HTTP','COMPARE_MQTT_MSG','COMPARE_MQTT_FRESH_TOTAL'].includes(kind))continue;
    if(f.valid!=='1'){failures.push({kind,mode:f.mode,bytes:+f.bytes,sample:+f.sample});continue;}
    if(kind==='COMPARE_HTTP'&&(f.mode==='prime'||f.mode==='warm'&&f.reuse_verified!=='1'))continue;
    if(kind==='COMPARE_MQTT_MSG'&&f.mode==='fresh')continue;
    const key=`${kind==='COMPARE_HTTP'?'https':'mqtt'}/${f.mode??'fresh'}/${f.bytes}`;
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(f);
  }
  const percentile=(a,q)=>a.slice().sort((x,y)=>x-y)[Math.max(0,Math.ceil(a.length*q)-1)];
  const result=[];
  for(const [group,rows]of groups){
    const us=rows.map(r=>+r.elapsed_us),bytes=+rows[0].bytes;
    const mem=rows.filter(r=>r.free_start!==undefined);
    result.push({group,samples:rows.length,median_ms:percentile(us,.5)/1000,p95_ms:percentile(us,.95)/1000,
      payload_goodput_Bps:bytes*rows.length*1e6/us.reduce((a,b)=>a+b,0),
      // SDK combines independent per-heap low-water marks. These are not a
      // simultaneous total-free observation or transport allocation totals.
      minimum_sum_per_heap_low_water_bytes:mem.length?Math.min(...mem.map(r=>+r.free_min)):null,
      maximum_start_minus_sum_per_heap_low_water_bytes:mem.length?Math.max(...mem.map(r=>+r.free_start- +r.free_min)):null,
      minimum_largest_end_bytes:mem.length?Math.min(...mem.map(r=>+r.largest_end)):null});
  }
  return {heap_low_water_semantics:'sum of independent per-heap operation-local low-water marks; not simultaneous total free or transport-owned allocation',done,failures,groups:result};
}
if(process.argv[1]?.endsWith('/analyze.mjs')){
  try{console.log(JSON.stringify(analyze(fs.readFileSync(process.argv[2],'utf8')),null,2));}
  catch{console.error('COMPARE_ANALYSIS_REJECTED');process.exitCode=1;}
}

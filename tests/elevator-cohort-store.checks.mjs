// Dependency-free real-SQLite store checks.
// Run: node --experimental-transform-types tests/elevator-cohort-store.checks.mjs
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && context.parentURL) { const url=new URL(specifier+'.ts',context.parentURL); if (existsSync(url)) return next(url.href,context); } throw error; }
}});
const { setup }=await import('./helpers/ingestion.ts');
const { seedElevatorSeries }=await import('./helpers/elevator.ts');
const { readElevatorEvents }=await import('../worker/elevator-cohort-store.js');
const now=Date.now(); let passes=0;
async function scenario(name,options,check,mutate) {const state=await setup();try{const ids=await seedElevatorSeries(state,now,options);if(mutate)await mutate(state,ids);const result=await readElevatorEvents(state.env.DB,'teaching-elevator',now);await check(result);console.log('PASS',name);passes++;}finally{state.db.close();}}
await scenario('healthy',{},r=>{assert.equal(r.events.length,1);assert.equal(r.status,'observing');assert.equal(r.events[0].lost_identifiers,6);assert.equal(r.events[0].baseline_identifiers,18);assert.ok(!JSON.stringify(r).includes('02:ee:'));});
for(const [name,o] of [['demo',{dataset:'demo'}],['controlled',{dataset:'controlled_test'}],['incomplete',{incompleteWindow:1}],['low_scan',{lowScanWindow:1}],['overflow',{overflowWindow:1}],['no_health',{noStatus:true}],['unknown_clock',{unknownClock:true}],['future_observation',{firstEnd:now+30000}],['future_receive',{futureReceived:true}],['new_boot',{newBootAt:1}],['wrong_place',{place:'library'}]]) await scenario(name,o,r=>assert.equal(r.events.length,0));
await scenario('expired_summaries',{},r=>assert.equal(r.events.length,0),(s,{node})=>s.db.prepare("UPDATE ingestion_items_v2 SET expires_at_ms=? WHERE node_id=? AND stream='address_summaries'").run(now-1,node));
await scenario('closure',{},r=>{assert.equal(r.events.length,0);assert.equal(r.data_until,null);},(s,{node,placement})=>s.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)').run(placement,node,now-100000,new Date(now-100000).toISOString()));
await scenario('loss_increment',{},r=>assert.equal(r.events.length,0),(s,{node})=>s.db.prepare("UPDATE ingestion_items_v2 SET item_json=json_set(item_json,'$.loss_totals.storage_drops',1) WHERE node_id=? AND stream='node_status' AND seq>=2").run(node));
await scenario('stale_capture',{firstEnd:now-600000},r=>assert.equal(r.status,'stale'));
await scenario('same_epoch_clock_mapping_jump',{clockShiftMs:-10000},r=>{assert.equal(r.events.length,0);assert.notEqual(r.data_until,null);});
console.log('Store checks:',passes);

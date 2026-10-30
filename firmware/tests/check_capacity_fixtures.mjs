// Apply the actual strict backend wire validator to literal firmware-produced bytes.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const output = await build({entryPoints:[resolve('worker/device-v2-validation.ts')],bundle:true,
  write:false,format:'esm',platform:'node',target:'es2022'});
const {validateEnvelopeV2}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const directory of process.argv.slice(2)) {
  const files=readdirSync(directory).filter(name=>/^batch-\d+\.json$/.test(name)).sort();
  let summaries=0,windows=0,lastSequence=0,totalBytes=0;const addresses=new Set(),ids=new Set();
  for(const file of files) {
    const path=resolve(directory,file),bytes=readFileSync(path),before=hash(bytes),original=JSON.parse(bytes);
    const parsed=validateEnvelopeV2(original);
    assert.equal(parsed.protocol,'campuspulse/2');assert(parsed.items.length<=128);
    assert(!ids.has(parsed.batch_id));ids.add(parsed.batch_id);totalBytes+=bytes.length;
    if(parsed.stream==='address_summaries') {
      for(const item of parsed.items) {
        assert.equal(item.seq,++lastSequence);assert(!addresses.has(item.address));addresses.add(item.address);
        assert.equal(item.bins.length,12);assert.equal(item.bins.reduce((a,b)=>a+b,0),item.reports);
        assert.equal(item.vehicle_evidence.schema_version,'radar-compact-v1');
        assert.equal(item.vehicle_evidence.parsed_reports+item.vehicle_evidence.malformed_reports,item.reports);
        assert.equal(item.vehicle_evidence.name_brand_mask,2);assert.equal(item.scan_response_reports,3);
        assert.equal(item.reports,item.seq===1?13:12);summaries++;
      }
    } else {
      assert.equal(parsed.stream,'ble_windows');windows+=parsed.items.length;
      const item=parsed.items[0];assert.equal(item.unique_table_capacity,512);
      assert.equal(item.visible_identifiers,512);assert.equal(item.unique_table_overflow,true);
      assert.equal(item.reports_seen,512*12+2);assert.equal(item.aggregation_drops,0);
    }
    // Validation must leave literal journal bytes and parsed wire values intact.
    assert.equal(hash(readFileSync(path)),before);assert.deepEqual(JSON.parse(bytes),original);
  }
  assert.equal(summaries,512);assert.equal(addresses.size,512);assert.equal(windows,1);
  console.log(`Strict backend wire acceptance: ${files.length} frozen bodies / ${totalBytes} bytes / 512 unique summaries + 1 window (${directory.split('/').at(-1)})`);
}

// Synthetic actual-AD C extractor output against the existing compact TS oracle.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const result = await build({ stdin: { contents: `export {classifyCompactVehicleEvidence} from './worker/vehicle-rules.ts';`,
  resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const { classifyCompactVehicleEvidence } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
let count=0;
for(const line of readFileSync(0,'utf8').trim().split('\n')) {
  const fixture=JSON.parse(line), oracle=classifyCompactVehicleEvidence(fixture.evidence);
  // The compact API retains conflicts as an explicit limitation on unknown.
  // The statistics schema has a dedicated category for exactly that condition.
  const category = fixture.tainted ? 4 : oracle.category==='e_bike_related' ? 1 : oracle.category==='car_related' ? 2 :
    oracle.limitations.includes('conflicting_vehicle_categories') && !fixture.evidence.exclusion_mask && !fixture.evidence.malformed_reports ? 5 : 4;
  assert.equal(fixture.category,category,`C/TS candidate classification case ${fixture.case}`);
  ++count;
}
assert.equal(count,54);
console.log(`Actual AD -> C compact extractor -> TS classifier parity passed ${count} cases`);

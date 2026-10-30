// Actual local TypeScript validators only; no route, network, token or storage.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
const result = await build({ stdin: { contents: `
  export {validateV3Envelope,validateV3Feature,validateV3Status,canonicalV3Evidence} from './worker/device-v3-ingest-validation.ts';
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const validator = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const { createHash } = await import('node:crypto');
let features = 0, statuses = 0;
for (const line of readFileSync(0, 'utf8').trim().split('\n')) {
  const fixture = JSON.parse(line), batch = validator.validateV3Envelope(fixture.body);
  const bytes = JSON.stringify(fixture.body);
  if (createHash('sha256').update(bytes).digest('hex') !== fixture.sha256) throw Error('Body digest mismatch');
  if (batch.stream === 'feature_summaries') {
    for (const item of batch.items) {
      const parsed = validator.validateV3Feature(item);
      if (2 + Buffer.byteLength(validator.canonicalV3Evidence(parsed.evidence)) !== fixture.evidence_bytes) throw Error('Evidence byte budget mismatch');
      if (JSON.stringify(parsed).includes('secret') || JSON.stringify(parsed).includes('736563726574')) throw Error('Private address leaked');
      ++features;
    }
  } else {
    for (const item of batch.items) { validator.validateV3Status(item); ++statuses; }
  }
}
if (features !== 9 || statuses !== 1) throw Error('Missing fixture coverage');
console.log(`Actual v3 validators: ${features} feature cases and ${statuses} status case passed`);

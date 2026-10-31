import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const parts = [];
for await (const chunk of process.stdin) parts.push(chunk);
const generated = JSON.parse(Buffer.concat(parts).toString('utf8'));
const directory = process.argv[2];
if (!directory) throw new Error('Temporary fixture directory required');
for (const [key, name] of [['applied', 'applied-ack'], ['failed', 'failed-ack'], ['lease', 'lease']]) {
  const item = generated[key];
  const request = Buffer.from(item.requestBytes);
  if (createHash('sha256').update(request).digest('hex') !== item.body_sha256)
    throw new Error(`Synthetic request hash differs from generator: ${name}`);
  await writeFile(join(directory, `${name}-request.json`), request);
  await writeFile(join(directory, `${name}-receipt.json`), JSON.stringify(item.receipt));
}
console.log('backend synthetic control fixtures generated');

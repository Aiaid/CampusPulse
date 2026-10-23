import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Supply public resource IDs through deployment variables, never credentials.
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!/^[0-9a-f]{32}$/i.test(accountId || '')) throw new Error('Set CLOUDFLARE_ACCOUNT_ID to the target account ID.');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId || '') || /^0+-0+-0+-0+-0+$/.test(databaseId)) {
  throw new Error('Set CLOUDFLARE_D1_DATABASE_ID to a real D1 database UUID.');
}
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
config.account_id = accountId;
config.main = resolve(config.main);
config.assets.directory = resolve(config.assets.directory);
for (const binding of config.d1_databases) {
  binding.database_id = databaseId;
  binding.migrations_dir = resolve(binding.migrations_dir);
}
delete config.$schema;
mkdirSync('.wrangler/deploy', { recursive: true });
writeFileSync('.wrangler/deploy/wrangler.json', `${JSON.stringify(config, null, 2)}\n`);
console.log('Generated Cloudflare deployment configuration in ignored local state.');

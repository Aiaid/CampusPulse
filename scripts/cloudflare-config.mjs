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
// This delivery includes raw ingestion: fail closed before a deployment could
// remove its archive binding. Local metrics-only tests may still omit the binding.
const rawBucket = process.env.CLOUDFLARE_R2_RAW_BUCKET;
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(rawBucket || '')) throw new Error('Set CLOUDFLARE_R2_RAW_BUCKET to the intended private raw bucket.');
config.r2_buckets = [{ binding: 'RAW_BUCKET', bucket_name: rawBucket }];
config.account_id = accountId;
config.main = resolve(config.main);
config.assets.directory = resolve(config.assets.directory);
// WebAuthn trusts deployment configuration, never an arbitrary request Host.
// These are public identifiers; credential material remains in Worker secrets.
const authOrigin = process.env.ADMIN_WEBAUTHN_ORIGIN || process.env.DEPLOYMENT_URL;
if (authOrigin) {
  const origin = new URL(authOrigin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || !['', '/'].includes(origin.pathname))
    throw new Error('Set ADMIN_WEBAUTHN_ORIGIN to the exact HTTPS site origin.');
  const rpId = process.env.ADMIN_WEBAUTHN_RP_ID || origin.hostname;
  if (rpId !== origin.hostname) throw new Error('The administrator Passkey RP ID must match the configured site host.');
  config.vars = { ...config.vars, ADMIN_WEBAUTHN_ORIGIN: origin.origin, ADMIN_WEBAUTHN_RP_ID: rpId };
} else if (process.env.ADMIN_WEBAUTHN_RP_ID) {
  throw new Error('Set the administrator WebAuthn origin with its RP ID.');
}
for (const binding of config.d1_databases) {
  binding.database_id = databaseId;
  binding.migrations_dir = resolve(binding.migrations_dir);
}
delete config.$schema;
mkdirSync('.wrangler/deploy', { recursive: true });
writeFileSync('.wrangler/deploy/wrangler.json', `${JSON.stringify(config, null, 2)}\n`);
console.log('Generated Cloudflare deployment configuration in ignored local state.');

import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
if(!/^[0-9a-f]{32}$/i.test(account??''))throw new Error('Set CLOUDFLARE_ACCOUNT_ID.');
const config=JSON.parse(readFileSync('relay/emqx-cloud/wrangler.jsonc','utf8'));
config.account_id=account;config.main=resolve('relay/emqx-cloud',config.main);delete config.$schema;
mkdirSync('.wrangler/deploy',{recursive:true});
writeFileSync('.wrangler/deploy/mqtt-wrangler.json',JSON.stringify(config,null,2)+'\n');
console.log('Generated MQTT gateway deployment configuration; credential values remain in Worker secrets.');

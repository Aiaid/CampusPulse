// Entirely synthetic; reuse the independently hashed actual TypeScript core.
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const originals=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('generate_small.mjs',import.meta.url))],{encoding:'utf8'}));
const bundle=await build({stdin:{contents:"export {capabilityDigestV3,freezeDeviceConfigV3} from './worker/device-v3-config.ts';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const api=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const cases=[];
for(const original of originals.filter(c=>c.expected==='small')){
 const caps=structuredClone(original.caps);caps.capability_id+='-renewed';
 caps.issued_at='2026-10-30T00:00:55.000Z';caps.expires_at='2026-10-30T02:00:00.000Z';
 const policy=structuredClone(original.next_response.config.policy);
 policy.control.capability_sha256=await api.capabilityDigestV3(caps);
 policy.control.activation.expires_at='2026-10-30T01:30:00.000Z';
 const response={...original.next_response,server_time:'2026-10-30T00:01:01.000Z',config:await api.freezeDeviceConfigV3(policy)};
 cases.push({name:original.name,caps:original.caps,response:original.response,renewal_caps:caps,renewal_response:response});
}
process.stdout.write(JSON.stringify(cases));

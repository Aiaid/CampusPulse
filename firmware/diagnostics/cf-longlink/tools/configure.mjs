// All diagnostics are fixed strings: JSON/URL/IO exceptions may contain secrets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';

export function validate(cfg, now = Date.now()/1000) {
  const allowed = ['httpsOrigin','token','epoch','freshSamples','reuseSamples','wsSamples','reconnectSamples','budgetSeconds'];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || Object.keys(cfg).some(k=>!allowed.includes(k))) throw Error();
  if (typeof cfg.httpsOrigin !== 'string' || typeof cfg.token !== 'string' ||
      !/^[A-Za-z0-9._~+\/-]{16,512}={0,2}$/.test(cfg.token)) throw Error();
  const u = new URL(cfg.httpsOrigin);
  if (u.protocol!=='https:' || u.username || u.password || u.search || u.hash ||
      u.pathname!=='/' || u.port || isIP(u.hostname) || u.hostname.length>253 ||
      !u.hostname.includes('.') || !/^[a-z0-9.-]+$/i.test(u.hostname) ||
      u.hostname.split('.').some(p=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(p)) ||
      /(?:^|\.)(?:localhost|local|invalid|test)$/.test(u.hostname)) throw Error();
  if (!Number.isSafeInteger(cfg.epoch) || Math.abs(now-cfg.epoch)>86400) throw Error();
  const result = {...cfg, httpsOrigin:u.origin};
  for (const [key,def,max] of [['freshSamples',6,6],['reuseSamples',12,12],['wsSamples',12,12],['reconnectSamples',4,4],['budgetSeconds',540,600]]) {
    const value=cfg[key]??def;
    if (!Number.isSafeInteger(value) || value<(key==='budgetSeconds'?300:1) || value>max) throw Error();
    result[key]=value;
  }
  return result;
}

export function generate(input, output) {
  const repo=fs.realpathSync(fileURLToPath(new URL('../../../..',import.meta.url)));
  if (!path.isAbsolute(input) || !path.isAbsolute(output)) throw Error();
  const actual=fs.realpathSync(input), stat=fs.statSync(actual);
  if (actual.startsWith(repo+path.sep) || !stat.isFile() || stat.size>4096 || (stat.mode&0o077)) throw Error();
  // Generated secrets may only enter the ignored diagnostic build tree.
  const build=path.join(repo,'firmware/diagnostics/cf-longlink/build');
  const parent=fs.realpathSync(path.dirname(output));
  if (!(parent===build || parent.startsWith(build+path.sep))) throw Error();
  fs.chmodSync(build,0o700);
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw Error();
  const cfg=validate(JSON.parse(fs.readFileSync(actual,'utf8')));
  const text=['#pragma once',
    `static const char cfg_https_origin[] = ${JSON.stringify(cfg.httpsOrigin)};`,
    `static const char cfg_ws_url[] = ${JSON.stringify(cfg.httpsOrigin.replace(/^https:/,'wss:')+'/ws')};`,
    `static const char cfg_authorization[] = ${JSON.stringify('Bearer '+cfg.token)};`,
    `static const char cfg_ws_headers[] = ${JSON.stringify('Authorization: Bearer '+cfg.token+'\r\n')};`,
    ...Object.entries(cfg).filter(([k])=>!['httpsOrigin','token'].includes(k)).map(([k,v])=>`#define CFG_${k} ${v}LL`),
  ].join('\n')+'\n';
  fs.writeFileSync(output,text,{mode:0o600}); fs.chmodSync(output,0o600);
}
if (process.argv[1]===fileURLToPath(import.meta.url)) {
  try { generate(...process.argv.slice(2)); }
  catch { process.stderr.write('Private link configuration rejected\n'); process.exitCode=1; }
}

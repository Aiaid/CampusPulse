import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isIP} from 'node:net';
import {privateFile} from '../../../../relay/transport-compare/server.mjs';
export function validate(c,now=Date.now()/1000){
  if(!c||typeof c!=='object'||isIP(c.host)!==4||!/^[a-f0-9]{64}$/.test(c.token)||
    ![c.httpsPort,c.mqttPort].every(p=>Number.isInteger(p)&&p>1024&&p<=65535)||c.httpsPort===c.mqttPort||
    !Number.isInteger(c.epoch)||Math.abs(now-c.epoch)>86400)throw Error();
  const result={...c};
  for(const [k,d,min,max] of [['freshSamples',6,1,6],['reuseSamples',10,1,10],['mqttFreshSamples',3,1,3],
    ['mqttWarmSamples',10,1,10],['budgetSeconds',300,60,600],['bleWindowMs',20,20,50],['wifiPs',0,0,1],
    ['mqttDirectPublish',0,0,1],['mqttOutSize',1024,1024,9000],['cpuStats',0,0,1]]){
    const v=c[k]??d;if(!Number.isInteger(v)||v<min||v>max)throw Error();result[k]=v;
  }
  if(![20,50].includes(result.bleWindowMs))throw Error();
  return result;
}
export function generate(input,output){
  const c=validate(JSON.parse(privateFile(input,4096)));
  const ca=privateFile(c.caFile);
  if(!ca.includes('-----BEGIN CERTIFICATE-----')||ca.includes('PRIVATE KEY'))throw Error();
  const build=fileURLToPath(new URL('../build/',import.meta.url));
  const parent=fs.realpathSync(path.dirname(output));
  if(!path.isAbsolute(output)||!(parent===build.slice(0,-1)||parent.startsWith(build))||
      (fs.existsSync(output)&&fs.lstatSync(output).isSymbolicLink()))throw Error();
  fs.chmodSync(build,0o700);
  const values={https_origin:`https://${c.host}:${c.httpsPort}`,mqtt_uri:`mqtts://${c.host}:${c.mqttPort}`,
    authorization:`Bearer ${c.token}`,token:c.token,ca_pem:ca};
  const text=['#pragma once',...Object.entries(values).map(([k,v])=>`static const char cfg_${k}[] = ${JSON.stringify(v)};`),
    ...['epoch','freshSamples','reuseSamples','mqttFreshSamples','mqttWarmSamples','budgetSeconds','bleWindowMs','wifiPs','mqttDirectPublish','mqttOutSize','cpuStats']
      .map(k=>`#define CFG_${k} ${c[k]}LL`)].join('\n')+'\n';
  fs.writeFileSync(output,text,{mode:0o600});fs.chmodSync(output,0o600);
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{generate(...process.argv.slice(2));}catch{console.error('Private comparison configuration rejected');process.exitCode=1;}
}

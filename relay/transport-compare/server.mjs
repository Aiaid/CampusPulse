// Synthetic protocol overhead experiment. No cloud, observations or durable store.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import {constants} from 'node:crypto';
import os from 'node:os';
import { createHash, randomUUID, timingSafeEqual, X509Certificate, createPrivateKey } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { Duplex, Transform } from 'node:stream';

// Validate Remaining Length before giving a packet to the broker's parser.
// At most one 8400-byte packet is retained per connection, including its header.
export class PacketBound extends Transform {
  constructor(){super();this.header=[];this.body=null;this.used=0;}
  _transform(chunk,_encoding,done){
    try{let i=0;while(i<chunk.length){
      if(!this.body){
        const byte=chunk[i++];this.header.push(byte);
        if(this.header.length===1)continue;
        if(this.header.length>5)throw Error();
        if(byte&128){if(this.header.length===5)throw Error();continue;}
        let n=0;for(let j=1;j<this.header.length;j++)n+=(this.header[j]&127)*128**(j-1);
        if(n+this.header.length>8400)throw Error();
        this.body=Buffer.alloc(n+this.header.length);Buffer.from(this.header).copy(this.body);this.used=this.header.length;
      }
      const n=Math.min(this.body.length-this.used,chunk.length-i);
      chunk.copy(this.body,this.used,i,i+n);this.used+=n;i+=n;
      if(this.used===this.body.length){this.push(this.body);this.body=null;this.header=[];this.used=0;}
    }done();}catch{done(Error('packet rejected'));}
  }
}

export function privateFile(name, max=16384) {
  if (!path.isAbsolute(name)) throw Error();
  const actual=fs.realpathSync(name), s=fs.statSync(actual);
  const root=fs.realpathSync(fileURLToPath(new URL('../..',import.meta.url)));
  if (actual.startsWith(root+path.sep)||!s.isFile()||(s.mode&0o077)||s.size>max) throw Error();
  return fs.readFileSync(actual,'utf8');
}
export function payload(bytes,run,seq) {
  const b=Buffer.alloc(bytes);Buffer.from(run,'hex').copy(b);b.writeUInt32BE(seq,16);
  for(let i=20;i<bytes;i++)b[i]=(i*31+seq*17)&255;
  return b;
}
export function receipt(b,connection) {
  if (![1024,8192].includes(b.length)) throw Error();
  const run=b.subarray(0,16).toString('hex'),seq=b.readUInt32BE(16);
  if (!seq||!b.equals(payload(b.length,run,seq))) throw Error();
  return JSON.stringify({protocol:'cp-link-probe/1',kind:'transport_received',run_id:run,seq,
    bytes:b.length,sha256:createHash('sha256').update(b).digest('hex'),connection_id:connection,colo:'LAN'});
}
export function allowedPublish(client,p) {
  return Boolean(client&&p.topic===`probe/${client.id}/data`&&p.qos===1&&!p.retain&&[1024,8192].includes(p.payload.length));
}
export function allowedSubscribe(client,s) {
  return Boolean(client&&s.topic===`probe/${client.id}/ack`&&s.qos===1);
}
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function start(cfg,Aedes) {
  if(isIP(cfg.host)!==4||!Object.values(os.networkInterfaces()).flat().some(i=>i?.address===cfg.host)||
      !/^[a-f0-9]{64}$/.test(cfg.token)||![cfg.httpsPort,cfg.mqttPort].every(p=>Number.isInteger(p)&&p>1024&&p<=65535)||
      cfg.httpsPort===cfg.mqttPort||!Number.isInteger(cfg.budgetSeconds)||cfg.budgetSeconds<30||cfg.budgetSeconds>600)throw Error();
  const key=privateFile(cfg.keyFile),cert=privateFile(cfg.certFile);
  for(const k of [createPrivateKey(key),new X509Certificate(cert).publicKey])
    if(k.asymmetricKeyType!=='ec'||k.asymmetricKeyDetails.namedCurve!=='prime256v1')throw Error();
  const opts={key,cert,minVersion:'TLSv1.2',maxVersion:'TLSv1.2',ciphers:'ECDHE-ECDSA-AES128-GCM-SHA256',
    ecdhCurve:'prime256v1',handshakeTimeout:10000,secureOptions:constants.SSL_OP_NO_TICKET};
  const broker=await Aedes.createBroker({connectTimeout:10000,concurrency:2,queueLimit:2,heartbeatInterval:60000,
    maxClientsIdLength:40,maxInflightInbound:1,maxTopicLevels:4});
  const sockets=new Set(); let accepted=0,rejected=0,verified=0;const ids=new WeakMap();
  function track(s) {
    accepted++;
    if(sockets.size>=4||accepted>128){rejected++;s.destroy();return;}
    // Match HTTP's current default on both listeners. Otherwise MQTT's small
    // PUBACK followed by its application receipt can wait for delayed ACKs.
    sockets.add(s);s.setNoDelay(true);s.setTimeout(15000,()=>s.destroy());s.on('close',()=>sockets.delete(s));
  }
  function id(s){if(!ids.has(s))ids.set(s,randomUUID());return ids.get(s);}
  broker.authenticate=(c,u,p,cb)=>cb(null,/^bench-[a-f0-9]{32}$/.test(c.id)&&u==='probe'&&equal(p?.toString(),cfg.token));
  broker.authorizePublish=(c,p,cb)=>cb(allowedPublish(c,p)?null:Error('rejected'));
  broker.authorizeSubscribe=(c,s,cb)=>cb(null,allowedSubscribe(c,s)?s:null);
  broker.on('publish',(p,c)=>{
    if(!c)return;
    try { const body=receipt(p.payload,id(c.conn)); verified++;
      broker.publish({cmd:'publish',topic:`probe/${c.id}/ack`,payload:Buffer.from(body),qos:1,retain:false},()=>{});
    }catch{rejected++;c.close();}
  });
  // Never print library errors: they can contain client IDs or network strings.
  broker.on('clientError',()=>{rejected++;});broker.on('connectionError',()=>{rejected++;});
  const web=https.createServer(opts,(req,res)=>{
    if(req.method!=='POST'||req.url!=='/benchmark'||!equal(req.headers.authorization,'Bearer '+cfg.token)||
       !['1024','8192'].includes(req.headers['content-length'])||req.headers['transfer-encoding']){
      rejected++;res.writeHead(400,{'Connection':'close'}).end();return;
    }
    const parts=[];let bytes=0;
    req.on('data',b=>{bytes+=b.length;if(bytes>8192)req.destroy();else parts.push(b);});
    req.on('end',()=>{try{
      const body=receipt(Buffer.concat(parts),id(req.socket));verified++;
      res.writeHead(200,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'}).end(body);
    }catch{rejected++;res.writeHead(400,{'Connection':'close'}).end();}});
    req.on('error',()=>{rejected++;});
  });
  web.maxRequestsPerSocket=32;web.maxConnections=4;web.requestTimeout=12000;web.headersTimeout=10000;web.keepAliveTimeout=15000;
  web.on('connection',track);web.on('clientError',(_e,s)=>{rejected++;s.destroy();});
  web.on('secureConnection',s=>s.setNoDelay(true));
  const mq=tls.createServer(opts,s=>{
    s.setNoDelay(true);
    const bound=new PacketBound();bound.on('error',()=>{rejected++;s.destroy();});
    const stream=Duplex.from({readable:s.pipe(bound),writable:s});
    stream.on('error',()=>s.destroy());s.on('close',()=>stream.destroy());broker.handle(stream);
  });mq.maxConnections=4;mq.on('connection',track);mq.on('tlsClientError',()=>{rejected++;});
  for(const s of [web,mq])s.on('resumeSession',(_id,callback)=>callback(null,null));
  for(const s of [web,mq])s.on('error',()=>{});
  const listening=await Promise.allSettled([[web,cfg.httpsPort],[mq,cfg.mqttPort]].map(([s,p])=>new Promise((resolve,reject)=>{
    s.once('error',reject);s.listen(p,cfg.host,()=>{s.removeListener('error',reject);resolve();});
  })));
  if(listening.some(r=>r.status==='rejected')){
    for(const s of sockets)s.destroy();
    await Promise.all([web,mq].filter(s=>s.listening).map(s=>new Promise(r=>s.close(r))));
    await new Promise(r=>broker.close(r));throw Error();
  }
  let closed=false;
  const close=async()=>{if(closed)return;closed=true;clearTimeout(timer);for(const s of sockets)s.destroy();
    await Promise.all([web,mq].map(s=>new Promise(r=>s.close(r))));await new Promise(r=>broker.close(r));
    console.log(`COMPARE_SERVER_DONE accepted=${accepted} rejected=${rejected} verified=${verified}`);};
  const timer=setTimeout(()=>void close(),cfg.budgetSeconds*1000);
  console.log('COMPARE_SERVER_READY tls=12 max_payload=8192 max_connections=4');
  return {close,web,mq};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{const cfg=JSON.parse(privateFile(process.argv[2],4096));
    const {Aedes}=await import(pathToFileURL(cfg.aedesModule).href);const server=await start(cfg,Aedes);
    process.once('SIGINT',()=>void server.close());process.once('SIGTERM',()=>void server.close());
  }catch{console.error('COMPARE_SERVER_REJECTED');process.exitCode=1;}
}

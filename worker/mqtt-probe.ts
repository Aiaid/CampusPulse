import { MQTT_BROKER_HOST, type MqttCredentials } from './mqtt-credentials';

interface ProbeSocket {
 readable: ReadableStream<Uint8Array>;
 writable: WritableStream<Uint8Array>;
 opened: Promise<unknown>;
 close(): Promise<void>;
}
export class MqttProbeError extends Error {
 constructor(public code:string) { super(code); }
}
const fail=(code:string):never=>{throw new MqttProbeError(code);};
const join=(...parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
const text=(s:string)=>{const b=new TextEncoder().encode(s);return join(Uint8Array.of(b.length>>8,b.length&255),b);};
const variable=(n:number)=>{const a=[];do{let b=n%128;n=Math.floor(n/128);if(n)b|=128;a.push(b);}while(n);return Uint8Array.from(a);};
const packet=(header:number,body:Uint8Array)=>join(Uint8Array.of(header),variable(body.length),body);
/** Bounded MQTT5 login, own reply subscription and negative ACL checks. The
 * allowed publish uses an intentionally unsupported operation, so it cannot
 * create contact/ingestion evidence even if a broker rule forwards it. */
export async function verifyMqttSocket(credentials:MqttCredentials,open:()=>ProbeSocket,timeoutMs=12000):Promise<void> {
 let socket:ProbeSocket|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,writer:WritableStreamDefaultWriter<Uint8Array>|undefined;
 let timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new MqttProbeError('mqtt_probe_timeout')),timeoutMs);});
 const until=<T>(p:Promise<T>)=>Promise.race([p,timeout]);
 let buffer=new Uint8Array(0),total=0;
 try {
  socket=open();await until(socket.opened);reader=socket.readable.getReader();writer=socket.writable.getWriter();
  const read=async()=>{
   for(;;){
    if(buffer.length>=2){let value=0,multiplier=1,at=1,b=0;do{
      if(at>=buffer.length)break;b=buffer[at++];value+=(b&127)*multiplier;multiplier*=128;
      if(at>5||value>4096)fail('mqtt_probe_protocol');
     }while(b&128);
     if(!(b&128)&&at<=buffer.length&&buffer.length>=at+value){const result={header:buffer[0],body:buffer.slice(at,at+value)};buffer=buffer.slice(at+value);return result;}
    }
    const chunk=await until(reader!.read());if(chunk.done||!chunk.value)fail('mqtt_probe_closed');
    const value=chunk.value!;total+=value.length;if(total>16384)fail('mqtt_probe_protocol');buffer=join(buffer,value);
   }
  };
  const send=async(header:number,body:Uint8Array)=>until(writer!.write(packet(header,body)));
  const boot=crypto.randomUUID(),prefix=`cp/v1/${credentials.namespace}/${boot}`;
  await send(0x10,join(text('MQTT'),Uint8Array.of(5,0xc2,0,15,0),text(`cpverify-${boot.slice(0,12)}`),text(credentials.username),text(credentials.password)));
  const conn=await read();if(conn.header!==0x20||conn.body.length<3||conn.body[0]!==0||conn.body[1]!==0)fail('mqtt_probe_login_rejected');
  // MQTT5 SUBACK has packet id, property length, then one reason per topic.
  const sub=async(id:number,topic:string,allowed:boolean)=>{
   await send(0x82,join(Uint8Array.of(0,id,0),text(topic),Uint8Array.of(1)));
   const reply=await read();
   if(reply.header!==0x90||reply.body.length!==4||reply.body[0]!==0||reply.body[1]!==id||reply.body[2]!==0)fail('mqtt_probe_protocol');
   if(allowed ? reply.body[3]>1 : reply.body[3]!==0x87)fail(allowed?'mqtt_probe_reply_subscribe_rejected':'mqtt_probe_acl_not_isolated');
  };
  await sub(1,`${prefix}/rep/+/+`,true);
  const other=`cp/v1/${credentials.namespace==='cp-denied'?'cp-other':'cp-denied'}/${boot}`;
  await sub(2,`${other}/rep/+/+`,false);
  await sub(3,`${prefix}/req/#`,false);
  const publish=async(id:number,topic:string,allowed:boolean)=>{
   await send(0x32,join(text(topic),Uint8Array.of(0,id,0),new TextEncoder().encode('{}')));
   const reply=await read();
   if(reply.header!==0x40||reply.body.length<2||reply.body[0]!==0||reply.body[1]!==id)fail('mqtt_probe_protocol');
   const reason=reply.body.length===2?0:reply.body[2];
   if(allowed ? reason>0x10 : reason!==0x87)fail(allowed?'mqtt_probe_request_publish_rejected':'mqtt_probe_acl_not_isolated');
  };
  await publish(4,`${prefix}/req/verify/1`,true);
  await publish(5,`${other}/req/verify/1`,false);
  await publish(6,`${prefix}/rep/verify/1`,false);
  await send(0xe0,new Uint8Array());
 } catch(error) { if(error instanceof MqttProbeError)throw error;throw new MqttProbeError('mqtt_probe_connection_failed'); }
 finally {
  if(timer)clearTimeout(timer);
  // Closing the socket settles outstanding reads/writes; never await an
  // unbounded peer-controlled cleanup after the deadline.
  if(socket)void socket.close().catch(()=>{});
  if(reader)void reader.cancel().catch(()=>{});
  if(writer)void writer.abort().catch(()=>{});
 }
}
export async function verifyMqttBroker(credentials:MqttCredentials):Promise<void> {
 const {connect}=await import('cloudflare:sockets');
 await verifyMqttSocket(credentials,()=>connect({hostname:MQTT_BROKER_HOST,port:8883},{secureTransport:'on',allowHalfOpen:false}));
}

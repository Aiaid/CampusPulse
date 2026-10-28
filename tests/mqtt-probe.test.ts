import { expect,it } from 'vitest';
import { verifyMqttSocket } from '../worker/mqtt-probe';
import { MQTT_BROKER_URI } from '../worker/mqtt-credentials';
const credentials={uri:MQTT_BROKER_URI,username:'synthetic',namespace:'synthetic',password:'synthetic-test-password'};
function socketFixture(options:{badLogin?:boolean;unsafeSubscribe?:boolean;unsafePublish?:boolean;denyOwnReply?:boolean;neverReply?:boolean;malformed?:boolean}={}) {
 let controller!:ReadableStreamDefaultController<Uint8Array>,closed=0;
 const operations:{header:number;topic?:string}[]=[];
 const readable=new ReadableStream<Uint8Array>({start(c){controller=c;}});
 const reply=(header:number,body:number[])=>controller.enqueue(Uint8Array.of(header,body.length,...body));
 const writable=new WritableStream<Uint8Array>({write(bytes){
  let at=1;while(bytes[at++]&128){}const body=bytes.slice(at),header=bytes[0];
  operations.push({header});if(options.neverReply)return;
  if(options.malformed){controller.enqueue(Uint8Array.of(0x20,255,255,255,255,127));return;}
  if(header===0x10)reply(0x20,[0,options.badLogin?0x86:0,0]);
  if(header===0x82){const id=body[1];const topic=new TextDecoder().decode(body.slice(5,-1));operations.at(-1)!.topic=topic;
   reply(0x90,[0,id,0,id===1?(options.denyOwnReply?0x87:1):(options.unsafeSubscribe?1:0x87)]);}
  if(header===0x32){const length=(body[0]<<8)|body[1],id=body[3+length];operations.at(-1)!.topic=new TextDecoder().decode(body.slice(2,2+length));reply(0x40,[0,id,id===4||options.unsafePublish?0:0x87,0]);}
 },abort(){}});
 return {socket:{readable,writable,opened:Promise.resolve(),close:async()=>{closed++;}},operations,get closed(){return closed;}};
}
it('verifies MQTT5 login, firmware reply filter and denied cross-namespace permissions without synthetic ingest',async()=>{
 const state=socketFixture();await verifyMqttSocket(credentials,()=>state.socket);
 expect(state.operations.map(o=>o.header)).toEqual([0x10,0x82,0x82,0x82,0x32,0x32,0x32,0xe0]);
 const topics=state.operations.flatMap(o=>o.topic?[o.topic]:[]);
 expect(topics[0]).toMatch(/^cp\/v1\/synthetic\/[0-9a-f-]+\/rep\/\+\/\+$/);expect(topics[3]).toMatch(/\/req\/verify\/1$/);expect(topics.every(t=>!t.includes('ingest'))).toBe(true);expect(state.closed).toBe(1);
});
it('fails closed for login rejection, reply denial, or permissive broker ACLs',async()=>{
 for(const [options,code] of [
  [{badLogin:true},'mqtt_probe_login_rejected'],[{denyOwnReply:true},'mqtt_probe_reply_subscribe_rejected'],
  [{unsafeSubscribe:true},'mqtt_probe_acl_not_isolated'],[{unsafePublish:true},'mqtt_probe_acl_not_isolated'],
  [{malformed:true},'mqtt_probe_protocol'],
 ] as const){const state=socketFixture(options);await expect(verifyMqttSocket(credentials,()=>state.socket)).rejects.toMatchObject({code});expect(state.closed).toBe(1);}
});
it('bounds a silent broker deadline and closes the socket',async()=>{
 const state=socketFixture({neverReply:true});await expect(verifyMqttSocket(credentials,()=>state.socket,15)).rejects.toMatchObject({code:'mqtt_probe_timeout'});expect(state.closed).toBe(1);
});

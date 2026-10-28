import {WorkerEntrypoint} from 'cloudflare:workers';
// Synthetic named entrypoint for actual workerd RPC serialization tests only.
export class MqttDeviceApi extends WorkerEntrypoint {
  async authorize({username,namespace}) {
    return username==='synthetic_user'&&namespace==='synthetic_mqtt'?{node_id:'registered_factory_node'}:null;
  }
  async dispatch(input) {
    if(!await this.authorize(input))return {status:403,body:new TextEncoder().encode('{"error":"unauthorized"}')};
    const paths={config:'/api/v2/device/config',contact:'/api/v2/device/contact',activation:'/api/v2/device/config/ack',ingest:'/api/v2/ingest'};
    const response=await this.env.UPSTREAM.fetch(new Request('https://pulse.anend.net'+paths[input.op],{
      method:input.op==='config'?'GET':'POST',body:input.op==='config'?undefined:input.body,
    }));
    return {status:response.status,body:new Uint8Array(await response.arrayBuffer())};
  }
}
export default {fetch:()=>new Response(null,{status:404})};

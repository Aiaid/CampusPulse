import {WorkerEntrypoint} from 'cloudflare:workers';
// Synthetic named entrypoint for actual workerd RPC serialization tests only.
export class MqttDeviceApi extends WorkerEntrypoint {
  async authorize({username,namespace}) {
    return username==='synthetic_user'&&namespace==='synthetic_mqtt'?{node_id:'registered_factory_node'}:null;
  }
  async dispatch(input) {
    if(!await this.authorize(input))return {status:403,body:new TextEncoder().encode('{"error":"unauthorized"}')};
    const paths={config:'/api/v2/device/config',contact:'/api/v2/device/contact',activation:'/api/v2/device/config/ack',ingest:'/api/v2/ingest'};
    const v3paths={1:'/api/v3/device/capabilities',2:'/api/v3/device/config',3:'/api/v3/device/config/ack',
      4:'/api/v3/device/lease',5:'/api/v3/ingest/statistics'};
    const config=input.v3?input.v3.subop===2:input.op==='config';
    const response=await this.env.UPSTREAM.fetch(new Request('https://pulse.anend.net'+(input.v3?v3paths[input.v3.subop]:paths[input.op]),{
      method:config?'GET':'POST',body:config?undefined:input.body,
      headers:input.v3?{'X-Synthetic-Receipt-Only':String(input.v3.receiptOnly)}:{},
    }));
    return {status:response.status,body:new Uint8Array(await response.arrayBuffer())};
  }
}
export default {fetch:()=>new Response(null,{status:404})};

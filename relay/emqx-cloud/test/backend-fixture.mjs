import {WorkerEntrypoint} from 'cloudflare:workers';
// Synthetic named entrypoint for actual workerd RPC serialization tests only.
export class MqttDeviceApi extends WorkerEntrypoint {
  async authorize({username,namespace}) {
    return username==='synthetic_user'&&namespace==='synthetic_mqtt'?{node_id:'registered_factory_node'}:null;
  }
  async dispatch(input) {
    if(!await this.authorize(input))return {status:403,body:new TextEncoder().encode('{"error":"unauthorized"}')};
    const v3paths={1:'/api/v3/device/capabilities',2:'/api/v3/device/config',3:'/api/v3/device/config/ack',
      4:'/api/v3/device/lease',5:'/api/v3/statistics/ingest'};
    if (!input.v3 || input.op !== 'ingest') return {status:400,body:new TextEncoder().encode('{}')};
    const config=input.v3.subop===2;
    const response=await this.env.UPSTREAM.fetch(new Request('https://pulse.anend.net'+v3paths[input.v3.subop],{
      method:config?'GET':'POST',body:config?undefined:input.body,
      headers:input.v3?{'X-Synthetic-Receipt-Only':String(input.v3.receiptOnly)}:{},
    }));
    return {status:response.status,body:new Uint8Array(await response.arrayBuffer())};
  }
}
export default {fetch:()=>new Response(null,{status:404})};

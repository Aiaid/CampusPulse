// Test-only actual service-binding target; production exports the same class.
export {MqttDeviceApi} from '../../worker/mqtt-entrypoint';
import {handleDeviceV3Control} from '../../worker/device-v3-control';
import {handleDeviceV3Statistics,type DeviceV3StatisticsEnv} from '../../worker/device-v3-statistics';
export default {async fetch(request:Request,env:DeviceV3StatisticsEnv){
 return await handleDeviceV3Control(request,env)??await handleDeviceV3Statistics(request,env)??new Response('Not found',{status:404});
}};

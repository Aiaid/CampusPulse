import { handleDeviceV3Control, type DeviceV3ControlEnv } from '../../worker/device-v3-control';
import { handleDeviceV3Clock } from '../../worker/device-v3-clock';
export default {
  async fetch(request: Request, env: DeviceV3ControlEnv) {
    return await handleDeviceV3Clock(request, env) ?? await handleDeviceV3Control(request, env) ?? new Response('Not found', { status: 404 });
  },
};

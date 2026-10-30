import { handleDeviceV3Control, type DeviceV3ControlEnv } from '../../worker/device-v3-control';
export default {
  async fetch(request: Request, env: DeviceV3ControlEnv) {
    return await handleDeviceV3Control(request, env) ?? new Response('Not found', { status: 404 });
  },
};

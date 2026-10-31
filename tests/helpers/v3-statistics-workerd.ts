import { handleDeviceV3Statistics, expireDeviceV3Statistics, type DeviceV3StatisticsEnv } from '../../worker/device-v3-statistics';
export default {
  async fetch(request: Request, env: DeviceV3StatisticsEnv) {
    if (new URL(request.url).pathname === '/__synthetic_cleanup') {
      const body = await request.json() as { now: number };
      return Response.json(await expireDeviceV3Statistics({ ...env, DEVICE_V3_STATISTICS_ENABLED: 'false' }, body.now));
    }
    return await handleDeviceV3Statistics(request, env) ?? new Response('Not found', { status: 404 });
  },
};

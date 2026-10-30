// Synthetic local harness only. Never deploy this cleanup endpoint.
import { handleDeviceV3Ingest, expireDeviceV3Ingest, type DeviceV3IngestEnv } from '../../worker/device-v3-ingest';
import { handleDeviceV3Control } from '../../worker/device-v3-control';
export default {
  async fetch(request: Request, env: DeviceV3IngestEnv) {
    if (new URL(request.url).pathname === '/__synthetic_cleanup') {
      const body = await request.json() as { now: number };
      await expireDeviceV3Ingest({ ...env, DEVICE_V3_INGEST_ENABLED: undefined }, body.now);
      return Response.json({ cleaned: true });
    }
    return await handleDeviceV3Ingest(request, env) ?? await handleDeviceV3Control(request, env) ?? new Response('Not found', { status: 404 });
  },
};

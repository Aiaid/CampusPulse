// Local integration entrypoint only: never reference from deployment config.
import { handleDeviceV3Control } from '../../worker/device-v3-control';
import { handleDeviceV3Ingest, expireDeviceV3Ingest } from '../../worker/device-v3-ingest';
import { handleCprawArchive, expireCprawArchives } from '../../worker/cpraw-archive';
import type { DeviceV3IngestEnv } from '../../worker/device-v3-ingest-validation';

export default {
  async fetch(request: Request, env: DeviceV3IngestEnv): Promise<Response> {
    const draining = !!await env.DB.prepare("SELECT 1 FROM v3_integration_state WHERE id='draining'").first();
    if (new URL(request.url).pathname === '/health' && request.method === 'GET') {
      const ready = await env.DB.prepare("SELECT 1 FROM v3_integration_state WHERE id='ready'").first();
      return Response.json({ ready: !!ready && !draining, draining, isolation: 'synthetic-controlled-test' }, {
        status: ready && !draining ? 200 : 503, headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (draining) return Response.json({ error: { code: 'integration_draining', retryable: false } }, { status: 503 });
    return await handleDeviceV3Control(request, env) ?? await handleDeviceV3Ingest(request, env) ??
      await handleCprawArchive(request, env) ?? new Response('Not found', { status: 404 });
  },
  async scheduled(_controller: ScheduledController, env: DeviceV3IngestEnv): Promise<void> {
    // Always use the actual clock. No trigger-supplied future time may expire data.
    const now = Date.now();
    const report: Record<string, unknown> = { checked_at_ms: now, status: 'ok' };
    try { report.v3 = await expireDeviceV3Ingest(env, now); }
    catch { report.v3 = { error: 'v3_retention_failed' }; report.status = 'failed'; }
    try { report.cpraw_reconciled = await expireCprawArchives(env, now); }
    catch { report.cpraw_error = 'cpraw_retention_failed'; report.status = 'failed'; }
    await env.DB.prepare('INSERT INTO v3_integration_maintenance(id,report_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET report_json=excluded.report_json')
      .bind(JSON.stringify(report)).run();
  },
};

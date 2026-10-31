// Local integration entrypoint only: never reference from deployment config.
import { handleDeviceV3Control } from '../../worker/device-v3-control';
import { handleDeviceV3Ingest, expireDeviceV3Ingest } from '../../worker/device-v3-ingest';
import { handleCprawArchive, expireCprawArchives } from '../../worker/cpraw-archive';
import { handleDeviceV3Statistics, expireDeviceV3Statistics, type DeviceV3StatisticsEnv } from '../../worker/device-v3-statistics';
import { cleanupStatisticsLeaseSpans } from '../../worker/device-v3-statistics-policy';
import { handlePublicStatistics } from '../../worker/statistics-public';

const DIAGNOSTIC_CODES = new Set(['v3_statistics_authority_missing', 'v3_statistics_capture_unauthorized',
  'v3_statistics_window_conflict', 'v3_statistics_batch_conflict', 'v3_statistics_conflict',
  'invalid_v3_statistics', 'v3_statistics_time_unprovable']);

export default {
  async fetch(request: Request, env: DeviceV3StatisticsEnv): Promise<Response> {
    const draining = !!await env.DB.prepare("SELECT 1 FROM v3_integration_state WHERE id='draining'").first();
    if (new URL(request.url).pathname === '/health' && request.method === 'GET') {
      const ready = await env.DB.prepare("SELECT 1 FROM v3_integration_state WHERE id='ready'").first();
      return Response.json({ ready: !!ready && !draining, draining, isolation: 'synthetic-controlled-test' }, {
        status: ready && !draining ? 200 : 503, headers: { 'Cache-Control': 'no-store' },
      });
    }
    if (draining) return Response.json({ error: { code: 'integration_draining', retryable: false } }, { status: 503 });
    const response = await handleDeviceV3Control(request, env) ?? await handleDeviceV3Statistics(request, env) ??
      await handlePublicStatistics(request, env) ?? await handleDeviceV3Ingest(request, env) ??
      await handleCprawArchive(request, env) ?? new Response('Not found', { status: 404 });
    if (new URL(request.url).pathname === '/api/v3/statistics/ingest' && response.status >= 400) {
      try {
        const value = await response.clone().json() as { error?: { code?: unknown } };
        const code = value.error?.code;
        if (typeof code === 'string' && DIAGNOSTIC_CODES.has(code)) await env.DB.prepare(`
          INSERT INTO v3_integration_rejections(code,status,count,last_at_ms) VALUES(?,?,1,?)
          ON CONFLICT(code) DO UPDATE SET count=MIN(count+1,1000000),last_at_ms=excluded.last_at_ms`)
          .bind(code, response.status, Date.now()).run();
      } catch { /* Diagnostics must not replace the original ingest response. */ }
    }
    return response;
  },
  async scheduled(_controller: ScheduledController, env: DeviceV3StatisticsEnv): Promise<void> {
    // Always use the actual clock. No trigger-supplied future time may expire data.
    const now = Date.now();
    const report: Record<string, unknown> = { checked_at_ms: now, status: 'ok' };
    try { report.statistics = await expireDeviceV3Statistics(env, now); }
    catch { report.statistics = { error: 'statistics_retention_failed' }; report.status = 'failed'; }
    try { await cleanupStatisticsLeaseSpans(env); report.statistics_leases = { status: 'ok' }; }
    catch { report.statistics_leases = { error: 'statistics_lease_cleanup_failed' }; report.status = 'failed'; }
    try { report.v3 = await expireDeviceV3Ingest(env, now); }
    catch { report.v3 = { error: 'v3_retention_failed' }; report.status = 'failed'; }
    try { report.cpraw_reconciled = await expireCprawArchives(env, now); }
    catch { report.cpraw_error = 'cpraw_retention_failed'; report.status = 'failed'; }
    await env.DB.prepare('INSERT INTO v3_integration_maintenance(id,report_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET report_json=excluded.report_json')
      .bind(JSON.stringify(report)).run();
  },
};

// Local-only instrumentation. This file is never the deployment entrypoint.
import gateway, { MqttSession as GatewaySession } from '../src/worker';
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__test/inspect') return Response.json(await env.MQTT_SESSIONS.getByName('test-node').inspectAttachments());
    if (url.pathname === '/__test/interrupt') {
      await env.MQTT_SESSIONS.getByName('test-node').markInterrupted(url.searchParams.has('partial')); return new Response('OK');
    }
    if (url.pathname === '/__test/rate') {
      await env.MQTT_SESSIONS.getByName('test-node').markRateLimit(); return new Response('OK');
    }
    return gateway.fetch(request, env);
  },
};
export class MqttSession extends GatewaySession {
  inspectAttachments(): unknown[] { return this.ctx.getWebSockets().map(s => s.deserializeAttachment()); }
  markInterrupted(partial = false): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      socket.serializeAttachment({ ...attachment, [partial ? 'partial' : 'pending']: true });
    }
  }
  markRateLimit(): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      socket.serializeAttachment({ ...attachment, frames: 4095 });
    }
  }
}

import { connect } from 'cloudflare:sockets';
import { DurableObject } from 'cloudflare:workers';
import { handleWebhook, handleBrokerEvent } from './handler.mjs';
import { publishMqttReply } from './mqtt-publish.mjs';
import { RpcGuard, RpcGuardError } from './rpc-guard.mjs';

/** @satisfies {ExportedHandler<Env>} */
export default {
  async fetch(request, env) {
    return handleWebhook(request, env, undefined, async (node, bytes) =>
      env.RPC_GUARDS.getByName(node, {locationHint: 'apac'}).deliver(bytes));
  },
};

export class EmqxRpc extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.guard = new RpcGuard(this.ctx.storage);
    this.busy = false;
  }

  async deliver(bytes) {
    // Reserve synchronously before any await, including storage work. A process
    // restart clears this transient reservation; the durable hash permits retry.
    if (this.busy) return 503;
    this.busy = true;
    try {
      return await handleBrokerEvent(bytes, this.env,
        options => publishMqttReply({connect, ...options}), async rpc => {
          try { await this.guard.begin(rpc); }
          catch (error) { return error instanceof RpcGuardError ? error.status : 503; }
        });
    } finally { this.busy = false; }
  }
}

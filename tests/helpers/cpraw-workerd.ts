// Isolated Miniflare entrypoint. This file is never the deployed Worker entrypoint.
import { handleCprawArchive, expireCprawArchives } from '../../worker/cpraw-archive';
import type { Env } from '../../worker/types';
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === '/__synthetic_cleanup') {
      return Response.json({ reconciled: await expireCprawArchives(env, Date.now() + 3_600_001) });
    }
    return await handleCprawArchive(request, env) ?? new Response('Not found', { status: 404 });
  },
};

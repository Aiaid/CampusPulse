import { handleAdmin } from '../../worker/admin';
import type { Env } from '../../worker/types';
export default { async fetch(request: Request, env: Env) {
  return await handleAdmin(request, env) ?? new Response('Not found', { status: 404 });
} };

// Unexpected admin failures need a traceable reference without exposing SQL,
// credentials, identifiers, request bodies, or arbitrary runtime error text.
const fixedRoutes = new Set([
  '/session', '/auth/status', '/auth/setup', '/auth/reauth', '/account', '/account/password',
  '/passkeys', '/passkeys/authentication/options', '/passkeys/authentication/verify',
  '/passkeys/registration/options', '/passkeys/registration/verify',
  '/overview', '/devices', '/places', '/configs', '/settings', '/audit', '/mqtt/pool',
]);
const resourceRoutes: [RegExp, string][] = [
  [/^\/devices\/[a-z0-9_-]{1,64}$/, '/devices/:id'],
  [/^\/devices\/[a-z0-9_-]{1,64}\/mqtt$/, '/devices/:id/mqtt'],
  [/^\/devices\/[a-z0-9_-]{1,64}\/rotate-credential$/, '/devices/:id/rotate-credential'],
  [/^\/devices\/[a-z0-9_-]{1,64}\/placements$/, '/devices/:id/placements'],
  [/^\/devices\/[a-z0-9_-]{1,64}\/batches$/, '/devices/:id/batches'],
  [/^\/places\/[a-z0-9_-]{1,64}$/, '/places/:id'],
  [/^\/configs\/[a-z0-9_-]{1,64}$/, '/configs/:id'],
  [/^\/configs\/[a-z0-9_-]{1,64}\/validate$/, '/configs/:id/validate'],
  [/^\/configs\/[a-z0-9_-]{1,64}\/publish$/, '/configs/:id/publish'],
  [/^\/mqtt\/pool\/[0-9a-f-]{36}\/verify$/, '/mqtt/pool/:id/verify'],
];
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function category(error: unknown): string {
  const messages: string[] = [];
  let cryptoFailure = false;
  for (let current = error, depth = 0; current instanceof Error && depth < 4; current = current.cause, depth++) {
    // Inspect only a bounded amount in memory. Never emit these strings.
    if (typeof current.message === 'string') messages.push(current.message.slice(0, 4096));
    cryptoFailure ||= ['OperationError', 'DataError', 'NotSupportedError'].includes(current.name);
  }
  const message = messages.join(' ');
  if (/no such (?:table|column)|has no column named|database schema|SQLITE_SCHEMA/i.test(message)) return 'storage_schema';
  if (/(?:D1|SQLITE|database|storage|disk)/i.test(message)) {
    if (/timeout|timed out|time limit|SQLITE_BUSY|database is locked/i.test(message)) return 'storage_timeout';
    if (/quota|capacity|disk is full|database or disk is full|SQLITE_FULL|exceed.{0,80}(?:limit|size)|limit.{0,80}exceed|too many (?:SQL|bind|variables|requests|queries)/i.test(message)) return 'storage_capacity';
    return 'storage_unavailable';
  }
  return cryptoFailure ? 'crypto_unavailable' : 'unknown';
}

export function reportAdminFailure(request: Request, error: unknown): string {
  const route = new URL(request.url).pathname.slice('/api/v1/admin'.length);
  const operation = fixedRoutes.has(route) ? route : resourceRoutes.find(([pattern]) => pattern.test(route))?.[1] ?? 'other';
  const requestId = crypto.randomUUID();
  console.error(JSON.stringify({
    event: 'admin_request_failed', request_id: requestId,
    operation, method: methods.has(request.method) ? request.method : 'OTHER', category: category(error),
  }));
  return requestId;
}

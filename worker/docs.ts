import { createOpenApiDocument } from './openapi';

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CampusPulse API · 文档</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/vendor/swagger-ui/swagger-ui.css">
  <script defer src="/vendor/swagger-ui/swagger-ui-bundle.js"></script>
  <script defer src="/docs/swagger-init.js"></script>
</head>
<body>
  <header class="swagger-ui wrapper">
    <h1>CampusPulse API 文档</h1>
    <p><a href="/">返回校园地图</a> · <a href="/openapi.json">下载 OpenAPI JSON</a></p>
    <p>读取接口公开；新增和撤销人工记录需要共享操作员凭据。Authorize 中只输入 token，不加 Bearer 前缀。凭据仅保留在当前页面内存中，刷新后清除。</p>
    <p>本页连接当前站点。执行 POST / DELETE 会写入或撤销真实记录；请求示例是合成数据，请替换为实际观察后提交。目前没有用户登录、个人权限或 BLE 上传接口。</p>
  </header>
  <main id="swagger-ui" aria-label="交互式 API 文档"></main>
  <noscript>请启用 JavaScript，或直接下载上方 OpenAPI JSON 查看接口描述。</noscript>
</body>
</html>`;

const initializer = `window.ui = SwaggerUIBundle({
  url: '/openapi.json',
  dom_id: '#swagger-ui',
  deepLinking: true,
  displayRequestDuration: true,
  filter: true,
  validatorUrl: 'none',
  persistAuthorization: false,
  queryConfigEnabled: false,
  withCredentials: false,
  supportedSubmitMethods: ['get', 'post', 'delete'],
  requestInterceptor: function (request) {
    const target = new URL(request.url, window.location.origin);
    if (target.origin !== window.location.origin ||
        !(target.pathname === '/openapi.json' || target.pathname.startsWith('/api/v1/'))) {
      throw new Error('Documentation requests must stay on this site and its API.');
    }
    return request;
  }
});`;

/** Documentation is public and never reads database bindings or credentials. */
export function handleDocs(request: Request): Response | null {
  const path = new URL(request.url).pathname;
  if (path !== '/openapi.json' && path !== '/docs' && !path.startsWith('/docs/')) return null;
  const known = ['/docs', '/docs/', '/openapi.json', '/docs/swagger-init.js'].includes(path);
  if (!known) return new Response('Documentation route not found', { status: 404, headers });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'GET, HEAD' } });
  }
  const contentType = path === '/openapi.json' ? 'application/json; charset=utf-8'
    : path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
  const body = request.method === 'HEAD' ? null
    : path === '/openapi.json' ? JSON.stringify(createOpenApiDocument())
      : path.endsWith('.js') ? initializer : html;
  return new Response(body, { headers: { ...headers, 'Content-Type': contentType } });
}

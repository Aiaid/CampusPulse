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
    <p><a href="/">返回校园地图</a> · <a href="/admin">管理后台</a> · <a href="/openapi.json">下载 OpenAPI JSON</a></p>
    <p>地点读取公开；人工记录、设备上传、研究读取分别使用独立凭据。Authorize 中只输入 token，不加 Bearer 前缀。凭据仅保留在当前页面内存中，刷新后清除。</p>
    <p>本页连接当前站点。执行写入操作会改变真实记录；请求示例是合成数据，请使用已登记的 V3 controlled_test 策略测试上传。管理员在管理后台初始化账号，再通过密码或 Passkey 登录；账号与密钥管理请使用管理界面。操作员、设备和研究凭据保持独立。设备上传 ACK 表示云端已提交该批，配置应用报告来自设备自身，均不代表硬件或无线完整性验证。</p>
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
  supportedSubmitMethods: ['get', 'post', 'put', 'patch', 'delete'],
  requestInterceptor: function (request) {
    const target = new URL(request.url, window.location.origin);
    if (target.origin !== window.location.origin ||
        !(target.pathname === '/openapi.json' || target.pathname.startsWith('/api/v1/') ||
          target.pathname.startsWith('/api/v3/'))) {
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

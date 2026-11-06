/** Local simulator controls. This document is never served by the production Worker. */
export function simulatorPage() {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>模拟设备控制台 · CampusPulse</title>
  <style>
    :root { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17282b; background: #f1f5f4; font-synthesis: none; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { max-width: 1120px; margin: auto; padding: 44px 24px 32px; }
    .eyebrow { margin: 0 0 12px; color: #476765; font-size: 12px; font-weight: 750; letter-spacing: .14em; }
    h1 { margin: 0 0 12px; font-size: clamp(28px, 4vw, 40px); letter-spacing: -.04em; }
    p { line-height: 1.7; }
    .intro { max-width: 760px; color: #526766; margin: 0; }
    .badges, .links, .card-head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
    .badges { margin: 22px 0; }
    .badge { border-radius: 6px; padding: 6px 10px; background: #e0e9e7; color: #254e49; font-size: 12px; font-weight: 700; }
    .badge.synthetic { background: #ffe7ad; color: #654300; }
    .links { margin: 22px 0 30px; }
    a { color: #126b5d; text-underline-offset: 4px; }
    .link-button { display: inline-flex; align-items: center; min-height: 44px; padding: 10px 16px; border: 1px solid #126b5d; border-radius: 9px; text-decoration: none; font-size: 14px; font-weight: 650; }
    .link-button.primary { background: #126b5d; color: white; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; align-items: start; }
    .card { min-width: 0; border: 1px solid #d7e1de; border-radius: 14px; background: #fff; padding: 24px; box-shadow: 0 4px 16px #173e2c04; }
    .card-head { justify-content: space-between; margin-bottom: 8px; }
    h2 { margin: 0; font-size: 19px; }
    .muted { color: #627570; font-size: 13px; }
    .card > p { margin: 10px 0 18px; }
    .scenarios { display: grid; gap: 9px; }
    button { font: inherit; cursor: pointer; }
    .scenario { display: block; width: 100%; text-align: left; border: 1px solid #d8e2df; border-radius: 10px; background: #fff; color: inherit; padding: 13px 15px; transition: border-color .15s, background .15s; }
    .scenario:hover { border-color: #4c8e81; background: #f6faf8; }
    .scenario[aria-pressed="true"] { border-color: #137460; background: #edf7f1; box-shadow: inset 3px 0 #137460; }
    .scenario strong { font-size: 14px; }
    .scenario code { color: #6e807a; font-size: 12px; margin-left: 8px; }
    .scenario span { display: block; margin-top: 5px; font-size: 13px; line-height: 1.5; color: #60726c; }
    button:disabled { opacity: .6; cursor: wait; }
    button:focus-visible, a:focus-visible { outline: 3px solid #daa126; outline-offset: 4px; }
    .reboot { margin-top: 22px; padding-top: 20px; border-top: 1px solid #e5ebe8; }
    .reboot button { min-height: 44px; border: 1px solid #cbd8d3; border-radius: 8px; background: #f7f9f8; color: inherit; padding: 9px 14px; font-size: 14px; }
    .reboot p { margin: 9px 0 0; }
    .connection { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: #627570; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: #8a9c95; }
    .connection[data-state="ok"] .dot { background: #198264; }
    .connection[data-state="error"] .dot { background: #c25732; }
    dl { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 12px 8px; margin: 22px 0; font-size: 13px; }
    dt { color: #6a7b75; }
    dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    pre { background: #132722; color: #d2ede2; padding: 18px; border-radius: 9px; overflow: auto; max-height: 520px; min-height: 240px; font: 12px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; tab-size: 2; }
    .feedback { min-height: 28px; margin: 12px 0 0; font-size: 13px; color: #216951; overflow-wrap: anywhere; }
    .feedback[data-error="true"] { color: #a53a25; }
    .notice { margin-top: 20px; border-left: 3px solid #d6aa4f; padding: 2px 0 2px 16px; }
    .notice p { margin: 6px 0; color: #63746c; font-size: 13px; }
    footer { padding-top: 26px; font-size: 12px; color: #6a7b75; }
    @media (max-width: 720px) { main { padding: 28px 16px; } .layout { grid-template-columns: minmax(0, 1fr); } .card { padding: 20px; } }
    @media (prefers-color-scheme: dark) {
      :root { color: #e4eee9; background: #101d19; }
      .eyebrow, .intro, .muted, .notice p, footer, dt, .connection { color: #a0b6aa; }
      .card, .scenario { background: #182a22; border-color: #354b3e; }
      .scenario:hover, .reboot button { background: #20372b; border-color: #4d6b58; }
      .scenario span, .scenario code { color: #abc1b2; }
      .scenario[aria-pressed="true"] { background: #204433; border-color: #64af84; }
      .badge { background: #2c4537; color: #c4e3ce; }
      a { color: #83cfab; }
      .link-button { border-color: #63ab87; }
      .link-button.primary { background: #246e50; }
      .reboot { border-color: #354b3e; }
      .feedback { color: #94d8ae; }
      .feedback[data-error="true"] { color: #ffac94; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">CAMPUSPULSE / LOCAL DEVELOPMENT</p>
      <h1>模拟设备控制台</h1>
      <p class="intro">在本机切换合成场景，观察 V3 设备注册、上传与管理流程。这里操作的是软件模拟设备，所有数据仅保存在当前进程的隔离临时数据库。</p>
      <div class="badges" aria-label="运行边界">
        <span id="source-badge" class="badge synthetic">模拟设备 · 合成数据</span>
        <span id="dataset-badge" class="badge">controlled_test</span>
        <span class="badge">仅本地运行</span>
      </div>
      <nav class="links" aria-label="本地应用">
        <a class="link-button primary" href="/__simulator/admin">自动登录本地管理后台 <span aria-hidden="true"> ↗</span></a>
        <a id="public-link" class="link-button" href="/?mode=field&amp;place=library">查看正常现场前台 <span aria-hidden="true"> ↗</span></a>
      </nav>
    </header>
    <div class="layout">
      <section class="card" aria-labelledby="scenario-title">
        <div class="card-head"><h2 id="scenario-title">场景控制</h2><span class="muted">即时切换</span></div>
        <p class="muted">选择下一轮模拟活动。右侧显示服务端返回的实际设备状态。</p>
        <div class="scenarios" role="group" aria-label="模拟场景">
          <button class="scenario" type="button" data-scenario="quiet" aria-pressed="false"><strong>安静</strong><code>quiet</code><span>低活动场景，用于观察平稳上传与小统计窗口。</span></button>
          <button class="scenario" type="button" data-scenario="busy" aria-pressed="false"><strong>繁忙</strong><code>busy</code><span>较高合成活动，用于对照统计与管理展示。</span></button>
          <button class="scenario" type="button" data-scenario="loss" aria-pressed="false"><strong>模拟丢失</strong><code>loss</code><span>注入受控丢失情境，观察损失信息与状态呈现。</span></button>
          <button class="scenario" type="button" data-scenario="offline" aria-pressed="false"><strong>离线</strong><code>offline</code><span>模拟设备暂时离线，观察本地状态与云端历史的区别。</span></button>
          <button class="scenario" type="button" data-scenario="failed" aria-pressed="false"><strong>故障</strong><code>failed</code><span>模拟失败状态，用于检查错误与恢复流程。</span></button>
        </div>
        <div class="reboot">
          <button id="reboot" type="button">重新启动模拟设备</button>
          <button id="retry" type="button">重试冻结批次</button>
          <p class="muted">重启创建新的启动身份并保留数据库历史；未确认的批次会阻止重启。修复故障后可重试原始冻结批次。</p>
        </div>
        <p id="action-feedback" class="feedback" role="status" aria-live="polite"></p>
      </section>
      <section class="card" aria-labelledby="status-title">
        <div class="card-head">
          <h2 id="status-title">设备运行状态</h2>
          <span id="connection" class="connection"><span class="dot" aria-hidden="true"></span><span id="connection-text">等待连接</span></span>
        </div>
        <dl>
          <dt>设备 ID</dt><dd id="node-id">—</dd>
          <dt>数据集</dt><dd id="dataset">controlled_test</dd>
          <dt>窗口</dt><dd id="window">—</dd>
          <dt>最近刷新</dt><dd id="updated">—</dd>
        </dl>
        <p class="muted" id="json-label">设备原始状态 · 每秒刷新</p>
        <pre id="device-json" tabindex="0" aria-labelledby="json-label">正在读取模拟设备状态…</pre>
        <p id="status-feedback" class="feedback" role="status" aria-live="polite"></p>
      </section>
    </div>
    <aside class="notice" aria-label="测试范围说明">
      <p id="replay-notice" hidden><strong>历史 CPRAW 回放：</strong>统计来自已保存采集，使用当前测试时钟、新身份与租约重放；原始时间与来源哈希单独保留。回放结束后停止生成窗口，不混入合成活动。</p>
      <p id="dataset-notice"><strong>数据边界：</strong>默认 controlled_test 记录与正常现场 API 隔离；请在本地管理后台检查。</p>
      <p><strong>验证边界：</strong>当前使用 CPV3 帧与真实本地网关、RPC 检查、服务绑定和 V3 API。Broker 与回包传输由本机模拟；未验证生产 EMQX、原生 MQTT/TLS 连接或真实无线硬件。</p>
      <p>本地管理登录使用临时会话；此页面与测试数据库仅用于当前本地开发服务。</p>
    </aside>
    <footer>CampusPulse · V3 software device simulator</footer>
  </main>
  <script>
    (() => {
      'use strict';
      const byId = (id) => document.getElementById(id);
      const scenarioButtons = Array.from(document.querySelectorAll('[data-scenario]'));
      const controls = [...scenarioButtons, byId('reboot'), byId('retry')];
      const feedback = byId('action-feedback');
      let busy = false;
      let replayMode = false;
      const updateControls = () => controls.forEach(button => {
        button.disabled = busy || replayMode && ['busy', 'loss'].includes(button.dataset.scenario);
      });
      let statusRequest = null;
      const asText = (value) => value === undefined || value === null ? '—' : String(value);

      async function request(path, body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const options = { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } };
          if (body !== undefined) {
            options.method = 'POST';
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
          }
          const response = await fetch(path, options);
          const data = await response.json().catch(() => null);
          if (!response.ok) throw new Error(data?.error?.message || '请求失败（HTTP ' + response.status + '）');
          return data;
        } catch (error) {
          if (error.name === 'AbortError') throw new Error('请求超时，请确认本地服务仍在运行。');
          throw error;
        } finally { clearTimeout(timeout); }
      }

      function refreshStatus() {
        if (statusRequest) return statusRequest;
        statusRequest = (async () => {
          try {
            const data = await request('/__simulator/status');
            if (!data || data.schema !== 'campuspulse-v3-simulator/1' || data.isolation !== 'ephemeral-local-d1' ||
                !(['test', 'live'].includes(data.view)) || data.dataset !== (data.view === 'live' ? 'field' : 'controlled_test')) {
              throw new Error('状态响应不符合隔离本地模拟协议。');
            }
            byId('node-id').textContent = asText(data.node_id);
            byId('replay-notice').hidden = !data.device?.replay;
            replayMode = Boolean(data.device?.replay);
            byId('source-badge').textContent = replayMode ? '历史采集 · 测试回放' : '模拟设备 · 合成数据';
            updateControls();
            byId('dataset').textContent = asText(data.dataset);
            byId('dataset-badge').textContent = data.dataset + (data.view === 'live' ? ' · 本地 live 调试' : '');
            byId('public-link').href = data.urls.public;
            byId('dataset-notice').textContent = data.view === 'live'
              ? '数据边界：当前虚拟设备通过正常 field 策略与上传进入正常现场前台；合成来源保留在管理端。数据仅存在隔离的临时本地数据库，不接入生产。'
              : '数据边界：当前 controlled_test 记录与正常现场 API 隔离；请在本地管理后台检查。';
            byId('window').textContent = asText(data.window_ms) + ' ms';
            byId('device-json').textContent = JSON.stringify({ ...data.device, gateway: data.transport }, null, 2);
            byId('updated').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            const scenario = data.device && data.device.scenario;
            scenarioButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.scenario === scenario)));
            byId('connection').dataset.state = 'ok';
            byId('connection-text').textContent = '本地服务已连接';
            byId('status-feedback').dataset.error = String(Boolean(data.last_error));
            byId('status-feedback').textContent = data.last_error || '';
            return true;
          } catch (error) {
            byId('connection').dataset.state = 'error';
            byId('connection-text').textContent = '状态刷新失败';
            byId('status-feedback').dataset.error = 'true';
            byId('status-feedback').textContent = error.message + ' 已显示的状态可能过期，将自动重试。';
            return false;
          } finally { statusRequest = null; }
        })();
        return statusRequest;
      }

      async function act(path, body, success) {
        if (busy) return;
        busy = true;
        updateControls();
        feedback.dataset.error = 'false';
        feedback.textContent = '正在提交…';
        try {
          await request(path, body);
          feedback.textContent = success;
          await refreshStatus();
        } catch (error) {
          feedback.dataset.error = 'true';
          feedback.textContent = error.message;
        } finally {
          busy = false;
          updateControls();
        }
      }
      scenarioButtons.forEach((button) => button.addEventListener('click', () => {
        act('/__simulator/scenario', { scenario: button.dataset.scenario }, '场景切换已提交：' + button.dataset.scenario + '。');
      }));
      byId('reboot').addEventListener('click', () => act('/__simulator/reboot', {}, '模拟设备重启已提交，历史记录保留。'));
      byId('retry').addEventListener('click', () => act('/__simulator/retry', {}, '已允许重试原始冻结批次，请查看设备状态与回执。'));
      async function poll() {
        await refreshStatus();
        setTimeout(poll, 1000);
      }
      poll();
    })();
  </script>
</body>
</html>`;
}

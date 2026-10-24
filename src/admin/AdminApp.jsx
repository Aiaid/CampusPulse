import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SquaresFour, Cpu, MapPin, SlidersHorizontal, GearSix, ListBullets, SignOut, ArrowUpRight, CircleNotch, ShieldCheck, ArrowClockwise, Pulse, UserCircle } from '@phosphor-icons/react';
import { AdminContext, Badge, ErrorNotice, Field, Loading, Metric, Notice, Panel, PageHeader, Resource, Empty, fmtTime, useAdmin, useMutation, useResource } from './shared.jsx';
import Devices from './Devices.jsx';
import Places from './Places.jsx';
import Configs from './Configs.jsx';
import AccountSecurity from './AccountSecurity.jsx';
import { Bootstrap, Login, ReauthDialog } from './AuthScreens.jsx';
import './admin.css';

const messages = {
  unauthorized: '管理员会话已失效，请重新登录。', bootstrap_only: '当前会话仅能初始化账号，请先完成账号创建。', reauth_required: '此操作需要再次验证身份。', rate_limited: '尝试次数过多，请稍后重试。', passkey_not_configured: 'Passkey 服务尚未配置可信来源与 RP 域名，请先使用账号密码。', invalid_passkey_response: 'Passkey 验证未通过，本次操作未完成。请重新发起验证。', auth_conflict: '账号或 Passkey 状态已更新，请刷新后重新操作。', admin_unauthorized: '管理员凭证无效，请重新输入。',
  invalid_name: '名称须为 1–80 个可打印字符，且不能全为空白。',
  invalid_password: '密码须为 12–256 个 Unicode 字符，最多 1024 个 UTF-8 字节。', invalid_username: '用户名须为 3–64 位小写字母、数字、点、下划线或短横线，首位为字母或数字。', invalid_auth_input: '认证表单字段不符合要求，请检查格式与长度。', already_initialized: '账号已完成初始化，请重新登录。', password_storage_invalid: '账号认证暂不可用，请联系部署维护者检查密码存储。', passkey_not_found: '该 Passkey 已不存在，请刷新列表。',
  admin_not_configured: '管理员认证尚未配置。请由部署维护者设置独立的 ADMIN_TOKEN。',
  revision_conflict: '内容已更新，或本次变更与已有记录冲突。请刷新检查版本、重复 ID 和历史区间后重试。', draft_conflict: '草稿版本已变化，请刷新后重试。',
  origin_rejected: '请求来源不受信任，请从本站管理页重试。',
  config_already_published: '此版本已经发布。请复制为新草稿后修改。',
  https_required: '管理员访问需要 HTTPS；本地开发可使用 localhost。',
  storage_unavailable: '管理服务或存储暂时不可用，请稍后重试。', settings_unavailable: '运行设置暂时不可用，请检查数据库迁移和服务状态。',
  invalid_settings: '站点设置不符合要求，请检查名称、模式和各数值范围。',
  placement_mismatch: '配置引用的部署不属于这台设备，请重新选择。', placement_inactive: '发布只能引用当前有效的部署；未来或历史部署的更改可以先保存草稿。',
  config_expired: '配置接收截止时间已过，请更新草稿后重试。', raw_storage_not_configured: '私有原始数据存储尚未配置，暂时不能发布原始报告策略。',
  device_not_found: '该设备不存在，请刷新列表。', place_not_found: '该地点不存在，请刷新列表。', draft_not_found: '该草稿不存在或已发布，请刷新列表。',
  config_published: '此版本已经发布，不能覆盖。请复制为新草稿。', method_not_allowed: '管理 API 不支持本次操作，请检查前后端版本。', not_found: '未找到该管理接口。',
};
const nav = [ ['overview', '运行概览', SquaresFour], ['devices', '设备管理', Cpu], ['places', '地点与部署', MapPin], ['configs', '采集配置', SlidersHorizontal], ['settings', '站点设置', GearSix], ['audit', '操作审计', ListBullets], ['account', '账号与安全', UserCircle] ];

export default function AdminApp() {
  const rootRef = useRef(null);
  const checkRef = useRef(null);
  const checkingRef = useRef(false);
  const reauthPending = useRef(null);
  const [auth, setAuth] = useState('checking');
  const authRef = useRef(auth);
  authRef.current = auth;
  const [session, setSession] = useState(null);
  const [authStatus, setAuthStatus] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [authInfo, setAuthInfo] = useState('');
  const [page, setPage] = useState('overview');
  const [version, setVersion] = useState(0);
  const [flash, setFlash] = useState('');
  const [credential, setCredential] = useState(null);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [reauthUntil, setReauthUntil] = useState(null);
  const api = useCallback(async (path, options = {}) => {
    const { sessionCheck = false, ...requestOptions } = options;
    let response;
    try { response = await fetch(`/api/v1/admin${path}`, { credentials: 'same-origin', cache: 'no-store', ...requestOptions, headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) }); }
    catch { throw new Error('无法连接管理服务。请检查网络后重试。'); }
    let body;
    try { body = response.status === 204 ? {} : await response.json(); } catch { throw new Error('管理服务未返回有效 JSON，请检查 API 部署。'); }
    if (!response.ok) {
      const code = body.error?.code;
      if (response.status === 401 && !sessionCheck && path !== '/auth/reauth' && ['admin', 'bootstrap'].includes(authRef.current)) {
        setCredential(null); setSession(null); setAuthInfo('管理员会话已失效，请重新登录。'); setAuth('checking');
        checkRef.current?.();
      }
      const invalidField = ['invalid_admin_input', 'invalid_ingest', 'invalid_auth_input'].includes(code) ? body.error?.message?.match(/^Invalid field: (.+)\.$/)?.[1] : null;
      const loginFailure = path === '/session' && options.method === 'POST' && response.status === 401;
      const error = new Error(loginFailure ? '用户名或密码不正确，或初始化凭证不可用。请检查后重试。' : path === '/auth/reauth' && response.status === 401 ? '当前密码不正确，或会话已经失效。请重新检查。' : invalidField ? `字段不符合要求：${invalidField}。请检查格式与范围。` : messages[code] || body.error?.message || `服务请求失败（${response.status}）`);
      error.code = code; error.status = response.status;
      throw error;
    }
    return body;
  }, []);
  const closeReauth = useCallback(result => {
    reauthPending.current?.resolve(result);
    reauthPending.current = null;
    setReauthOpen(false);
  }, []);
  const checkSession = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setAuth('checking'); setAuthError(null); setCredential(null); closeReauth(false);
    try {
      const status = await api('/auth/status', { sessionCheck: true });
      setAuthStatus(status);
      try {
        const current = await api('/session', { sessionCheck: true });
        if (!current.authenticated || !['admin', 'bootstrap'].includes(current.role)) throw new Error('服务端返回了不受支持的管理员会话。');
        setSession(current); setAuth(current.role);
      } catch (error) { setSession(null); setAuth('out'); if (error.status !== 401) setAuthError(error); }
    } catch (error) { setAuthStatus(null); setSession(null); setAuth('out'); setAuthError(error); }
    finally { checkingRef.current = false; }
  }, [api, closeReauth]);
  checkRef.current = checkSession;
  useEffect(() => { checkSession(); }, [checkSession]);
  useEffect(() => { if (!flash) return; const timer = setTimeout(() => setFlash(''), 8000); return () => clearTimeout(timer); }, [flash]);
  useEffect(() => {
    if (!credential) return;
    const clear = () => setCredential(null);
    window.addEventListener('pagehide', clear);
    return () => window.removeEventListener('pagehide', clear);
  }, [credential]);
  useEffect(() => { if (auth !== 'admin') { closeReauth(false); setReauthUntil(null); } }, [auth, closeReauth]);
  useEffect(() => { if (!reauthUntil) return; const timer = setTimeout(() => setReauthUntil(null), Math.max(0, Date.parse(reauthUntil) - Date.now())); return () => clearTimeout(timer); }, [reauthUntil]);
  const acceptSession = current => {
    if (!current.authenticated || !['admin', 'bootstrap'].includes(current.role)) throw new Error('服务端未确认管理员身份，请重新登录。');
    setSession(current); setAuth(current.role); setAuthError(null); setAuthInfo(''); setCredential(null); setPage('overview');
    setVersion(v => v + 1);
    api('/auth/status', { sessionCheck: true }).then(setAuthStatus).catch(() => setAuthStatus(null));
  };
  const signedOut = info => {
    closeReauth(false); setCredential(null); setSession(null); setAuth('out'); setPage('overview'); setFlash(''); setAuthInfo(info || '已退出管理会话。'); setReauthUntil(null);
    api('/auth/status', { sessionCheck: true }).then(setAuthStatus).catch(setAuthError);
  };
  const requestReauth = () => {
    if (reauthPending.current) return reauthPending.current.promise;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    reauthPending.current = { resolve, promise }; setReauthOpen(true);
    return promise;
  };
  const sensitiveAction = async (action, { retry = true } = {}) => {
    try { return await action(); }
    catch (error) {
      if (error.code !== 'reauth_required') throw error;
      if (!await requestReauth()) throw new Error('已取消身份验证，本次操作未执行。');
      return retry ? action() : { reauthOnly: true };
    }
  };
  const refresh = () => setVersion(v => v + 1);
  const notify = text => { setFlash(text); refresh(); };
  const navigate = next => { setCredential(null); setFlash(''); setPage(next); rootRef.current?.scrollTo({ top: 0 }); };
  const value = { api, version, refresh, notify, navigate, session, authStatus, reauthUntil, requestReauth, sensitiveAction, signedOut, updateAccount: account => setSession(v => ({ ...v, account })), revealCredential: (node, secret) => setCredential({ node, secret }) };
  const logout = useMutation();
  const logoutAction = () => logout.run(async () => { await api('/session', { method: 'DELETE' }); signedOut(); });
  return <div className="admin-root" ref={rootRef}><AdminContext.Provider value={value}>
    {auth === 'checking' ? <div className="ad-auth"><Loading label="正在验证管理员会话…" /></div> : auth === 'bootstrap' ? <Bootstrap api={api} onSession={acceptSession} onLogout={logoutAction} error={logout.error} logoutPending={logout.pending} /> : auth !== 'admin' ? <Login api={api} status={authStatus} error={authError} info={authInfo} onSession={acceptSession} onRetry={checkSession} /> : <div className="ad-shell">
      <aside className="ad-sidebar"><a className="ad-brand" href="/admin"><span className="ad-brand-icon"><Pulse size={25} weight="bold" /></span><span>CampusPulse<small>管理工作台</small></span></a><div className="ad-sidebar-label">工作空间</div><nav aria-label="管理导航">{nav.map(([id, label, Icon]) => <button key={id} className={`ad-nav-item ${page === id ? 'is-active' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={20} weight={page === id ? 'fill' : 'regular'} /><span>{label}</span></button>)}</nav><div className="ad-sidebar-bottom"><button className="ad-session ad-session-account" onClick={() => navigate('account')}><ShieldCheck size={18} /><span>{session?.account?.display_name || '管理员'}<small>@{session?.account?.username || '—'}</small></span></button><a href="/" className="ad-nav-item"><ArrowUpRight size={19} />返回校园地图</a><button className="ad-nav-item" disabled={logout.pending} onClick={logoutAction}><SignOut size={19} />{logout.pending ? '正在退出…' : '退出登录'}</button><ErrorNotice error={logout.error} /></div></aside>
      <div className="ad-workspace"><div className="ad-topbar"><span><span className="ad-online-dot" />管理服务 · 同源连接</span><div className="ad-topbar-actions"><button className="ad-current-user" onClick={() => navigate('account')}><UserCircle size={17} />{session?.account?.display_name || '管理员'}</button><button className="ad-button ad-small" onClick={refresh}><ArrowClockwise size={16} />刷新数据</button></div></div><main className="ad-main" id="admin-main">{flash && <div className="ad-flash" role="status">{flash}<button aria-label="关闭提示" onClick={() => setFlash('')}>×</button></div>}{page === 'overview' && <Overview />}{page === 'devices' && <Devices />}{page === 'places' && <Places />}{page === 'configs' && <Configs />}{page === 'settings' && <Settings />}{page === 'audit' && <Audit />}{page === 'account' && <AccountSecurity />}</main><footer className="ad-footer">CampusPulse / 管理工作台<span>设备回执、现场观测与演示数据分别记录</span></footer></div>
    </div>}
    {auth === 'admin' && credential && <Credential credential={credential} onClose={() => setCredential(null)} />}
    {auth === 'admin' && reauthOpen && <ReauthDialog api={api} passkeyAvailable={!!authStatus?.passkey_available} onClose={() => closeReauth(false)} onSuccess={result => { setReauthUntil(result.expires_at); closeReauth(true); }} />}
  </AdminContext.Provider></div>;
}

function Credential({ credential, onClose }) {
  const [revealed, setRevealed] = useState(false);
  // Native modal traps focus and keeps the one-time secret out of the page behind it.
  return <CredentialDialog title="一次性设备凭证" onClose={onClose}><Notice>请现在安全保存设备 <strong>{credential.node}</strong> 的凭证并配置到设备。关闭后无法再次查看；遗失时只能重新轮换。</Notice><Field label="设备凭证"><input className="ad-secret" aria-label="一次性设备凭证" type={revealed ? 'text' : 'password'} readOnly value={credential.secret} autoComplete="off" spellCheck={false} /></Field><label className="ad-checkbox"><input type="checkbox" checked={revealed} onChange={e => setRevealed(e.target.checked)} />显示本次凭证</label><p className="ad-muted">请勿放入源码、日志、公开截图或聊天。仅本次界面内存持有该凭证。</p><div className="ad-form-actions"><button className="ad-button ad-primary" onClick={onClose}>已安全保存，关闭并清除</button></div></CredentialDialog>;
}
// Separate import name makes the credential lifecycle explicit.
import { Dialog as CredentialDialog } from './shared.jsx';

function Overview() {
  const { version, navigate } = useAdmin();
  const overview = useResource('/overview', version);
  const devices = useResource('/devices', version);
  return <><PageHeader eyebrow="WORKSPACE / OVERVIEW" title="运行概览" description="从服务端回执出发，了解设备联系、配置下发与待处理事项。" /><Resource resource={overview}>{data => <><div className="ad-stats"><Metric label="已登记设备" value={data.devices_total} hint={`${data.devices_enabled ?? 0} 台启用`} /><Metric label="最近有回执" value={data.devices_recent} hint="按站点联系过期阈值判断" /><Metric label="联系过期" value={data.devices_stale} hint="需要检查设备或网络" /><Metric label="等待配置确认" value={data.config_pending} hint="发布不等于设备已应用" /></div><div className="ad-overview-grid"><Panel title="设备联系" description="最近回执仅表示云端收到数据，不能证明扫描持续运行。"><Resource resource={devices}>{result => result.devices.length ? <div className="ad-device-summaries">{result.devices.slice(0, 6).map(device => <button key={device.id} onClick={() => navigate('devices')}><span className="ad-device-icon"><Cpu size={21} /></span><span><strong>{device.name || device.id}</strong><small>{device.id} · {fmtTime(device.last_seen_at)}</small></span><Badge state={device.enabled ? device.contact_state : 'disabled'} /></button>)}</div> : <Empty title="还没有登记设备">前往设备管理注册设备，再配置部署位置和采集策略。</Empty>}</Resource><button className="ad-text-button" onClick={() => navigate('devices')}>查看全部设备 <ArrowUpRight /></button></Panel><Panel title="数据可信边界" className="ad-boundary-panel"><span className="ad-boundary-icon"><ShieldCheck size={30} /></span><h3>看见回执，也看见未知。</h3><p>没有状态上报时，扫描、队列与存储均显示「未上报」，不会用零值替代。</p><p>配置必须由设备明确 ACK 后才显示已应用。当前服务端能力不代表固件或现场硬件已完成验收。</p><div className="ad-boundary-time">服务端时间<span>{fmtTime(data.server_time)}</span></div></Panel></div></>}</Resource><Notice>BLE 可见标识不等于人数；演示、受控测试和现场数据须分别理解。设备最近联系也不代表无线覆盖完整。</Notice></>;
}

function Settings() {
  const { version } = useAdmin();
  const resource = useResource('/settings', version);
  return <><PageHeader eyebrow="WORKSPACE / SETTINGS" title="站点设置" description="调整页面默认行为与后续新数据使用的运行参数。" /><Resource resource={resource}>{data => <SettingsForm key={data.revision} data={data} />}</Resource></>;
}
function SettingsForm({ data }) {
  const { api, notify } = useAdmin();
  const [settings, setSettings] = useState(data.settings);
  const mutation = useMutation();
  const number = (key, e) => setSettings(v => ({ ...v, [key]: Number(e.target.value) }));
  return <Panel title="运行参数" description={`修订版本 ${data.revision} · 保存时会检查并发修改`}><form onSubmit={e => { e.preventDefault(); mutation.run(async () => { await api('/settings', { method: 'PUT', body: { settings, revision: data.revision } }); notify('站点设置已保存；新记录和新草稿使用更新后的默认值。'); }); }}><div className="ad-form-grid"><Field label="站点名称"><input required maxLength={80} value={settings.site_name} onChange={e => setSettings(v => ({ ...v, site_name: e.target.value }))} /></Field><Field label="默认地图模式"><select value={settings.default_mode} onChange={e => setSettings(v => ({ ...v, default_mode: e.target.value }))}><option value="demo">演示模式（合成活动）</option><option value="field">现场模式（真实观测）</option></select></Field><Field label="设备联系过期阈值（秒）" hint="按最后收到回执的服务端时间判断联系状态。"><input required type="number" min="30" max="604800" step="1" value={settings.stale_after_seconds} onChange={e => number('stale_after_seconds', e)} /></Field><Field label="新手动记录有效时长（分钟）" hint="只影响之后创建的记录，不修改历史到期时间。"><input required type="number" min="1" max="1440" step="1" value={settings.observation_ttl_minutes} onChange={e => number('observation_ttl_minutes', e)} /></Field><Field label="新草稿原始数据保留（小时）"><input required type="number" min="1" max="8760" step="1" value={settings.default_raw_retention_hours} onChange={e => number('default_raw_retention_hours', e)} /></Field><Field label="新草稿汇总数据保留（天）"><input required type="number" min="1" max="3650" step="1" value={settings.default_aggregate_retention_days} onChange={e => number('default_aggregate_retention_days', e)} /></Field></div><Notice>保留策略在发布配置时固定；修改默认值不会重写已有配置、数据或回执的生命周期。</Notice><ErrorNotice error={mutation.error} /><FormActions pending={mutation.pending} label="保存站点设置" /></form></Panel>;
}
import { FormActions } from './shared.jsx';

function Audit() {
  const { api, version } = useAdmin();
  const resource = useResource('/audit', version);
  const [more, setMore] = useState([]);
  const [cursor, setCursor] = useState(null);
  const mutation = useMutation();
  useEffect(() => { setMore([]); setCursor(null); }, [version]);
  const names = { 'device.register': '登记设备', 'device.update': '更新设备', 'device.rotate_credential': '轮换设备凭证', 'place.create': '新建地点', 'place.update': '更新地点', 'placement.create': '更新部署', 'config.create_draft': '创建配置草稿', 'config.update_draft': '编辑配置草稿', 'config.publish': '发布采集配置', 'settings.update': '更新站点设置', 'session.login': '管理员登录', 'session.logout': '管理员退出', 'account.setup': '初始化管理员账号', 'account.update': '更新账号资料', 'account.password_change': '修改管理员密码', 'passkey.register': '登记 Passkey', 'passkey.rename': '重命名 Passkey', 'passkey.delete': '删除 Passkey', 'auth.reauth': '再次验证身份', 'session.bootstrap': '初始化凭证登录', 'session.reauthenticate': '再次验证身份' };
  return <><PageHeader eyebrow="WORKSPACE / AUDIT" title="操作审计" description="追踪管理操作的时间、对象与变更摘要，不包含凭证和原始无线数据。" /><Resource resource={resource}>{data => { const entries = [...data.entries, ...more]; const next = cursor === null ? data.next_cursor : cursor; return <Panel title="最近操作" description="按服务端记录时间倒序展示"><div className="ad-table-scroll">{entries.length ? <table><thead><tr><th>操作</th><th>目标</th><th>时间</th><th>变更摘要</th></tr></thead><tbody>{entries.map(entry => <tr key={entry.id}><td><strong>{names[entry.action] || entry.action}</strong><small className="ad-subtext">{entry.action}</small></td><td className="ad-mono">{typeof entry.target === 'string' ? entry.target : JSON.stringify(entry.target)}</td><td className="ad-nowrap">{fmtTime(entry.created_at)}</td><td><details><summary>查看摘要</summary><pre className="ad-json">{JSON.stringify(entry.detail, null, 2)}</pre></details></td></tr>)}</tbody></table> : <Empty title="暂无管理操作记录">完成设备登记、配置发布或设置变更后，记录会出现在这里。</Empty>}</div><ErrorNotice error={mutation.error} />{next && <div className="ad-form-actions"><button className="ad-button" disabled={mutation.pending} onClick={() => mutation.run(async () => { const result = await api(`/audit?before=${encodeURIComponent(next)}`); setMore(v => [...v, ...result.entries]); setCursor(result.next_cursor || ''); })}>{mutation.pending ? '正在加载…' : '加载更早记录'}</button></div>}</Panel>; }}</Resource></>;
}

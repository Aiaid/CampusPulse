import React, { useState } from 'react';
import { ArrowUpRight, CircleNotch, Fingerprint, ShieldCheck, SignOut } from '@phosphor-icons/react';
import { Dialog, ErrorNotice, Field, FormActions, Notice, useMutation } from './shared.jsx';
import { authenticatePasskey, passkeySupport } from './passkeys.js';

const usernamePattern = '[a-z0-9][a-z0-9_.-]{2,63}';
export function validateNewPassword(password, confirmation) {
  if (password !== confirmation) throw new Error('两次输入的新密码不一致，请重新检查。');
  if ([...password].length < 12 || [...password].length > 256 || new TextEncoder().encode(password).length > 1024) throw new Error('密码须为 12–256 个字符，且 UTF-8 编码不超过 1024 字节。密码不会自动去除空格。');
}

function AuthFrame({ children, title, description }) {
  return <main className="cp-admin-auth"><div className="cp-admin-login-decoration" aria-hidden="true"><img src="/icons/campuspulse-192.png" width="54" height="54" alt="" /><span>校园 / 运行管理</span></div><div className="cp-admin-login-card"><div className="cp-admin-eyebrow">CampusPulse 管理工作台</div><h1>{title}</h1><p>{description}</p>{children}<div className="cp-admin-login-foot"><ShieldCheck size={17} />HttpOnly Cookie 保护会话<a href="/">返回地图</a></div></div></main>;
}

export function Login({ api, status, error, info, onSession, onRetry }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const mutation = useMutation();
  const browserUnavailable = passkeySupport();
  const initialized = status?.initialized;
  return <AuthFrame title={<>让每次观测，<br />都有可靠的来处。</>} description={initialized ? '使用管理员账号密码或已登记的 Passkey 登录。' : '首次使用需要先验证初始化凭证，再创建管理员账号。'}>{info && <div className="cp-admin-flash" role="status">{info}</div>}<ErrorNotice error={error} retry={onRetry} />{status ? initialized ? <><form onSubmit={e => { e.preventDefault(); const submitted = password; setPassword(''); mutation.run(async () => { const session = await api('/session', { method: 'POST', body: { username, password: submitted } }); onSession(session); }); }}><div className="cp-admin-auth-fields"><Field label="用户名"><input name="username" autoComplete="username" required maxLength={64} value={username} onChange={e => setUsername(e.target.value)} disabled={mutation.pending} autoCapitalize="none" spellCheck={false} /></Field><Field label="密码"><input name="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} disabled={mutation.pending} /></Field></div><button className="cp-admin-button cp-admin-primary cp-admin-login-submit" disabled={mutation.pending || !status.password_login_available}>{mutation.pending ? <><CircleNotch className="cp-admin-spin" />正在验证…</> : <>账号密码登录<ArrowUpRight size={19} /></>}</button></form><div className="cp-admin-auth-divider"><span>或</span></div><button className="cp-admin-button cp-admin-passkey-login" type="button" disabled={mutation.pending || !status.passkey_available || !!browserUnavailable} onClick={() => { setPassword(''); mutation.run(async () => onSession(await authenticatePasskey(api, 'login'))); }}><Fingerprint size={20} />使用 Passkey 登录</button>{browserUnavailable ? <p className="cp-admin-muted cp-admin-auth-help">{browserUnavailable}</p> : !status.passkey_available && <p className="cp-admin-muted cp-admin-auth-help">本站 Passkey 登录暂不可用，请先使用密码。{status.passkey_unavailable_code === 'passkey_not_configured' ? '维护者需要配置可信来源和 RP 域名。' : ''}</p>}</> : status.bootstrap_available ? <><Notice>初始化凭证只用于创建第一个管理员账号。创建完成后，该入口关闭，后续使用账号密码或 Passkey 登录。</Notice><form onSubmit={e => { e.preventDefault(); const submitted = token; setToken(''); mutation.run(async () => onSession(await api('/session', { method: 'POST', body: { token: submitted } }))); }}><Field label="初始化凭证" hint="使用部署维护者设置的 ADMIN_TOKEN；不会写入浏览器存储。"><input name="bootstrap-token" type="password" autoComplete="off" required value={token} onChange={e => setToken(e.target.value)} disabled={mutation.pending} /></Field><button className="cp-admin-button cp-admin-primary cp-admin-login-submit" disabled={mutation.pending}>{mutation.pending ? '正在验证…' : '验证并初始化账号'}<ArrowUpRight size={18} /></button></form></> : <Notice>账号尚未初始化，且初始化入口不可用。请由部署维护者检查独立管理员密钥和数据库迁移。</Notice> : <Notice>无法获取认证状态。请重试后再登录。</Notice>}<ErrorNotice error={mutation.error} /></AuthFrame>;
}

export function Bootstrap({ api, onSession, onLogout, error, logoutPending }) {
  const [form, setForm] = useState({ username: '', display_name: '', password: '', confirmation: '' });
  const mutation = useMutation();
  const update = key => e => setForm(v => ({ ...v, [key]: e.target.value }));
  return <AuthFrame title="创建管理员账号" description="此会话只允许初始化账号，无法访问设备、观测和管理数据。"><form onSubmit={e => { e.preventDefault(); const submitted = { ...form }; setForm(v => ({ ...v, password: '', confirmation: '' })); mutation.run(async () => { validateNewPassword(submitted.password, submitted.confirmation); const session = await api('/auth/setup', { method: 'POST', body: { username: submitted.username, display_name: submitted.display_name, password: submitted.password } }); onSession(session); }); }}><div className="cp-admin-auth-fields"><Field label="用户名" hint="3–64 位小写字母、数字、点、下划线或短横线；首位须为字母或数字。"><input required name="username" autoComplete="username" pattern={usernamePattern} minLength={3} maxLength={64} value={form.username} onChange={update('username')} autoCapitalize="none" spellCheck={false} /></Field><Field label="显示名称"><input required name="display-name" autoComplete="nickname" maxLength={80} value={form.display_name} onChange={update('display_name')} /></Field><Field label="新密码" hint="至少 12 个字符，无强制字符组合；保留输入中的空格。"><input required type="password" name="new-password" autoComplete="new-password" value={form.password} onChange={update('password')} /></Field><Field label="确认新密码"><input required type="password" name="confirm-new-password" autoComplete="new-password" value={form.confirmation} onChange={update('confirmation')} /></Field></div><ErrorNotice error={mutation.error || error} /><FormActions pending={mutation.pending || logoutPending} label="创建管理员账号" /></form><button className="cp-admin-text-button" type="button" disabled={mutation.pending || logoutPending} onClick={onLogout}><SignOut />退出初始化</button></AuthFrame>;
}

export function ReauthDialog({ api, passkeyAvailable, onSuccess, onClose }) {
  const [password, setPassword] = useState('');
  const mutation = useMutation();
  const unavailable = passkeySupport();
  const verify = action => mutation.run(async () => { let result; try { result = await action(); } catch (error) { if (error.status === 401) await api('/session'); throw error; } if (!result.reauthenticated) throw new Error('服务端未确认身份验证，请重试。'); onSuccess(result); });
  return <Dialog title="再次验证身份" onClose={onClose} pending={mutation.pending}><Notice>账号资料、密码、Passkey 和设备联网授权等敏感操作，需要最近 5 分钟内验证过身份。验证成功后会继续本次操作；登记新的 Passkey 需要再次明确点击。</Notice><form onSubmit={e => { e.preventDefault(); const submitted = password; setPassword(''); verify(() => api('/auth/reauth', { method: 'POST', body: { password: submitted } })); }}><Field label="当前密码"><input required type="password" name="current-password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} disabled={mutation.pending} /></Field><div className="cp-admin-form-actions"><button className="cp-admin-button" type="button" onClick={onClose} disabled={mutation.pending}>取消</button><button className="cp-admin-button cp-admin-primary" disabled={mutation.pending}>{mutation.pending ? '正在验证…' : '使用密码验证'}</button></div></form>{passkeyAvailable && <button className="cp-admin-button cp-admin-passkey-login" type="button" disabled={mutation.pending || !!unavailable} onClick={() => { setPassword(''); verify(() => authenticatePasskey(api, 'reauth')); }}><Fingerprint size={19} />使用 Passkey 验证</button>}{unavailable && <p className="cp-admin-muted cp-admin-auth-help">{unavailable}</p>}<ErrorNotice error={mutation.error} /></Dialog>;
}

export { usernamePattern };

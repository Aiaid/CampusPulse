import React, { useState } from 'react';
import { Fingerprint, Key, PencilSimple, Plus, ShieldCheck, Trash } from '@phosphor-icons/react';
import { Confirm, Dialog, Empty, ErrorNotice, Field, FormActions, Notice, PageHeader, Panel, Resource, fmtTime, useAdmin, useMutation, useResource } from './shared.jsx';
import { usernamePattern, validateNewPassword } from './AuthScreens.jsx';
import { passkeySupport, registerPasskey } from './passkeys.js';
import HelpTip from './HelpTip.jsx';

export default function AccountSecurity() {
  const { version } = useAdmin();
  const resource = useResource('/account', version);
  return <><PageHeader eyebrow="账号 / 安全" title="账号与安全" description="维护管理员账号与多个 Passkey。账号 ID 保持稳定，修改用户名不会解除已有 Passkey。" /><Resource resource={resource}>{data => <AccountContent key={data.account.id} data={data} />}</Resource></>;
}

function AccountContent({ data }) {
  const { api, notify, updateAccount, sensitiveAction, requestReauth, authStatus, signedOut, reauthUntil } = useAdmin();
  const [account, setAccount] = useState({ username: data.account.username, display_name: data.account.display_name });
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [modal, setModal] = useState(null);
  const profileMutation = useMutation();
  const passwordMutation = useMutation();
  const verification = useMutation();
  const unsupported = passkeySupport();
  const keys = data.passkeys || [];
  return <><div className="cp-admin-account-summary"><span className="cp-admin-account-avatar"><ShieldCheck size={28} /></span><div><strong>{data.account.display_name}</strong><span>@{data.account.username}</span><small>账号 ID：{data.account.id}</small></div><div className="cp-admin-account-verify"><span>{reauthUntil ? `再次验证有效至 ${fmtTime(reauthUntil)}` : '敏感操作由服务端核验最近验证时间'}</span><button className="cp-admin-button cp-admin-small" disabled={verification.pending} onClick={() => verification.run(async () => { const verified = await requestReauth(); if (!verified) return; })}>再次验证身份</button><HelpTip topic="再次验证身份" label="了解敏感操作的再次身份验证" /></div></div><ErrorNotice error={verification.error} /><div className="cp-admin-two-columns"><Panel title="账号资料" description="登录名可以修改；账号身份和已有 Passkey 绑定保持不变。"><form onSubmit={e => { e.preventDefault(); profileMutation.run(async () => { const result = await sensitiveAction(() => api('/account', { method: 'PATCH', body: account })); updateAccount(result.account); notify('账号资料已更新，已有 Passkey 保持绑定。'); }); }}><div className="cp-admin-auth-fields"><Field label="用户名" hint="3–64 位小写字母、数字、点、下划线或短横线。"><input required autoComplete="username" name="username" pattern={usernamePattern} minLength={3} maxLength={64} value={account.username} onChange={e => setAccount(v => ({ ...v, username: e.target.value }))} autoCapitalize="none" spellCheck={false} /></Field><Field label="显示名称"><input required autoComplete="nickname" name="display-name" maxLength={80} value={account.display_name} onChange={e => setAccount(v => ({ ...v, display_name: e.target.value }))} /></Field></div><ErrorNotice error={profileMutation.error} /><FormActions pending={profileMutation.pending} label="保存账号资料" /></form></Panel><Panel title="修改密码" description="修改后所有管理会话失效，需要重新登录。已有 Passkey 继续有效。"><form onSubmit={e => { e.preventDefault(); const submitted = password; const repeated = confirmation; setPassword(''); setConfirmation(''); passwordMutation.run(async () => { validateNewPassword(submitted, repeated); if (!understood) throw new Error('请确认了解修改密码会退出所有会话。'); await sensitiveAction(() => api('/account/password', { method: 'PUT', body: { new_password: submitted } })); signedOut('密码已修改，所有管理会话已退出。请用新密码或已有 Passkey 重新登录。'); }); }}><input className="cp-admin-sr-only" aria-hidden="true" tabIndex={-1} autoComplete="username" readOnly value={data.account.username} /><div className="cp-admin-auth-fields"><Field label="新密码" hint="12–256 个字符，最多 1024 个 UTF-8 字节；不会去除空格。"><input required type="password" name="new-password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /></Field><Field label="确认新密码"><input required type="password" name="confirm-new-password" autoComplete="new-password" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></Field></div><label className="cp-admin-checkbox cp-admin-password-confirm"><input required type="checkbox" checked={understood} onChange={e => setUnderstood(e.target.checked)} />我了解修改密码将退出所有管理会话</label><HelpTip topic="密码会话确认" label="了解修改密码对所有会话的影响" /><ErrorNotice error={passwordMutation.error} /><FormActions pending={passwordMutation.pending} label="修改密码并退出所有会话" /></form></Panel></div>
    <Panel title="Passkey" description="可登记多个设备或密码管理器。私钥由验证器持有，不会上传到本站。" action={<button className="cp-admin-button cp-admin-primary" disabled={!authStatus?.passkey_available || !!unsupported} onClick={() => setModal({ kind: 'register' })}><Plus />登记 Passkey</button>}>
      {unsupported ? <Notice>{unsupported}仍可使用密码管理账号。</Notice> : !authStatus?.passkey_available && <Notice>本站尚未提供可用的 Passkey 服务。请维护者检查可信 HTTPS 来源与 RP 域名配置；账号密码登录仍可使用。</Notice>}
      {keys.length ? <div className="cp-admin-passkey-list">{keys.map(key => <div key={key.id} className="cp-admin-passkey-row"><span className="cp-admin-device-icon"><Fingerprint size={22} /></span><div className="cp-admin-passkey-info"><strong>{key.name}</strong><small>登记于 {fmtTime(key.created_at)} · 最近使用 {key.last_used_at ? fmtTime(key.last_used_at) : '尚未使用'}</small><span>{key.device_type === 'multiDevice' ? '多设备验证器' : key.device_type === 'singleDevice' ? '单设备验证器' : '验证器类型未提供'} · {key.backed_up ? '验证器报告已备份' : '验证器未报告备份'}</span></div><div className="cp-admin-row-actions"><button className="cp-admin-button cp-admin-small" aria-label={`重命名 Passkey ${key.name}`} onClick={() => setModal({ kind: 'rename', key })}><PencilSimple />重命名</button><button className="cp-admin-button cp-admin-small cp-admin-button-danger" aria-label={`删除 Passkey ${key.name}`} onClick={() => setModal({ kind: 'delete', key })}><Trash />删除</button></div></div>)}</div> : <Empty title="还没有登记 Passkey">登记后可通过本机验证器、安全密钥或受支持的密码管理器登录，由验证器完成本地用户验证。</Empty>}
      <Notice>Passkey 与登记时的域名绑定。在 localhost、其他域名或不同站点创建的 Passkey，不能直接替代本站的登记。保留可用的账号密码作为替代登录方式。</Notice>
    </Panel>
    {modal?.kind === 'register' && <RegisterPasskey onClose={() => setModal(null)} />}
    {modal?.kind === 'rename' && <RenamePasskey passkey={modal.key} onClose={() => setModal(null)} />}
    {modal?.kind === 'delete' && <Confirm title="删除这个 Passkey？" danger label="确认删除 Passkey" onClose={() => setModal(null)} action={async () => { await sensitiveAction(() => api(`/passkeys/${encodeURIComponent(modal.key.id)}`, { method: 'DELETE' })); notify('Passkey 已删除；可继续使用账号密码和其他已登记的 Passkey。'); }}>删除「{modal.key.name}」后，它将无法再登录本站。{keys.length === 1 ? '这是当前最后一个 Passkey；删除后仍可使用账号密码登录。' : '其他已登记的 Passkey 保持可用。'}</Confirm>}
  </>;
}

function RegisterPasskey({ onClose }) {
  const { api, notify, sensitiveAction } = useAdmin();
  const [name, setName] = useState('');
  const [info, setInfo] = useState('');
  const mutation = useMutation();
  return <Dialog title="登记新的 Passkey" onClose={onClose} pending={mutation.pending}><Notice>点击登记后会打开浏览器或操作系统的验证器界面。只在服务端完成验证并保存后，本站才会确认登记成功。</Notice>{info && <div className="cp-admin-flash" role="status">{info}</div>}<form onSubmit={e => { e.preventDefault(); setInfo(''); mutation.run(async () => { const result = await sensitiveAction(() => registerPasskey(api, name), { retry: false }); if (result?.reauthOnly) { setInfo('身份已验证。请再次点击「登记 Passkey」以打开验证器并完成登记。'); return; } if (!result.passkey) throw new Error('服务端未确认 Passkey 登记，请刷新列表后检查。'); notify('新的 Passkey 已通过服务端验证并登记。'); onClose(); }); }}><Field label="Passkey 名称" hint="用于区分不同验证器，例如个人电脑或备用安全密钥。"><input required maxLength={80} value={name} onChange={e => setName(e.target.value)} autoComplete="off" /></Field><ErrorNotice error={mutation.error} /><FormActions pending={mutation.pending} label="登记 Passkey" onCancel={onClose} /></form></Dialog>;
}

function RenamePasskey({ passkey, onClose }) {
  const { api, notify, sensitiveAction } = useAdmin();
  const [name, setName] = useState(passkey.name);
  const mutation = useMutation();
  return <Dialog title="重命名 Passkey" onClose={onClose} pending={mutation.pending}><form onSubmit={e => { e.preventDefault(); mutation.run(async () => { await sensitiveAction(() => api(`/passkeys/${encodeURIComponent(passkey.id)}`, { method: 'PATCH', body: { name } })); notify('Passkey 名称已更新。'); onClose(); }); }}><Field label="Passkey 名称"><input required maxLength={80} value={name} onChange={e => setName(e.target.value)} autoComplete="off" /></Field><ErrorNotice error={mutation.error} /><FormActions pending={mutation.pending} label="保存 Passkey 名称" onCancel={onClose} /></form></Dialog>;
}

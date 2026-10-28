import React, { useEffect, useState } from 'react';
import { Dialog, ErrorNotice, Field, Notice, Panel, Resource, fmtTime, useAdmin, useMutation, useResource } from './shared.jsx';

const labels = { pending_broker: '等待导入与验证', ready: '已验证 · 可分配', assigned: '已分配' };
function downloadCsv(name, csv) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function MqttCredentials() {
  const { api, version, sensitiveAction, notify, refresh } = useAdmin();
  const resource = useResource('/mqtt/pool', version);
  const [count, setCount] = useState(5), [material, setMaterial] = useState(null);
  const [downloaded, setDownloaded] = useState({}), [acknowledged, setAcknowledged] = useState(false);
  const mutation = useMutation();
  useEffect(() => { const clear = () => setMaterial(null); window.addEventListener('pagehide', clear); return () => window.removeEventListener('pagehide', clear); }, []);
  const generate = () => mutation.run(async () => {
    const result = await sensitiveAction(() => api('/mqtt/pool', { method: 'POST', body: { count: Number(count) } }));
    if (!result.material?.authentication_csv || !result.material?.authorization_csv) throw new Error('未收到完整导入材料。请检查凭证池状态，不要自动重复生成。');
    setMaterial(result.material); setDownloaded({}); setAcknowledged(false); refresh();
  });
  return <Panel title="MQTT 设备授权池" description="杭州 EMQX → Cloudflare。每台设备使用独立账号与专属主题授权。">
    <Resource resource={resource}>{data => <>
      <div className="cp-admin-three-values"><div><span>等待导入与验证</span><strong>{data.entries.filter(e => e.state === 'pending_broker').length}</strong></div><div><span>已验证 · 可自动分配</span><strong>{data.ready_count}</strong></div><div><span>已分配设备</span><strong>{data.entries.filter(e => e.state === 'assigned').length}</strong></div></div>
      <p className="cp-admin-mono">{data.broker_uri}</p>
      <Notice>先生成一批授权，下载两份私密 CSV。在 EMQX“客户端认证”导入认证文件，并在“客户端授权 → 用户名”导入授权文件，然后回到这里验证。不要在客户端 ID 视图导入用户名文件。只有通过实际连接与专属主题验证的账号才可登记设备；后续登记自动分配，无需逐台建号。</Notice>
      <div className="cp-admin-row-actions"><Field label="本批独立账号数量（1–32）"><input type="number" min={1} max={32} step={1} value={count} onChange={e => setCount(e.target.value)} /></Field><button className="cp-admin-button" disabled={mutation.pending || !!material || !Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 32} onClick={generate}>生成私密批量导入材料</button></div>
      {!!data.entries.length && <div className="cp-admin-table-scroll"><table><thead><tr><th>授权记录</th><th>状态</th><th>设备</th><th>MQTT 服务器验证</th><th>操作</th></tr></thead><tbody>{data.entries.map(entry => <tr key={entry.id}><td className="cp-admin-mono">{entry.id}</td><td>{labels[entry.state] || '未知'}</td><td>{entry.node_id || '待分配'}</td><td>{entry.verification_error ? '验证未通过，请检查两份导入和MQTT 服务器配置' : fmtTime(entry.verified_at)}</td><td>{entry.state === 'pending_broker' && <button className="cp-admin-button" disabled={mutation.pending} onClick={() => mutation.run(async () => { await sensitiveAction(() => api(`/mqtt/pool/${encodeURIComponent(entry.id)}/verify`, { method: 'POST', body: {} })); notify('此授权已通过MQTT 服务器验证，可用于设备登记。'); })}>已导入，验证此授权</button>}</td></tr>)}</tbody></table></div>}
    </>}</Resource>
    <ErrorNotice error={mutation.error} />
    {material && <Dialog title="一次性私密 MQTT 批量导入材料" onClose={() => setMaterial(null)}>
      <Notice>认证 CSV 含独立账号密码，授权 CSV 含专属主题。仅导入当前杭州 EMQX 实例；勿上传源码、聊天或截图。关闭后无法再次下载本批原始材料。</Notice>
      <div className="cp-admin-row-actions">{[['authentication_csv', '认证 CSV', 'campuspulse-emqx-authentication.csv'], ['authorization_csv', '授权 CSV', 'campuspulse-emqx-authorization.csv']].map(([key, label, name]) => <button key={key} className="cp-admin-button" onClick={() => { downloadCsv(name, material[key]); setDownloaded(v => ({ ...v, [key]: true })); }}>下载{label}{downloaded[key] ? '（已请求下载）' : ''}</button>)}</div>
      <p>在 EMQX 的认证与授权页面分别导入两份 CSV。导入结果仍需回到此页实际验证；文件生成和下载不代表MQTT 服务器已配置。</p>
      <label className="cp-admin-checkbox"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />我已安全保存两份材料，或明确放弃本批材料。</label>
      <button className="cp-admin-button cp-admin-primary" disabled={!acknowledged} onClick={() => setMaterial(null)}>关闭并清除本次材料</button>
    </Dialog>}
  </Panel>;
}

import React, { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { CircleNotch, WarningCircle, X, ArrowClockwise } from '@phosphor-icons/react';

export const AdminContext = createContext(null);
export const useAdmin = () => useContext(AdminContext);
const FieldContext = createContext(null);
function labelControls(children, field) {
  if (!field) return children;
  return React.Children.map(children, child => {
    if (!React.isValidElement(child) || !['input', 'select', 'textarea'].includes(child.type)) return child;
    return React.cloneElement(child, {
      id: field.controlId,
      ...(child.props['aria-label'] ? {} : { 'aria-labelledby': field.labelId }),
      ...(field.hintId ? { 'aria-describedby': [child.props['aria-describedby'], field.hintId].filter(Boolean).join(' ') } : {}),
    });
  });
}

export function useResource(path, version = 0) {
  const { api } = useAdmin();
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ data: null, loading: true, error: null });
    api(path).then(data => { if (active) setState({ data, loading: false, error: null }); })
      .catch(error => { if (active) setState({ data: null, loading: false, error }); });
    return () => { active = false; };
  }, [path, version, retry, api]);
  return { ...state, retry: () => setRetry(n => n + 1) };
}

/** Keep directory search honest when the API returns a bounded page. */
export function useDevices(version = 0) {
  const { api } = useAdmin();
  const resource = useResource('/devices', version);
  const [extra, setExtra] = useState(null);
  const mutation = useMutation();
  const current = useRef(resource.data);
  current.current = resource.data;
  const matches = extra?.base === resource.data;
  const data = resource.data ? { ...resource.data, devices: [...resource.data.devices, ...(matches ? extra.devices : [])], next_cursor: matches ? extra.next : resource.data.next_cursor } : null;
  const loadMore = () => mutation.run(async () => {
    const base = resource.data;
    const result = await api(`/devices?after=${encodeURIComponent(data.next_cursor)}`);
    if (current.current !== base) return;
    setExtra(old => ({ base, devices: [...(old?.base === base ? old.devices : []), ...result.devices], next: result.next_cursor }));
  });
  return { ...resource, data, loadMore, loadingMore: mutation.pending, moreError: mutation.error };
}
export function DirectoryMore({ resource }) {
  return <><ErrorNotice error={resource.moreError} />{resource.data?.next_cursor && <div className="cp-admin-directory-more"><span>已加载 {resource.data.devices.length} 台。搜索和选择仅涵盖已加载设备。</span><button type="button" className="cp-admin-button cp-admin-small" disabled={resource.loadingMore} onClick={resource.loadMore}>{resource.loadingMore ? '正在加载…' : '加载更多设备'}</button></div>}</>;
}

export function useMutation() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const busy = useRef(false);
  async function run(action) {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(null);
    try { return await action(); }
    catch (e) { setError(e); }
    finally { busy.current = false; setPending(false); }
  }
  return { pending, error, run, clearError: () => setError(null) };
}

export function ErrorNotice({ error, retry }) {
  if (!error) return null;
  return <div className="cp-admin-notice cp-admin-error" role="alert"><WarningCircle size={20} /><div><strong>操作未完成</strong><p>{error.message || '无法连接服务，请稍后重试。'}</p>{error.code && <small>错误代码：{error.code}</small>}</div>{retry && <button className="cp-admin-button cp-admin-small" type="button" onClick={retry}><ArrowClockwise />重试</button>}</div>;
}
export function Loading({ label = '正在加载数据…' }) { return <div className="cp-admin-loading" role="status"><CircleNotch className="cp-admin-spin" size={23} />{label}</div>; }
export function Resource({ resource, children }) {
  const field = useContext(FieldContext);
  if (resource.loading) return <Loading />;
  if (resource.error) return <ErrorNotice error={resource.error} retry={resource.retry} />;
  return labelControls(children(resource.data), field);
}
export function Empty({ title = '暂无数据', children }) { return <div className="cp-admin-empty"><h3>{title}</h3>{children && <p>{children}</p>}</div>; }
export function Field({ label, hint, children, className = '' }) {
  const id = useId();
  const field = { controlId: `${id}-control`, labelId: `${id}-label`, hintId: hint ? `${id}-hint` : null };
  return <FieldContext.Provider value={field}><div className={`cp-admin-field ${className}`}><label id={field.labelId} htmlFor={field.controlId}>{label}</label>{labelControls(children, field)}{hint && <small id={field.hintId}>{hint}</small>}</div></FieldContext.Provider>;
}
export function Notice({ children }) { return <div className="cp-admin-notice"><WarningCircle size={20} /><div>{children}</div></div>; }
export function PageHeader({ eyebrow, title, description, children }) { return <header className="cp-admin-page-header"><div><div className="cp-admin-eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="cp-admin-actions">{children}</div>}</header>; }
export function Panel({ title, description, children, className = '', action }) { return <section className={`cp-admin-panel ${className}`}>{title && <div className="cp-admin-panel-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>}{children}</section>; }
export function FormActions({ pending, label = '保存', onCancel }) { return <div className="cp-admin-form-actions">{onCancel && <button type="button" className="cp-admin-button" onClick={onCancel} disabled={pending}>取消</button>}<button type="submit" className="cp-admin-button cp-admin-primary" disabled={pending}>{pending && <CircleNotch className="cp-admin-spin" />}{pending ? '正在处理…' : label}</button></div>; }

export function Dialog({ title, children, onClose, pending = false, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className={`cp-admin-dialog ${wide ? 'cp-admin-dialog-wide' : ''}`} aria-label={title} onCancel={e => { e.preventDefault(); if (!pending) onClose(); }}><div className="cp-admin-dialog-head"><h2>{title}</h2><button type="button" className="cp-admin-icon-button" aria-label="关闭对话框" onClick={onClose} disabled={pending}><X size={22} /></button></div><div className="cp-admin-dialog-body">{children}</div></dialog>;
}
export function Confirm({ title, children, label = '确认', danger = false, action, onClose }) {
  const mutation = useMutation();
  return <Dialog title={title} onClose={onClose} pending={mutation.pending}><p className="cp-admin-confirm-copy">{children}</p><ErrorNotice error={mutation.error} /><div className="cp-admin-form-actions"><button className="cp-admin-button" onClick={onClose} disabled={mutation.pending}>取消</button><button className={`cp-admin-button ${danger ? 'cp-admin-danger' : 'cp-admin-primary'}`} disabled={mutation.pending} onClick={() => mutation.run(async () => { await action(); onClose(); })}>{mutation.pending ? '正在处理…' : label}</button></div></Dialog>;
}

const states = { recent: ['最近有回执', 'green'], stale: ['联系已过期', 'amber'], unknown: ['尚无回执', 'gray'], disabled: ['已停用', 'gray'], unassigned: ['未分配', 'gray'], pending: ['等待设备', 'amber'], reported: ['批次已引用', 'blue'], applied: ['设备确认应用', 'green'], failed: ['设备报告失败', 'red'] };
export function Badge({ state, children }) { const [label, color] = states[state] || [state || '未知', 'gray']; return <span className={`cp-admin-badge cp-admin-badge-${color}`}>{children || label}</span>; }
export const fmtTime = value => value === null || value === undefined || value === '' ? '尚未上报' : Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间不可用';
export const fmtNumber = value => value === null || value === undefined ? '未上报' : Number(value).toLocaleString('zh-CN');
export function fmtBytes(value) { if (value === null || value === undefined) return '未上报'; if (value < 1024) return `${value} B`; if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`; return `${(value / 1048576).toFixed(1)} MB`; }
export const idPattern = '[a-z0-9_-]{1,64}';
export function localTime(value = Date.now()) { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
export function Metric({ label, value, hint }) { return <div className="cp-admin-metric"><span>{label}</span><strong>{value ?? '—'}</strong>{hint && <small>{hint}</small>}</div>; }
export function KeyValues({ entries }) { return <dl className="cp-admin-key-values">{entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value ?? '未上报'}</dd></div>)}</dl>; }

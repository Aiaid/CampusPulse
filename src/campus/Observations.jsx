import { useEffect, useRef, useState } from 'react';
import { Check, Clock, Info, Plus, Radio, ArrowClockwise, X } from '@phosphor-icons/react';
import { latestManualObservations, recordFreshness } from './field-data.js';
import { useFieldSession } from './use-field-session.js';
import { formatObservationKinds, observationKinds, observationKindLabels } from '../shared/observation-kinds.js';
import './observations.css';

const stamp = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
async function request(path, init) {
  const response = await fetch(`/api/v1${path}`, init);
  if (!response.ok) {
    let message = '';
    try { const body = await response.json(); message = typeof body.error === 'string' ? body.error : body.error?.message || ''; } catch { /* Fall back to the response status. */ }
    throw new Error(message || `请求失败（${response.status}）`);
  }
  return response.json();
}
const recordText = record => record.kind === 'parking' ? `${record.parking_min}–${record.parking_max} 辆` : `${record.wait_seconds} 秒`;

export default function Observations({ open, onClose, initialPlaceId, catalog, onCatalogRefresh, sharedSession, sharedPlaceId, sharedMinutes }) {
  const places = catalog.places;
  const [placeId, setPlaceId] = useState('');
  const [minutes, setMinutes] = useState(15);
  const [token, setToken] = useState(''), [low, setLow] = useState(''), [high, setHigh] = useState(''), [wait, setWait] = useState('');
  const [saving, setSaving] = useState(false), [notice, setNotice] = useState('');
  const [chosenKind, setChosenKind] = useState('');
  // The map already owns live and timeline reads for its selected place. Its
  // >=15-minute history also covers each record-form range; filter locally.
  const sharesSession = placeId === sharedPlaceId && sharedMinutes >= minutes;
  const ownSession = useFieldSession(placeId, open && !sharesSession, minutes);
  const session = sharesSession ? sharedSession : ownSession;
  const summary = session.live.data, now = session.now;
  const historyData = session.history.data;
  const cutoff = historyData ? Date.parse(historyData.to) - minutes * 60_000 : 0;
  const history = historyData?.observations.filter(record => Date.parse(record.observed_at) >= cutoff) || [];
  const loading = session.live.loading || session.history.loading;
  const error = catalog.error || session.live.error || session.history.error;
  const pendingWrite = useRef(null), dialog = useRef(null);
  const place = places.find(item => item.id === placeId);
  const manualKinds = observationKinds(place).filter(kind => kind !== 'activity');
  const recordKind = manualKinds.includes(chosenKind) ? chosenKind : manualKinds[0] || '';
  const latestByKind = latestManualObservations(summary);
  const latest = latestByKind[recordKind];
  const displayedKinds = [...new Set([...manualKinds, ...Object.keys(latestByKind).filter(kind => latestByKind[kind])])];
  const canRecord = !!recordKind;

  useEffect(() => {
    // Capture the map selection on opening. A later background map refresh
    // must not overwrite a location the operator has chosen in this dialog.
    if (open && initialPlaceId) setPlaceId(initialPlaceId);
  }, [open]);

  useEffect(() => {
    if (!open || !places.length) return;
    setPlaceId(current => places.some(item => item.id === current) ? current : places[0]?.id || '');
  }, [open, places]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const element = dialog.current;
    element?.querySelector('button')?.focus();
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...element.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')].filter(item => item.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    element?.addEventListener('keydown', keydown);
    return () => { element?.removeEventListener('keydown', keydown); if (previous instanceof HTMLElement) previous.focus(); };
  }, [open, onClose]);

  const submit = async event => {
    event.preventDefault();
    if (!canRecord) return;
    const values = { place_id: placeId, kind: recordKind, ...(recordKind === 'parking' ? { parking_min: Number(low), parking_max: Number(high) } : { wait_seconds: Number(wait) }) };
    const key = JSON.stringify(values);
    if (pendingWrite.current?.key !== key) pendingWrite.current = { key, body: JSON.stringify({ ...values, id: crypto.randomUUID(), observed_at: new Date().toISOString() }) };
    setSaving(true); setNotice('');
    try {
      const receipt = await request('/observations', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: pendingWrite.current.body });
      if (receipt.durability !== 'committed' || receipt.observation?.id !== JSON.parse(pendingWrite.current.body).id) throw new Error('服务端尚未确认持久保存');
      pendingWrite.current = null; setNotice('记录已获服务端确认'); session.refresh({ afterPending: true });
    } catch (problem) { setNotice(`${problem.message} · 可重试同一条记录。`); }
    finally { setSaving(false); }
  };
  const cancel = async () => {
    if (!latest || !token) return;
    setSaving(true); setNotice('');
    try {
      const receipt = await request(`/observations/${encodeURIComponent(latest.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (receipt.durability !== 'committed' || receipt.observation?.status !== 'cancelled') throw new Error('服务端尚未确认撤销');
      setNotice('记录已撤销，服务端已确认'); session.refresh({ afterPending: true });
    } catch (problem) { setNotice(problem.message); }
    finally { setSaving(false); }
  };

  if (!open) return null;
  return <div className="modal-backdrop observation-backdrop">
    <section className="observation-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="observations-title">
      <div className="observation-title"><div><span className="observation-eyebrow"><Radio size={12} />现场数据 · 独立记录流</span><h2 id="observations-title">现场观察与记录</h2></div><button className="icon-button" aria-label="关闭记录表单" onClick={onClose}><X size={21} /></button></div>
      <p className="observation-boundary"><Info size={15} /><span>此目录包含全部现场地点；地图仅显示已核验且位于当前视图范围内的 GIS 锚点。人工记录不代表传感器覆盖，BLE 可见标识不等于人数。</span></p>
      <label className="observation-field">记录地点<select aria-label="记录地点" value={placeId} onChange={event => { setPlaceId(event.target.value); setNotice(''); }} disabled={saving || !places.length}>{!places.length && <option value="">等待现场服务</option>}{places.map(item => <option key={item.id} value={item.id}>{item.name} · {formatObservationKinds(item)}</option>)}</select></label>
      <div className="observation-section-heading"><h3>{place?.name || '现场观察'}</h3><button className="observation-refresh" onClick={() => { session.refresh(); onCatalogRefresh(); }} disabled={loading || saving} aria-label="刷新现场观察"><ArrowClockwise size={14} />刷新</button></div>
      {error && <p className="observation-error" role="status">{error}</p>}
      <div className="observation-summary" aria-live="polite">
        {loading ? <p>正在读取服务端记录…</p> : error ? <strong>现场数据不可用</strong> : displayedKinds.length ? displayedKinds.map(kind => {
          const record = latestByKind[kind], fresh = recordFreshness(record, now) === 'fresh';
          return <article className="observation-purpose" key={kind} aria-label={`${observationKindLabels[kind]} · 最新人工记录`}>
            <h4>{observationKindLabels[kind]}</h4>
            {record ? <><div className="observation-value"><strong>{recordText(record)}</strong><span className={fresh ? 'record-fresh' : 'record-stale'}>{fresh ? '有效观察' : '历史观察'}</span></div><p>来源：人工现场记录 · {kind === 'parking' ? '数量范围' : '本次已完成候梯时长，不是当前预测'}</p><p>观测于 {stamp(record.observed_at)}<br />有效至 {stamp(record.valid_until)}（北京时间）</p></> : <p>暂无人工现场记录；空白不表示无人或空闲。</p>}
          </article>;
        }) : <><strong>暂无人工现场记录</strong><p>设备窗口请在地图地点详情查看；空白不表示无人或空闲。</p></>}
        {summary && <small>服务端状态时间 {stamp(summary.as_of)} · 最新观察每 30 秒、历史每 2 分钟刷新</small>}
      </div>
      <div className="observation-history-heading"><span><Clock size={13} />最近记录</span><div role="group" aria-label="现场记录时间范围">{[1, 5, 15].map(value => <button key={value} className={minutes === value ? 'active' : ''} aria-pressed={minutes === value} onClick={() => setMinutes(value)}>近 {value} 分钟</button>)}</div></div>
      <div className="observation-history">{!history.length ? <p>所选时段暂无可展示记录</p> : history.map(record => <div key={record.id}><span>{stamp(record.observed_at)}<small>{observationKindLabels[record.kind]} · 人工记录{record.status === 'cancelled' ? ' · 已撤销' : ''}</small></span><strong>{recordText(record)}</strong></div>)}</div>
      {canRecord ? <form className="record-form" onSubmit={submit}>
        <h3><Plus size={16} />添加现场记录</h3>
        <p className="observation-help">服务端确认后才会显示。网络失败后重试会沿用同一记录编号。</p>
        <label className="observation-field">记录类型<select aria-label="记录类型" disabled={saving || manualKinds.length === 1} value={recordKind} onChange={event => { setChosenKind(event.target.value); setNotice(''); }}>{manualKinds.map(kind => <option key={kind} value={kind}>{kind === 'parking' ? '停车数量范围' : '已完成候梯时长'}</option>)}</select></label>
        {recordKind === 'parking' ? <div className="observation-columns"><label className="observation-field">最少（辆）<input type="number" required min="0" max="10000" value={low} disabled={saving} onChange={event => setLow(event.target.value)} /></label><label className="observation-field">最多（辆）<input type="number" required min={low || 0} max="10000" value={high} disabled={saving} onChange={event => setHigh(event.target.value)} /></label></div> : <label className="observation-field">本次实测等待（秒）<input type="number" required min="0" max="7200" value={wait} disabled={saving} onChange={event => setWait(event.target.value)} /></label>}
        <label className="observation-field">操作员凭据<input type="password" required autoComplete="off" value={token} disabled={saving} onChange={event => setToken(event.target.value)} placeholder="由项目管理员提供" /></label>
        <p className="observation-help">凭据仅保留在当前页面内存中，不写入本地存储。</p>
        {notice && <p className="observation-notice" role="status"><Check size={14} />{notice}</p>}
        <button className="primary-button" disabled={saving} type="submit">{saving ? '等待服务端确认…' : '提交并确认'}</button>
        {latest && <button className="cancel-record" disabled={saving || !token} type="button" onClick={cancel}>撤销最近一条{observationKindLabels[recordKind]}记录</button>}
      </form> : <p className="observation-help">此地点仅供活动观察。请选择停车点或候梯区，添加人工记录。</p>}
      <p className="observation-source-note">这里只显示现场 API 返回的记录，不使用合成演示数据补齐。</p>
    </section>
  </div>;
}

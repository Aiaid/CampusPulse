import { useEffect, useState } from 'react';
import './elevator-events.css';

const states = {
  warming_up: ['正在积累观测', '需要一段连续、完整的观测，才能判断哪些标识此前稳定出现。'],
  observing: ['规则观测中', '候选事件来自现场蓝牙摘要，仍需与电梯开关门或上梯记录对照。'],
  degraded: ['观测暂不完整', '扫描或上传数据不完整，暂不使用缺席数据确认新的事件。'],
  unavailable: ['暂无可用观测', '还没有可用于此规则的现场数据，空白不表示没有人或没有电梯服务。'],
  stale: ['观测已过期', '以下内容只作历史参考，当前状态需要新的现场数据。'],
};
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const stamp = value => new Date(value).toLocaleString('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function validResponse(body, placeId) {
  return body && body.place_id === placeId && Object.hasOwn(states, body.status) &&
    timestamp(body.as_of) && (body.data_until === null || timestamp(body.data_until)) &&
    (body.valid_until === null || timestamp(body.valid_until)) &&
    typeof body.rule_version === 'string' && typeof body.truncated === 'boolean' &&
    Array.isArray(body.events) && body.events.length <= 200 && body.events.every(event =>
      typeof event.id === 'string' && timestamp(event.event_from) && timestamp(event.event_to) &&
      timestamp(event.confirmed_at) && Date.parse(event.event_from) <= Date.parse(event.event_to) &&
      Date.parse(event.event_to) <= Date.parse(event.confirmed_at) &&
      Number.isSafeInteger(event.baseline_identifiers) && event.baseline_identifiers > 0 &&
      Number.isSafeInteger(event.lost_identifiers) && event.lost_identifiers > 0 &&
      event.lost_identifiers <= event.baseline_identifiers &&
      Number.isFinite(event.lost_fraction) && event.lost_fraction > 0 && event.lost_fraction <= 1 &&
      event.verification === 'unverified' && typeof event.reappearance_flag === 'boolean' &&
      Number.isSafeInteger(event.reappeared_identifiers) && event.reappeared_identifiers >= 0 &&
      event.reappeared_identifiers <= event.lost_identifiers);
}

export default function ElevatorEvents({ open, placeId, revision }) {
  const [state, setState] = useState(null);
  const requestKey = `${placeId}:${revision}`;

  useEffect(() => {
    if (!open || !placeId) return;
    const controller = new AbortController();
    let disposed = false;
    setState({ key: requestKey, loading: true });
    const load = async () => {
      try {
        const response = await fetch(`/api/v1/places/${encodeURIComponent(placeId)}/elevator-events`, {
          signal: controller.signal, cache: 'no-store',
        });
        if (!response.ok) throw new Error('events_unavailable');
        const data = await response.json();
        if (!validResponse(data, placeId)) throw new Error('invalid_events_response');
        if (!disposed) setState({ key: requestKey, data, loading: false });
      } catch (problem) {
        if (!disposed && problem.name !== 'AbortError') {
          setState({ key: requestKey, error: true, loading: false });
        }
      }
    };
    load();
    return () => { disposed = true; controller.abort(); };
  }, [open, placeId, revision, requestKey]);

  if (!open || !placeId) return null;
  // Do not render a previous place or revision while the new effect starts.
  const current = state?.key === requestKey ? state : null;
  const data = current?.data;
  const expired = data?.valid_until && Date.parse(data.valid_until) <= Date.now();
  const status = data && expired && data.status === 'observing' ? 'stale' : data?.status;
  const [label, explanation] = states[status] || [];
  const delaySeconds = data?.data_until ? Math.max(0, Math.floor((Date.now() - Date.parse(data.data_until)) / 1000)) : null;

  return <section className="elevator-events" aria-label="候梯区群体消失事件">
    <div className="elevator-events-heading"><h3>候梯区 · 群体消失候选</h3><span>现场规则推断</span></div>
    <p className="elevator-events-background">一批此前稳定可见的蓝牙标识，如果在接近的时刻一起消失，可能与进入电梯有关。规则会等待持续缺席，并检查扫描与数据完整性。</p>
    <p className="elevator-events-boundary">走出大厅、遮挡或地址变化也可能产生类似现象。标识数不等于人数，这里不预测候梯秒数。</p>
    <div className="elevator-events-state" aria-live="polite" aria-atomic="true">
      {!current || current.loading ? <p>正在读取候梯区现场事件…</p> : current.error ? <p className="elevator-events-error">事件暂时读取失败，请使用上方“刷新”重试。未使用模拟数据替代。</p> : <>
        <strong className={`elevator-events-status elevator-events-status-${status}`}>{label}</strong>
        <p>{explanation}</p>
        {data.data_until ? <p className="elevator-events-timing">数据截至 <time dateTime={data.data_until}>{stamp(data.data_until)}</time><br />距离数据时间约 {delaySeconds} 秒{data.valid_until && <> · 有效至 <time dateTime={data.valid_until}>{stamp(data.valid_until)}</time></>}</p> : <p className="elevator-events-timing">尚无可用数据时间。</p>}
      </>}
    </div>
    {data && <>
      <h4 className="elevator-events-timeline-title">最近候选事件</h4>
      {data.events.length ? <ol className="elevator-events-timeline">{data.events.map(event => <li key={event.id}>
        <div className="elevator-events-event-heading"><strong>{event.lost_identifiers} 个标识集中消失</strong><span>尚未现场核实</span></div>
        <p><time dateTime={event.event_from}>{stamp(event.event_from)}</time> 至 <time dateTime={event.event_to}>{stamp(event.event_to)}</time><br /><small>最后可见时间区间 · 不代表电梯确切离开时刻</small></p>
        <p>此前稳定标识 {event.baseline_identifiers} 个 · 消失比例约 {Math.round(event.lost_fraction * 100)}%</p>
        <p className="elevator-events-confirmation">规则确认于 <time dateTime={event.confirmed_at}>{stamp(event.confirmed_at)}</time>，已满足连续缺席条件。</p>
        {event.reappearance_flag && <p className="elevator-events-return">确认后有 {event.reappeared_identifiers} 个标识短时回返，需留意间歇广播或遮挡。</p>}
      </li>)}</ol> : <p className="elevator-events-empty">{status === 'observing' ? '近期未检测到满足规则的群体消失候选。' : '当前没有可展示的候选事件；请先查看上方的数据状态。'}</p>}
      {data.truncated && <p className="elevator-events-boundary">只展示有限范围内的近期结果，不代表完整事件历史。</p>}
      <p className="elevator-events-footnote">数据来源：现场 BLE 摘要 · 每 30 秒刷新。分桶、闭合窗口上传和缺席确认会增加延迟。<br />规则版本：{data.rule_version} · 服务端计算于 <time dateTime={data.as_of}>{stamp(data.as_of)}</time></p>
    </>}
  </section>;
}

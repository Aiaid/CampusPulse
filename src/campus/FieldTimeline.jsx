import React, { useId } from 'react';
import { Clock, Radio } from '@phosphor-icons/react';
import { formatTimelineTime, recordsAtTime, timelineBounds, timelineMarks, timelineTicks, timePosition } from './field-timeline.js';
import { observationKindLabels } from '../shared/observation-kinds.js';
import './field-timeline.css';

const recordDetail = record => record.source === 'sensor'
  ? `传感器 ${record.node_id} · ${record.visible_identifiers} 个 BLE 可见标识 · ${formatTimelineTime(Date.parse(record.observed_at) - record.duration_ms, { seconds: true })}—${formatTimelineTime(Date.parse(record.observed_at), { seconds: true })}（北京时间）`
  : `${observationKindLabels[record.kind]} · 人工记录 · ${formatTimelineTime(Date.parse(record.observed_at), { seconds: true })}（北京时间） · ${record.kind === 'parking' ? `${record.parking_min}–${record.parking_max} 辆` : `${record.wait_seconds} 秒已完成候梯`}`;

/**
 * Controlled public-field timeline. history is normalized history or null;
 * now/cursor are epoch milliseconds, cursor=null pins the live right edge.
 * onSeek(ms) selects history; onLive() restores live. Optional minutes and
 * onRangeChange(minutes) control the compact 15m/1h/24h query-range select.
 * No fetch or scene values.
 */
export default function FieldTimeline({ history = null, now = Date.now(), cursor = null, onSeek, onLive, minutes = 1440, onRangeChange, loading = false, error = '', className = '' }) {
  const descriptionId = useId();
  // An empty axis still has the requested time extent; no records are created.
  const emptyRange = { from: new Date(now - minutes * 60_000).toISOString(), to: new Date(now).toISOString() };
  const bounds = timelineBounds(history || emptyRange, now);
  const live = cursor === null;
  const selectedTime = live ? bounds.to : cursor;
  const clampedTime = Math.min(bounds.to, Math.max(bounds.from, Number.isFinite(selectedTime) ? selectedTime : bounds.to));
  // Failed reads cannot retain a misleading coverage visualization.
  const records = error ? [] : history?.records || [];
  const marks = timelineMarks(records, bounds);
  const coverage = recordsAtTime(records, selectedTime);
  const outOfRange = !live && (selectedTime < bounds.from || selectedTime > bounds.to);
  const position = timePosition(clampedTime, bounds);
  const seek = value => { if (Number.isFinite(value)) onSeek?.(Math.min(bounds.to, Math.max(bounds.from, value))); };
  const status = error ? `时间轴读取失败：${error}` : loading && !history ? '正在读取现场时间轴…' : live ? '正在跟随最新已上传观察；每 30 秒刷新，非连续视频。' : outOfRange ? '所选时刻已超出当前查询区间，请重新选择时间。' : !coverage.hasRecording ? '此刻没有已返回的记录覆盖；空白不表示无人或空闲。' : `此刻覆盖：${coverage.sensors.length} 个传感器窗口、${coverage.manual.length} 类有效人工结果${coverage.manual.length ? `（${coverage.manual.map(record => observationKindLabels[record.kind]).join('、')}）` : ''}。`;

  return <section className={`field-timeline ${className}`} aria-label="现场数据连续时间轴">
    <div className="field-timeline-heading"><div className="field-timeline-selected">{live ? <Radio size={14} /> : <Clock size={14} />}<span><strong>{live ? '实时' : '回看'}</strong><time dateTime={new Date(clampedTime).toISOString()}>{formatTimelineTime(clampedTime, { date: true, seconds: true })}<small>北京</small></time></span></div><div className="field-timeline-controls">{onRangeChange && <select value={minutes} onChange={event => onRangeChange(Number(event.target.value))} aria-label="现场时间范围"><option value={15}>15 分钟</option><option value={60}>1 小时</option><option value={1440}>24 小时</option></select>}<button type="button" className="field-timeline-live" aria-pressed={live} onClick={() => onLive?.()}><span />返回实时</button></div></div>
    <div className="field-timeline-axis">
      <div className="field-timeline-rail" onPointerDown={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width) seek(bounds.from + (event.clientX - rect.left) / rect.width * (bounds.to - bounds.from));
      }}>
        <div className="field-timeline-lane sensor" aria-hidden="true" /><div className="field-timeline-lane manual" aria-hidden="true" />
        {marks.map(mark => <button type="button" key={mark.key} className={`field-timeline-mark ${mark.source}`} style={{ left: `${mark.position}%`, ...(mark.source === 'sensor' ? { width: `${mark.width}%` } : {}) }} onClick={() => seek(Date.parse(mark.record.observed_at))} title={recordDetail(mark.record)} aria-label={recordDetail(mark.record)} />)}
        <span className={`field-timeline-cursor ${live ? 'live' : ''}`} style={{ left: `${position}%` }} aria-hidden="true"><span /></span>
      </div>
      <input className="field-timeline-slider" type="range" min={bounds.from} max={bounds.to} step={1000} value={clampedTime} aria-label="现场数据时间轴" aria-valuetext={`${live ? '实时' : '历史回看'} ${formatTimelineTime(clampedTime, { date: true, seconds: true })} 北京时间`} aria-describedby={descriptionId} onChange={event => seek(Number(event.target.value))} />
      <div className="field-timeline-ticks" aria-hidden="true">{timelineTicks(bounds).map((time, index) => <time key={`${time}:${index}`} dateTime={new Date(time).toISOString()}>{formatTimelineTime(time)}</time>)}</div>
    </div>
    <div className="field-timeline-meta"><span><i className="sensor" />传感器窗口</span><span><i className="manual" />人工记录</span><span>北京时间 · 拖动回看</span></div>
    <p id={descriptionId} className={`field-timeline-status ${error ? 'error' : !coverage.hasRecording || outOfRange ? 'gap' : ''}`} role={error ? 'alert' : 'status'}>{status}</p>
    {(history?.truncated || history?.sensor_truncated) && <p className="field-timeline-warning" role="status">历史结果已截断：{[history.sensor_truncated && '传感器', history.truncated && '人工'].filter(Boolean).join('、')}仅返回最近 200 条。时间轴不是完整录制，缺口也可能来自查询或保留限制。</p>}
  </section>;
}

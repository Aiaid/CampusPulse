import React, { useId } from 'react';
import { Clock, Play, Pause } from '@phosphor-icons/react';
import { controlledReplayBounds, formatReplayTime } from './controlled-replay-data';
import './controlled-replay.css';

export default function ControlledReplayTimeline({ session }) {
  const { data, selectedWindow, index, seek, playing, togglePlaying, loading, error } = session;
  const descriptionId = useId();
  const bounds = controlledReplayBounds(data);
  if (!data || !bounds) return <section className="controlled-replay-timeline" aria-label="历史采集固定时间轴"><p role="status">{error ? '历史采集时间轴不可用' : loading ? '正在读取原始采集时间范围…' : '尚无历史采集时间轴'}</p><p>仅显示原始源范围，不延伸到当前时间。</p></section>;
  const maxReports = Math.max(1, ...data.windows.map(entry => entry.item.reports.worker));
  const duration = bounds.to - bounds.from;
  const selectedPosition = duration > 0 ? (selectedWindow.source_start_mono_us - bounds.from) / duration * 100 : 0;
  return <section className="controlled-replay-timeline" aria-label="历史采集固定时间轴">
    <div className="controlled-replay-timeline-heading"><Clock size={16} /><strong>原始采集全程</strong><span>窗口 {index + 1} / {data.windows.length}</span><button type="button" disabled={data.windows.length < 2} className="controlled-replay-play" aria-label={playing ? '暂停历史采集回放' : '播放全部历史采集窗口'} aria-pressed={playing} onClick={togglePlaying}>{playing ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}{playing ? '暂停' : '播放'}</button></div>
    <div className="controlled-replay-extent" aria-hidden="true">{data.windows.map((entry, windowIndex) => <span key={entry.item.seq} className={windowIndex === index ? 'selected' : ''} style={{ left: `${(entry.source_start_mono_us - bounds.from) / duration * 100}%`, width: `${entry.item.duration_ms * 1000 / duration * 100}%`, height: `${Math.max(8, entry.item.reports.worker / maxReports * 100)}%` }} />)}<i style={{ left: `${selectedPosition}%` }} /></div>
    <input type="range" min="0" max={data.windows.length - 1} step="1" value={index} disabled={data.windows.length < 2} onChange={event => seek(Number(event.target.value))} aria-label="历史采集窗口" aria-valuetext={`窗口 ${index + 1} / ${data.windows.length}，${formatReplayTime(selectedWindow, 'end', data)}`} aria-describedby={descriptionId} />
    <div className="controlled-replay-ticks"><span>{formatReplayTime(data.windows[0], 'start', data)}</span><span>{formatReplayTime(data.windows.at(-1), 'end', data)}</span></div>
    <p id={descriptionId} className="controlled-replay-timeline-note">拖动逐窗查看 · 柱高为聚合报告数 · 全程 {(duration / 60_000_000).toFixed(2)} 分钟 · {data.source_metadata.replayed_reports.toLocaleString('zh-CN')} 条报告 · {playing ? '每秒前进一个源窗口' : '固定历史范围，非当前现场'}</p>
  </section>;
}

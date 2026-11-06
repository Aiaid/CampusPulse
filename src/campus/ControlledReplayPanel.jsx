import React from 'react';
import { ArrowClockwise, Clock } from '@phosphor-icons/react';
import { formatReplayTime, replayQualityLabels } from './controlled-replay-data';
import './controlled-replay.css';

const number = value => value.toLocaleString('zh-CN');
const digest = value => `${value.slice(0, 12)}…${value.slice(-8)}`;

export default function ControlledReplayPanel({ session, anchor = null }) {
  const { data, selectedWindow: entry, index, loading, error, unauthorized, refresh } = session;
  if (!data || !entry) return <section className="controlled-replay-panel" aria-label="管理员历史采集回放">
    <h2><Clock size={17} />历史采集回放</h2>
    <p role={error ? 'alert' : 'status'}>{error || (loading ? '正在读取管理员受控回放…' : '尚未载入历史采集数据')}</p>
    {unauthorized ? <a className="controlled-replay-link" href="/admin">登录管理后台 ↗</a> : error && <button type="button" onClick={refresh}><ArrowClockwise size={15} />重新读取</button>}
    <p>此独立来源不会替代现场观测或模拟数据。</p>
  </section>;
  const item = entry.item, source = data.source_metadata;
  const quality = replayQualityLabels(item.quality_mask);
  const rssi = item.rssi.samples ? `${(item.rssi.sum_dbm / item.rssi.samples).toFixed(1)} dBm` : '无有效样本';
  return <section className="controlled-replay-panel" aria-label="管理员历史采集回放" data-source="historical_cpraw" data-dataset="controlled_test">
    <h2><Clock size={17} />{data.label}</h2>
    <p className="controlled-replay-source">CPRAW 原始采集 → V3 统计窗口 · 受控测试</p>
    <p className="controlled-replay-time">原始源时间<br /><strong>{formatReplayTime(entry, 'start', data)}</strong><br />至 {formatReplayTime(entry, 'end', data)}</p>
    <p>{anchor ? `地图展示锚点：${anchor.name}；不证明原始采集地点。` : '原始采集地点未核验；底图仅用于展示。'}</p>
    <div className="controlled-replay-overview"><span>源报告 <strong>{number(source.total_reports)}</strong></span><span>本次回放 <strong>{number(source.replayed_reports)}</strong></span><span>统计窗口 <strong>{number(data.windows.length)}</strong></span></div>
    <h3>窗口 {index + 1} / {data.windows.length} <small>{(item.duration_ms / 1000).toFixed(3)} 秒</small></h3>
    <strong className="controlled-replay-value">{number(item.visible_identifiers)} 个 BLE 可见标识</strong>
    <p>标识不等于人数或车辆数；未计算人数、车辆或候梯估计。</p>
    <dl className="controlled-replay-stats">
      <div><dt>收到 / 聚合报告</dt><dd>{number(item.reports.received)} / {number(item.reports.worker)}</dd></div>
      <div><dt>广播 / 扫描响应</dt><dd>{number(item.reports.adv)} / {number(item.reports.scan_response)}</dd></div>
      <div><dt>平均 RSSI</dt><dd>{rssi}</dd></div>
      <div><dt>RSSI 范围 / 样本</dt><dd>{item.rssi.samples ? `${item.rssi.min_dbm}～${item.rssi.max_dbm} dBm / ${number(item.rssi.samples)}` : '无有效样本'}</dd></div>
      <div><dt>扫描覆盖</dt><dd>{number(item.losses.scan_coverage_ms)} / {number(item.duration_ms)} ms</dd></div>
      <div><dt>回调 / 聚合丢失</dt><dd>{number(item.losses.callback_drops)} / {number(item.losses.aggregation_drops)}</dd></div>
      <div><dt>地址溢出报告</dt><dd>{number(item.losses.address_overflow_reports)}</dd></div>
      <div><dt>质量位</dt><dd>0x{item.quality_mask.toString(16).padStart(2, '0')}</dd></div>
      <div><dt>源时钟误差</dt><dd>{item.time.uncertainty_ms === null ? '未知' : `±${number(item.time.uncertainty_ms)} ms`}</dd></div>
    </dl>
    <p className="controlled-replay-quality">{quality.length ? quality.join(' · ') : '统计质量位未置位；不代表无线采集完整。'}</p>
    <details className="controlled-replay-provenance"><summary>来源与重放边界</summary><p>源 SHA-256：{source.sha256.map(hash => <code key={hash}>{digest(hash)}</code>)}</p><p>导入体 SHA-256：<code>{digest(data.body_sha256)}</code></p><p>历史时钟锚点 {source.clock_anchors.length} 个 · 提取器 {item.versions.extractor_version} · 规则 {item.versions.ruleset_version}</p><p>源单调时钟 {entry.source_start_mono_us}–{entry.source_end_mono_us} μs。窗口内标识数不能相加作为全程去重总数；源记录缺口、覆盖不足和丢失不能解释为无人或空闲。</p><p>导入时间 {new Date(data.imported_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 北京；导入时间不作为采集时间。</p></details>
  </section>;
}

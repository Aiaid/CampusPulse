import React from 'react';
import { ArrowClockwise, Clock, Radio } from '@phosphor-icons/react';
import { fieldRecordKey, latestManualObservations, recordFreshness } from './field-data.js';
import { recordsAtTime } from './field-timeline';
import { formatObservationKinds, observationKinds, observationKindLabels } from '../shared/observation-kinds.js';
import './field-data.css';
import AutomaticObservations from './AutomaticObservations.jsx';

const stamp = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const valueText = record => record.source === 'sensor' ? `${record.visible_identifiers} 个 BLE 可见标识` : record.kind === 'parking' ? `${record.parking_min}–${record.parking_max} 辆` : `${record.wait_seconds} 秒已完成候梯`;
const qualityLabels = { partial_window: '非完整窗口', unique_table_overflow: '标识表溢出', aggregation_drops: '聚合丢失', raw_drops: '原始记录丢失', raw_pressure_pause: '存储压力暂停' };

function FieldRecord({ record, replay, now }) {
  const sensor = record.source === 'sensor';
  const freshness = recordFreshness(record, now);
  return <article className="field-data-record" aria-label={sensor ? '活动监测 · 传感器窗口' : `${observationKindLabels[record.kind]} · 人工记录`}>
    <div className="field-data-source"><span>{sensor ? '活动监测 · 现场 BLE 窗口' : `${observationKindLabels[record.kind]} · 人工记录`}</span><span className={`field-data-freshness ${replay ? 'historical' : freshness}`}>{replay ? '历史记录' : freshness === 'fresh' ? '有效观察' : '已过期'}</span></div>
    <strong className="field-data-value">{valueText(record)}</strong>
    <p>{sensor ? 'BLE 可见标识是活动证据，不等于人数、车辆数、精确占用或自动候梯预测。' : record.kind === 'parking' ? '人工观察的停车数量范围，不代表停车容量。' : '本次已完成的实测等待，不是当前候梯预测。'}</p>
    <dl className="field-data-times"><div><dt>观测时间</dt><dd><time dateTime={record.observed_at}>{stamp(record.observed_at)}</time></dd></div><div><dt>有效至</dt><dd><time dateTime={record.valid_until}>{stamp(record.valid_until)}</time></dd></div></dl>
    {sensor && <><p className="field-data-device">节点 {record.node_id} · 窗口 {(record.duration_ms / 1000).toFixed(1)} 秒 · 扫描 {(record.scan_enabled_ms / 1000).toFixed(1)} 秒<br />聚合报告 {record.reports_aggregated} · 聚合丢失 {record.aggregation_drops} · 时间不确定度 ±{(record.uncertainty_ms / 1000).toFixed(1)} 秒</p>{(record.quality_flags.length > 0 || record.unique_table_overflow) && <p className="field-data-warning">质量提示：{[...new Set([...record.quality_flags, ...(record.unique_table_overflow ? ['unique_table_overflow'] : [])])].map(flag => qualityLabels[flag] || flag).join('、')}</p>}</>}
  </article>;
}

/** Detail cards share the map's real-data session and one fixed time cursor. */
export default function FieldDataPanel({ place, mode = 'live', session, cursor, className = '' }) {
  const replay = mode === 'replay';
  const { data, loading, error } = replay ? session.history : session.live;
  const atTime = replay && data && cursor != null ? recordsAtTime(data.records, cursor) : null;
  const selectedRecords = atTime ? [...atTime.sensors, ...atTime.manual] : [];
  const manual = latestManualObservations(replay ? null : data);
  const manualKinds = [...new Set([...observationKinds(place).filter(kind => kind !== 'activity'),
    ...Object.keys(manual).filter(kind => manual[kind])])];
  return <section className={`field-data-panel ${className}`} aria-label={replay ? '现场历史回放' : '现场实时数据'}>
    <div className="field-data-heading"><h2>{replay ? <Clock size={15} /> : <Radio size={15} />}{replay ? '现场历史回放' : '现场实时数据'}</h2><button type="button" onClick={session.refresh} disabled={loading || !place?.id} aria-label="刷新现场数据"><ArrowClockwise size={14} />刷新</button></div>
    {!place?.id ? <p className="field-data-empty">选择一个现场地点以读取记录；空白不表示无人或空闲。</p> : <>
      <p className="field-data-caption">{place.name} · {formatObservationKinds(place)} · {replay ? '时间轴已暂停跟随，原始观测时间保持不变' : '正在跟随实时 · 每 30 秒及返回页面时刷新'} · 北京时间</p>
      {replay && cursor != null && <p className="field-data-cursor">回看 <time dateTime={new Date(cursor).toISOString()}>{stamp(cursor)}</time><small>传感器显示覆盖此时刻的采集窗口；人工记录按当时有效期显示。</small></p>}
      <div aria-live="polite" aria-busy={loading}>
        {error ? <div className="field-data-error" role="alert"><strong>现场数据不可用</strong><p>{error}。可点击刷新重试；未使用模拟数据替代。</p></div> : !data && loading ? <p className="field-data-empty" role="status">正在读取现场服务…</p> : data && (replay ? <>
          {!selectedRecords.length ? <p className="field-data-empty">{data.records.length ? '该时刻没有已载入的观测记录；不延用相邻窗口或补值。' : '所选时段没有保留的现场记录；不生成补点，也不表示无人或空闲。'}</p> : selectedRecords.map(record => <FieldRecord key={fieldRecordKey(record)} record={record} replay now={session.now} />)}
          <p className="field-data-caption">下方时间轴可拖动回看；点击「返回实时」继续跟随最新数据。地图只定位地点，不还原个体轨迹。</p>
          <p className="field-data-caption">自动分析尚未归档到此历史时间轴；当前自动候选与历史样本参考不会带入所选时刻。</p>
        </> : <>
          {data.sensor ? <FieldRecord record={data.sensor} now={session.now} /> : <p className="field-data-empty">暂无可展示的传感器窗口。设备联网后，仍需上传符合此地点与现场数据要求的采集窗口。地图标记地点，不单独标记设备；空白不表示无人。</p>}
          <AutomaticObservations observations={data.automatic_observations} now={session.now} />
          {manualKinds.length ? manualKinds.map(kind => manual[kind]
            ? <FieldRecord key={kind} record={manual[kind]} now={session.now} />
            : <p key={kind} className="field-data-empty">{observationKindLabels[kind]}：暂无人工现场记录；空白不表示空闲。</p>)
            : <p className="field-data-empty">暂无人工现场记录；空白不表示空闲。</p>}
          <p className="field-data-caption">服务端状态时间 <time dateTime={data.as_of}>{stamp(data.as_of)}</time></p>
        </>)}
      </div>
    </>}
  </section>;
}

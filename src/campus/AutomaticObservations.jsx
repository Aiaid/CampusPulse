import React from 'react';
import { recordFreshness } from './field-data.js';

const stamp = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const seconds = value => Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value) : '—';
const reasons = {
  vehicle_features_not_reported: '设备尚未上报识别所需的广播特征',
  summaries_pending: '采集窗口已到达，仍在等待配套地址摘要',
  stale_sensor_window: '最近的采集窗口已过期，等待新窗口',
  invalid_vehicle_evidence: '识别特征未通过完整性检查',
  inconsistent_vehicle_evidence: '识别特征与采集窗口尚未对齐',
  no_usable_vehicle_features: '暂无成功解析且可用于识别的广播特征',
  no_field_sensor_windows: '暂无符合条件的现场采集窗口',
  no_field_windows: '暂无符合条件的现场采集窗口',
  no_sensor_window: '暂无符合条件的现场采集窗口',
  no_vehicle_evidence: '暂无可用于分类的广播证据',
  no_positive_vehicle_evidence: '暂无支持电动车候选分类的特征',
  insufficient_samples: '可比较的历史样本不足',
  insufficient_days: '历史样本覆盖的日期不足',
  no_manual_samples: '暂无已完成的人工候梯样本',
  no_comparable_samples: '暂无可比较时段的人工候梯样本',
  stale_manual_samples: '可比较的人工候梯样本已过期',
  input_limit_exceeded: '样本超出本次计算上限',
  unsupported_place_purpose: '此地点尚未启用该观测用途',
  purpose_not_enabled: '此地点尚未启用该观测用途',
};
const qualityLabels = {
  partial_window: '非完整窗口', unique_table_overflow: '标识表溢出', aggregation_drops: '聚合丢失',
  raw_drops: '原始记录丢失', raw_pressure_pause: '存储压力暂停',
  sampled_evidence: '抽样证据', sampled_raw_evidence: '抽样原始证据',
  incomplete_vehicle_evidence: '广播证据不完整，正面线索和排除线索均可能遗漏',
  unusable_vehicle_features: '部分广播特征不可用于识别',
};

function InferenceCard({ record, label, now, retained, children }) {
  const unavailable = record.status === 'unavailable';
  const freshness = unavailable ? 'unavailable' : recordFreshness(record, now);
  return <article className="field-data-record field-data-inference" aria-label={label}>
    <div className="field-data-source"><span>{label}</span><span className={`field-data-freshness ${retained && !unavailable ? 'stale' : freshness}`}>{unavailable ? '证据不足' : retained ? '最后可用分析' : freshness === 'fresh' ? '参考有效' : '已过期'}</span></div>
    {unavailable ? <p className="field-data-empty">暂不可估计：{reasons[record.reason] || '当前证据不满足估计条件'}。缺失不表示零。</p> : children}
    {!unavailable && (retained || freshness !== 'fresh') && <p className="field-data-warning">最后分析 · {freshness === 'fresh' ? '等待更新' : '已过期 · 等待更新'}</p>}
    {record.observed_at && record.valid_until && <dl className="field-data-times"><div><dt>证据时间</dt><dd><time dateTime={record.observed_at}>{stamp(record.observed_at)}</time></dd></div><div><dt>参考有效至</dt><dd><time dateTime={record.valid_until}>{stamp(record.valid_until)}</time></dd></div></dl>}
    <p>方法版本 {record.model_version}</p>
  </article>;
}

/** Current inference is deliberately absent from retained-record replay. */
export default function AutomaticObservations({ observations, now, lastKnown }) {
  if (!observations) return null;
  const { vehicles, elevator } = observations;
  return <div className="field-data-automatic" aria-label="自动分析参考">
    <InferenceCard record={vehicles} label="电动车相关广播 · 自动候选" now={now} retained={lastKnown?.vehicles}>
      <strong className="field-data-value">{vehicles.candidate_count} 个电动车相关候选标识</strong>
      <p>最近一个节点采集窗口内，基于 BLE 广播规则的候选识别，尚未校准；不等于车辆数量、停车占用或人员数量。</p>
      <p>{vehicles.sample_count} 个特征样本 · {vehicles.evidence_kind === 'raw' ? '抽样原始广播证据' : '设备摘要特征'}{vehicles.car_related_count !== null ? ` · 汽车相关候选 ${vehicles.car_related_count}` : ''}{vehicles.ecosystem_count !== null ? ` · 车辆生态相关候选 ${vehicles.ecosystem_count}` : ''}。类别独立显示，不相加为车辆数。</p>
      {!!vehicles.quality_flags.length && <p className="field-data-warning">质量提示：{vehicles.quality_flags.map(flag => qualityLabels[flag] || '证据质量受限').join('、')}</p>}
    </InferenceCard>
    <InferenceCard record={elevator} label="候梯时间 · 历史样本参考" now={now} retained={lastKnown?.elevator_reference}>
      <strong className="field-data-value">约 {seconds(elevator.wait_seconds)} 秒候梯参考</strong>
      <p>历史已完成的人工候梯样本中位数，不是当前实测或实时剩余等待预测；尚未校准。</p>
      <p>样本区间 {seconds(elevator.range_seconds?.lower)}–{seconds(elevator.range_seconds?.upper)} 秒 · {elevator.sample_count} 次样本 / {elevator.day_count} 天。区间为历史样本分布，不是预测保证。</p>
    </InferenceCard>
  </div>;
}

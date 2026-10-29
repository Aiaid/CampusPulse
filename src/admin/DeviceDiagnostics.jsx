import React, { useEffect, useState } from 'react';
import HelpTip from './HelpTip.jsx';
import { KeyValues, Metric, Notice, Panel, fmtBytes, fmtNumber, fmtTime } from './shared.jsx';
import { ageText, memoryPauseLabels, stateLabel, statusEvidence, streamLabels } from './device-diagnostics.js';
import './device-diagnostics.css';

function receiptLabel(value, now, threshold) {
  if (!value) return '尚无回执';
  return now - Date.parse(value) <= threshold * 1000 ? '最近接收' : '回执已过期';
}
const losses = [
  ['aggregation_drops', '聚合输入丢弃', '尚未进入窗口聚合的报告'],
  ['address_table_overflow_reports', '地址表容量溢出', '地址容量不足时无法完整归属的报告'],
  ['accounting_overrun_reports', '计数范围溢出', '超出固件计数表示范围的报告'],
  ['unpersisted_window_reports', '未持久化窗口报告', '窗口未落盘时关联的报告'],
  ['windows_dropped', '窗口丢弃', '无法保留的完整窗口'],
  ['address_summaries_dropped', '地址汇总丢弃', '无法保留的地址汇总条目'],
  ['raw_queue_drops', '原始队列丢弃', '原始报告队列已满'],
  ['raw_pressure_skips', '压力主动跳过', '因压力保护跳过的可选原始报告'],
  ['storage_drops', '存储丢弃', '无法写入本地存储的记录'],
  ['status_samples_coalesced', '状态合并', '合并为较新状态的样本，不等同于无线报告丢失'],
  ['upload_failures', '上传失败', '设备声明的失败次数，不代表每次都丢失数据'],
  ['ack_failures', 'ACK 处理失败', '确认解析或处理失败；可能需要安全重试'],
];
function ReceiptTime({ value, now }) { return <>{fmtTime(value)}<small className="cp-diagnostic-subtle">{ageText(value, now)}</small></>; }
export default function DeviceDiagnostics({ device, configs }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => { const start = Date.now(); setElapsed(0); const timer = setInterval(() => setElapsed(Date.now() - start), 10000); return () => clearInterval(timer); }, [device]);
  const now = Date.parse(device.server_time) + elapsed || Date.now();
  const latest = device.latest_status, status = latest?.item, health = status?.buffer_health;
  const control = device.latest_control, ingestion = device.latest_ingestion;
  const evidence = statusEvidence(device, now);
  const statusConfig = configs?.find(row => row.id === latest?.capture_config_id)?.config;
  const desiredConfig = configs?.find(row => row.id === device.desired_config_id)?.config;
  const reportedRawOff = status?.raw_capture_state === 'off';
  return <div className="cp-device-diagnostics">
    <Panel title="连接与数据新鲜度" description="控制联系、上传接收和设备采样是三种独立证据。页面按服务端参考时间计时，刷新后获取新数据。">
      <div className="cp-diagnostic-evidence-grid">
        <div><h3 aria-label="最近控制联系"><span>最近控制联系</span><HelpTip topic="device.control" label="最近控制联系说明" /></h3><p>{receiptLabel(control?.received_at, now, device.stale_after_seconds)}</p><ReceiptTime value={control?.received_at} now={now} /><p>{control ? `${stateLabel(control.capture_state)} · Wi-Fi ${stateLabel(control.wifi_state)}` : '无控制联系上报'}</p><code>{control?.boot_id || '启动标识未知'}</code></div>
        <div><h3 aria-label="最近上传接收"><span>最近上传接收</span><HelpTip topic="device.ingestion" label="最近上传接收说明" /></h3><p>{receiptLabel(ingestion?.received_at, now, device.stale_after_seconds)}</p><ReceiptTime value={ingestion?.received_at} now={now} /><p>{streamLabels[ingestion?.stream] || '尚无已接收批次'}</p><code>{ingestion?.boot_id || '启动标识未知'}</code></div>
        <div><h3 aria-label="设备状态样本"><span>设备状态样本</span><HelpTip topic="device.statusEvidence" label="设备状态样本说明" /></h3><span className={`cp-admin-badge cp-admin-badge-${evidence.tone}`}>{evidence.label}</span><p><ReceiptTime value={latest?.received_at} now={now} /></p><code>{latest?.boot_id || '启动标识未知'}</code></div>
      </div>
      {latest && <KeyValues entries={[
        ['设备测量 UTC', <ReceiptTime value={status?.time?.utc_ms} now={now} />], ['启动内单调时间', status?.time?.mono_ms == null ? '未上报' : `${fmtNumber(status.time.mono_ms)} ms`],
        ['时钟不确定度', status?.time?.uncertainty_ms == null ? '未知，不能推断准确采样时间' : `${fmtNumber(status.time.uncertainty_ms)} ms`],
        ['设备时钟 epoch', fmtNumber(status?.time?.clock_epoch)], ['状态引用配置', latest.capture_config_id], ['状态序号', fmtNumber(status?.seq)], ['服务端过期阈值', `${fmtNumber(device.stale_after_seconds)} 秒`],
      ]} />}
      <Notice>最近联系不证明正在扫描。旧启动与延迟上传样本只用于历史诊断；计数不能跨启动直接相减。登记的板型和设备声明的固件版本不构成硬件验收。</Notice>
    </Panel>
    {!status ? <Notice>尚无设备状态上报。内存、采集、队列与损失均未知，不按零显示。</Notice> : <>
      <div className="cp-admin-stats"><Metric label="样本中的扫描状态" value={stateLabel(status.scan_state)} hint={evidence.label} /><Metric label="堆内存可用" value={fmtBytes(status.free_heap_bytes)} hint="单次设备声明；最大连续空闲块和最低余量未上报；需通过 USB 诊断" /><Metric label="本地未确认存储" value={fmtBytes(health?.unacked_bytes)} hint="设备尚未处理持久化确认的字节数" /><Metric label="存储可用" value={fmtBytes(status.storage_free_bytes)} hint={`已用 ${fmtBytes(health?.used_bytes)} / 预算 ${fmtBytes(health?.log_budget_bytes)}`} /></div>
      <div className="cp-admin-two-columns">
        <Panel title="采集、内存与存储" description={`数据来源：${evidence.label}，仅代表该状态样本。`}>
          <KeyValues entries={[
            ['设备声明原始采集', stateLabel(status.raw_capture_state)], ['该样本配置的原始采集', stateLabel(statusConfig?.raw_capture?.mode)], ['当前期望原始采集', stateLabel(desiredConfig?.raw_capture?.mode)],
            ['保护暂停原因', health?.pause_reason === undefined ? '未上报' : health.pause_reason === null ? '设备报告无暂停' : memoryPauseLabels[health.pause_reason] || health.pause_reason],
            ['存储压力', health?.pressure_level], ['存储增长状态', health?.growth_state], ['原始采样暂停累计', health?.raw_paused_ms == null ? '未上报' : `${fmtNumber(health.raw_paused_ms)} ms`],
            ['输入速率', health?.incoming_local_Bps == null ? '未上报' : `${fmtNumber(health.incoming_local_Bps)} B/s`], ['新确认速率', health?.newly_acknowledged_local_Bps == null ? '未上报' : `${fmtNumber(health.newly_acknowledged_local_Bps)} B/s`],
            ['预计存储满', health?.time_to_full_s == null ? '未知 / 不适用' : `${fmtNumber(health.time_to_full_s)} 秒`], ['已确认可回收', fmtBytes(health?.reclaimable_bytes)],
            ['设备运行时长', status.uptime_ms == null ? '未上报' : `${fmtNumber(Math.floor(status.uptime_ms / 1000))} 秒`], ['Wi-Fi RSSI', status.wifi_rssi_dbm == null ? '未上报' : `${status.wifi_rssi_dbm} dBm`], ['电池电压', status.battery_mv == null ? '未上报' : `${status.battery_mv} mV`],
          ]} />
          {(reportedRawOff || statusConfig?.raw_capture?.mode === 'off') && <Notice>此样本的原始广播内容采集为关闭。窗口和地址汇总仍可上传；历史原始批次需在下方按接收记录核对。</Notice>}
          {statusConfig?.raw_capture?.mode === 'off' && health?.pause_reason === 'memory_raw_pressure' && <Notice>样本配置关闭原始采集，但固件报告原始采样内存暂停，存在状态不一致；保留原始声明供排查。</Notice>}
        </Panel>
        <Panel title="本地待确认队列" description="设备声明的 pending / capacity。待确认项可能尚未上传，也可能已到云端但设备尚未收到或处理 ACK。">
          <div className="cp-admin-queue-list">{Object.entries(streamLabels).map(([key, label]) => { const pending = status.queue_pending?.[key], capacity = status.queue_capacity?.[key]; return <div key={key}><span><span>{label}</span><HelpTip topic={`device.queue.${key}`} label={`${label}上传流与队列说明`} /></span><strong>{fmtNumber(pending)} / {fmtNumber(capacity)}</strong>{pending != null && capacity > 0 && <progress aria-label={`${label}队列使用量`} value={pending} max={capacity} />}</div>; })}</div>
          <Notice>云端持久化回执证明服务器已提交批次，不能证明设备已收到 ACK 或完成本地回收。未上传的广播内容无法在后台读取。</Notice>
          <details className="cp-diagnostic-losses" open><summary>损失与失败计数（本启动累计）</summary><HelpTip topic="device.losses" label="本启动累计损失与失败计数说明" /><dl>{losses.map(([key, label, meaning]) => <div key={key}><dt><span>{label}</span><HelpTip topic={label} label={`${label}计数说明`} /><small>{meaning}</small></dt><dd>{fmtNumber(status.loss_totals?.[key])}</dd></div>)}</dl></details>
        </Panel>
      </div>
    </>}
  </div>;
}

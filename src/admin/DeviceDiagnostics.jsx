import React from 'react';
import { KeyValues, Notice, Panel, Resource, fmtBytes, fmtNumber, fmtTime, useAdmin, useResource } from './shared.jsx';
export default function DeviceDiagnostics({device}) {
 const {version}=useAdmin(), evidence=useResource(`/device-v3/nodes/${encodeURIComponent(device.id)}/evidence?limit=5`,version);
 return <Panel title="V3 运行诊断" description="能力、租约与上传状态分别记录；没有报告时保持未知。"><Resource resource={evidence}>{data=>{
  const status=data.statuses.rows[0],window=data.windows.rows[0],lease=data.leases.rows.find(l=>l.boot_id===data.control?.boot_id&&l.generation===data.control?.applied_generation);
  const sameBoot=!!status&&status.boot_id===data.control?.boot_id;
  return <><KeyValues entries={[[ '启动标识',data.control?.boot_id ],['状态样本启动',status?.boot_id],['当前启动采集状态',sameBoot?status?.collection_state:null],['最近状态样本',status?.collection_state],['状态样本时间',fmtTime(status?.time_utc_ms)],['租约有效截止',fmtTime(lease?.lease_until_ms)],['最近统计窗口',fmtTime(window?.end_utc_ms)],['窗口可见标识',fmtNumber(window?.visible_identifiers)],['人数估计','未提供 / 未校准'],['窗口丢失',fmtNumber(status?.losses?.window_drops)],['上传失败',fmtNumber(status?.losses?.upload_failures)],['ACK 失败',fmtNumber(status?.losses?.ack_failures)],['重试',fmtNumber(status?.losses?.retries)],['统计待发',fmtNumber(status?.queue?.window_statistics?.pending_items)],['状态待发',fmtNumber(status?.queue?.node_status?.pending_items)],['内部空闲内存',fmtBytes(status?.memory?.internal_free)],['PSRAM 空闲',fmtBytes(status?.memory?.psram_free)],['原始本地记录',status?.raw_recording?'有独立计数':'未上报']]} />
  {status&&!sameBoot&&<Notice>最近状态来自历史启动，不能用于判断当前设备是否正在采集；当前启动状态保持未知。</Notice>}<Notice>租约与 applied ACK 不替代持续采集验证。BLE 可见标识不是人数；统计回执不会证明本地 TF 文件已上传或释放。</Notice></>;
 }}</Resource></Panel>;
}

export const memoryPauseLabels = { memory_pressure: '内存不足，扫描自动暂停', memory_raw_pressure: '内存紧张，原始采样自动暂停' };
export const streamLabels = { ble_windows: '窗口汇总', address_summaries: '地址汇总', node_status: '设备状态', ble_reports: '原始广播' };
export const captureLabels = { running: '扫描运行中', paused: '已暂停', stopped: '已停止', off: '关闭', sampled: '按策略采样', all: '全部报告', unassigned: '尚未分配', disabled: '已停用', failed: '设备报告失败' };
export const stateLabel = value => captureLabels[value] || value || '未上报';
export function ageText(time, now) {
  const date = time == null ? NaN : new Date(time).getTime();
  if (!Number.isFinite(date)) return '时间未知';
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 0) return '时间晚于服务端参考时刻';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
export function statusEvidence(device, now) {
  const latest = device.latest_status;
  if (!latest) return { label: '尚无状态样本', tone: 'gray', currentBoot: false };
  const controlBoot = device.latest_control?.boot_id;
  const currentBoot = !!controlBoot && controlBoot === latest.boot_id;
  if (controlBoot && !currentBoot) return { label: '旧启动状态', tone: 'amber', currentBoot };
  const received = Date.parse(latest.received_at), measured = latest.item?.time?.utc_ms;
  const threshold = (device.stale_after_seconds ?? 300) * 1000;
  if (!Number.isFinite(received) || now - received > threshold) return { label: '状态已过期', tone: 'amber', currentBoot };
  if (measured != null && now - measured > threshold) return { label: '延迟上传的历史状态', tone: 'amber', currentBoot };
  return { label: currentBoot ? '最近状态 · 同一控制启动' : '最近状态 · 启动未核对', tone: 'blue', currentBoot };
}
export const exactLabels = {
  archive_registered: '有归档索引，展开后校验', not_archived: '未保存请求原文', expired: '内容保留期已到',
  verified: '原始请求字节已校验', missing: '归档对象缺失', storage_unavailable: '私有存储暂不可用',
  integrity_error: '完整性校验失败，原文已隐藏', size_limit: '对象超出安全读取上限',
  sensitive_fields_omitted: '含敏感字段，原文已隐藏', invalid_archive: '归档不是有效 UTF-8 JSON',
};

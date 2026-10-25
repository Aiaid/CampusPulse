// Configuration edits append a version and desired assignment. Historical policy
// and placement IDs remain attached to already collected/queued observations.
import { sameWorkPurposes, validateWorkPurposes } from './work-purposes.js';
export const profileName = config => config.capture_profile === 'address_metrics' ? '地址摘要 + 指标汇总（v2）' : config.capture_profile === 'research_raw' ? '研究原始报告' : '指标汇总';
export function cloneConfig(seed, now = Date.now()) {
  return { ...structuredClone(seed), capture_config_id: `${seed.node_id.slice(0, 36)}-v-${crypto.randomUUID().slice(0, 12)}`, accept_until: new Date(Math.max(Date.parse(seed.accept_until) || 0, now + 7 * 86400000)).toISOString() };
}
export function rawCaptureUpdate(config, mode) {
  const v2 = config.protocol === 'campuspulse/2';
  const previous = config.raw_capture;
  return { ...config, raw_capture: mode === 'sampled' ? { mode, sample_every_n: previous.mode === mode ? previous.sample_every_n : 10, selection: 'seq_mod_n_eq_0', ...(v2 ? { max_reports_per_window: previous.mode === mode ? previous.max_reports_per_window : 4 } : {}) } : { mode },
    ...(v2 ? { allowed_streams: ['ble_windows', 'address_summaries', 'node_status', ...(mode === 'sampled' ? ['ble_reports'] : [])] } : {}) };
}
export function validateConfigForm(config, now = Date.now()) {
  if (!config || typeof config !== 'object' || !config.scan || !config.raw_capture || !config.upload_policy || !Array.isArray(config.allowed_streams)) throw new Error('配置结构不完整，请检查身份、扫描、原始报告和上传策略。');
  if (!config.capture_config_id || !config.node_id || !config.placement_id) throw new Error('请填写配置 ID、设备与部署。');
  if (!(config.scan.window_ms > 0 && config.scan.window_ms <= config.scan.interval_ms)) throw new Error('扫描窗口必须大于零，且不能大于扫描间隔。');
  const u = config.upload_policy;
  if (!(u.resume_pct < u.warn_pct && u.warn_pct < u.raw_pause_pct && u.raw_pause_pct < u.critical_pct)) throw new Error('存储水位必须满足：恢复 < 预警 < 暂停原始报告 < 临界。');
  if (!Number.isFinite(Date.parse(config.accept_until)) || Date.parse(config.accept_until) <= now) throw new Error('配置接收截止时间必须晚于现在。');
  if (config.protocol === 'campuspulse/2') {
    const s = config.summary;
    if (!s || !Number.isInteger(s.window_ms) || !Number.isInteger(s.bin_ms) || s.bin_ms < 1000 || s.window_ms % s.bin_ms || s.window_ms / s.bin_ms > 60) throw new Error('地址摘要窗口必须可被分箱时长整除，且最多 60 个分箱。');
    if (config.capture_profile !== 'address_metrics' || config.identity_scheme !== 'mac') throw new Error('v2 策略必须使用地址摘要档位和 MAC 标识方案。');
  }
}
const encoded = value => encodeURIComponent(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
// Every retry first reconciles fixed IDs. A lost write response must never cause
// another location, draft or assignment, or rotate device credentials.
/** @param {{ id: string, place_id: string | null, valid_from_ms: number, valid_until_ms: number | null, observation_kinds?: string[] } | null} [placement] */
export async function publishConfigEdit(api, body, placement = null, progress = () => {}) {
  validateConfigForm(body.config);
  if (placement?.observation_kinds) validateWorkPurposes(placement.observation_kinds);
  const { node_id: node, capture_config_id: id } = body.config;
  const path = `/devices/${encoded(node)}`;
  const listed = await api(`/configs?node_id=${encoded(node)}`);
  const published = listed.configs.find(row => row.id === id);
  // Reconcile application metadata even after publication. Purpose changes are
  // immutable deployment changes and must never be hidden by a lost response.
  const reconcilePlacement = async (create = false) => {
    if (!placement) return;
    const detail = await api(path);
    const existing = detail.placements.find(row => row.id === placement.id);
    if (existing) {
      if (existing.place_id !== placement.place_id || existing.valid_from_ms !== placement.valid_from_ms || existing.valid_until_ms !== placement.valid_until_ms || placement.observation_kinds && !sameWorkPurposes(existing.observation_kinds, placement.observation_kinds)) throw new Error('地点或工作用途变更已经登记且内容不同，不能覆盖。请关闭后核对部署历史。');
    } else if (create) await api(`${path}/placements`, { method: 'POST', body: placement });
    else if (published) throw new Error('已发布版本缺少本次地点与工作用途部署，请关闭后核对。');
  };
  await reconcilePlacement();
  if (published) {
    if (!same(published.config, body.config) || published.raw_retention_hours !== body.raw_retention_hours || published.aggregate_retention_days !== body.aggregate_retention_days) throw new Error('此版本已发布且内容不同；请关闭后重新编辑新版本。');
  } else {
    let draft = listed.drafts.find(row => row.id === id);
    if (!draft) draft = (await api('/configs', { method: 'POST', body })).draft;
    else if (!same(draft.config, body.config) || draft.raw_retention_hours !== body.raw_retention_hours || draft.aggregate_retention_days !== body.aggregate_retention_days)
      draft = (await api(`/configs/${encoded(id)}`, { method: 'PUT', body: { ...body, revision: draft.revision } })).draft;
    progress('新版本草稿已保存；尚未发布。');
    if (placement) {
      await reconcilePlacement(true);
      progress('地点与工作用途新部署已登记，旧部署区间已关闭；请完成发布。设备尚未确认切换。');
    }
    try {
      await api(`/configs/${encoded(id)}/validate`, { method: 'POST', body: { revision: draft.revision } });
    } catch (error) {
      // A structured validation rejection is a known outcome, so capture fields
      // may be corrected. Network/unknown outcomes keep the retry body frozen.
      if (error?.code) Object.assign(error, { configEditStage: 'validation_rejected' });
      throw error;
    }
    await api(`/configs/${encoded(id)}/publish`, { method: 'POST', body: { revision: draft.revision } });
  }
  const detail = await api(path);
  if (detail.device.desired_config_id !== id) throw new Error('版本已发布，但设备期望分配已变化。请关闭后在设备详情核对。');
  return id;
}

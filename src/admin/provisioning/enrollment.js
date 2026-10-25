export const NODE_PATTERN = /^cp_[a-f0-9]{12}$/;
export const TOKEN_PATTERN = /^cpd_[a-f0-9]{64}$/;
export const DEVICE_API_ORIGIN = 'https://pulse.anend.net';
export function provisionConfig(node, placement, id, dataset = 'controlled_test', now = Date.now()) {
  return { protocol: 'campuspulse/2', capture_config_id: id, node_id: node, placement_id: placement, dataset,
    capture_profile: 'address_metrics', allowed_streams: ['ble_windows', 'address_summaries', 'node_status'],
    scan: { stack: 'nimble', adapter_version: 'cp-nimble-v2', mode: 'passive', interval_ms: 100, window_ms: 100, filter_duplicates: false, host_filter: 'none' },
    raw_capture: { mode: 'off' }, identity_scheme: 'mac', accept_until: new Date(now + 7 * 86400000).toISOString(),
    summary: { window_ms: 30000, bin_ms: 5000, max_addresses: 64 }, control: { lease_ms: 120000 },
    upload_policy: { max_items: 16, max_body_bytes: 8192, flush_max_age_ms: 5000, warn_pct: 60, raw_pause_pct: 80, critical_pct: 95, resume_pct: 40, overload_action: 'pause_raw' } };
}
// Deterministic IDs plus reads before each write let the browser reconcile a
// lost placement/draft/publish response without creating a second assignment.
export async function assignProvisionConfig(api, node, attempt, place, dataset) {
  const suffix = attempt.replaceAll('-', '').slice(0, 16), placement = `${node}-p-${suffix}`, id = `${node}-c-${suffix}`;
  let detail = await api(`/devices/${node}`);
  if (detail.device.desired_config_id === id) return id;
  if (!detail.placements?.some(p => p.id === placement)) await api(`/devices/${node}/placements`, { method: 'POST', body: { id: placement, place_id: place || null, valid_from_ms: Date.now(), valid_until_ms: null } });
  const configs = await api(`/configs?node_id=${node}`);
  let draft = configs.drafts.find(d => d.id === id);
  if (!draft && !configs.configs.some(c => c.id === id)) draft = (await api('/configs', { method: 'POST', body: { config: provisionConfig(node, placement, id, dataset), raw_retention_hours: 24, aggregate_retention_days: 30 } })).draft;
  if (draft) {
    await api(`/configs/${id}/validate`, { method: 'POST', body: { revision: draft.revision } });
    await api(`/configs/${id}/publish`, { method: 'POST', body: { revision: draft.revision } });
  }
  detail = await api(`/devices/${node}`); if (detail.device.desired_config_id !== id) throw new Error('配置已存在，但目前分配已变化；请到设备详情核对。'); return id;
}
export function cloudProgress(detail, configId, since) {
  const d = detail?.device; if (!d) return { contact: false, applied: false };
  const fresh = Date.parse(d.latest_control?.received_at || d.last_seen_at || '') >= since;
  const ack = detail.activation?.current;
  const freshAck = ack?.state === 'applied' && ack.capture_config_id === configId && Date.parse(ack.received_at || '') >= since;
  const sameBoot = !ack?.boot_id || !d.latest_control?.boot_id || ack.boot_id === d.latest_control.boot_id;
  return { contact: fresh, applied: fresh && freshAck && sameBoot && !!configId && d.desired_config_id === configId && d.applied_config_id === configId && d.config_state === 'applied', capture: d.latest_control?.capture_state || 'unknown' };
}

// Only the API's explicit unknown-device response permits first registration.
// Connectivity/auth/interface failures must never be interpreted as a new node.
export async function inspectEnrollment(api, node) {
  if (!NODE_PATTERN.test(node)) throw new Error('请先确认有效的工厂节点 ID。');
  try {
    const detail = await api(`/devices/${node}`);
    if (detail?.device?.id !== node) throw new Error('云端返回了不同的设备身份，请停止操作并刷新。');
    return { kind: 'existing', detail };
  } catch (error) {
    if (error.status === 404 && error.code === 'device_not_found') return { kind: 'new', detail: null };
    throw error;
  }
}
export function currentProvisionConfig(detail, now = Date.now()) {
  const id = detail?.device?.desired_config_id;
  const published = detail?.configs?.find(c => c.id === id);
  if (!id || !published) return null;
  const c = published.config;
  const placement = detail.placements?.find(p => p.id === c?.placement_id);
  if (c?.protocol !== 'campuspulse/2' || c.node_id !== detail.device.id || Date.parse(c.accept_until) <= now || !Number.isFinite(Date.parse(c.accept_until))) return null;
  if (!placement || placement.valid_from_ms > now || (placement.effective_valid_until_ms ?? placement.valid_until_ms ?? Infinity) <= now) return null;
  return { id, published, placement, dataset: c.dataset };
}

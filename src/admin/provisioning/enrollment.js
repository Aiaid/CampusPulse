import { sameWorkPurposes, validateWorkPurposes } from '../work-purposes.js';
export const NODE_PATTERN = /^cp_[a-f0-9]{12}$/;
export const TOKEN_PATTERN = /^cpd_[a-f0-9]{64}$/;
export const DEVICE_API_ORIGIN = 'https://pulse.anend.net';
export function provisionConfig(node, placement, id, dataset = 'controlled_test', now = Date.now()) {
  return { protocol: 'campuspulse/2', capture_config_id: id, node_id: node, placement_id: placement, dataset,
    capture_profile: 'address_metrics', allowed_streams: ['ble_windows', 'address_summaries', 'node_status'],
    scan: { stack: 'nimble', adapter_version: 'cp-nimble-v2', mode: 'passive', interval_ms: 100, window_ms: 100, filter_duplicates: false, host_filter: 'none' },
    raw_capture: { mode: 'off' }, identity_scheme: 'mac', accept_until: new Date(now + 7 * 86400000).toISOString(),
    summary: { window_ms: 120000, bin_ms: 40000, max_addresses: 64 }, control: { lease_ms: 120000 },
    upload_policy: { max_items: 16, max_body_bytes: 4096, flush_max_age_ms: 5000, warn_pct: 60, raw_pause_pct: 80, critical_pct: 95, resume_pct: 40, overload_action: 'pause_raw' } };
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

// A save operation owns its immutable payload until its outcome is known. Keep
// the same operation ID for retries, and use a new ID after editing the form.
const settingsOperations = new WeakMap();
const settingsPayload = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export async function saveProvisionSettings(api, node, operationId, place, dataset, observation_kinds) {
  const suffix = String(operationId || '').replaceAll('-', '');
  if (!NODE_PATTERN.test(node) || !/^[a-z0-9_]{1,44}$/.test(suffix)) throw new Error('保存操作或设备身份无效，请重新读取设备。');
  if (observation_kinds !== undefined) validateWorkPurposes(observation_kinds);
  const targetPlace = place || null, signature = JSON.stringify([targetPlace, dataset, observation_kinds ? [...observation_kinds].sort() : null]);
  const matchesPurposes = placement => observation_kinds === undefined || sameWorkPurposes(placement?.observation_kinds, observation_kinds);
  let operations = settingsOperations.get(api);
  if (!operations) { operations = new Map(); settingsOperations.set(api, operations); }
  const key = `${node}:${suffix}`;
  let operation = operations.get(key);
  if (operation && operation.signature !== signature) throw new Error('本次保存的内容已变化，请使用新的保存操作。');
  if (!operation) { operation = { signature }; operations.set(key, operation); }
  const id = `${node}-c-${suffix}`, placementId = `${node}-p-${suffix}`;
  let detail = await api(`/devices/${node}`);
  if (detail?.device?.id !== node) throw new Error('云端返回了不同的设备身份，请停止操作并刷新。');
  const configs = await api(`/configs?node_id=${node}`);
  const published = configs.configs.find(c => c.id === id) || detail.configs?.find(c => c.id === id);
  let draft = configs.drafts.find(c => c.id === id);
  const saved = published || draft;
  if (saved) {
    const placement = detail.placements?.find(p => p.id === saved.config.placement_id);
    if (saved.config.node_id !== node || saved.config.capture_config_id !== id || saved.config.dataset !== dataset || !placement || (placement.place_id || null) !== targetPlace || !matchesPurposes(placement)) {
      throw new Error('本次保存操作已有不同内容，请重新读取并使用新的保存操作。');
    }
    if (operation.body && settingsPayload(operation.body) !== settingsPayload({ config: saved.config, raw_retention_hours: saved.raw_retention_hours, aggregate_retention_days: saved.aggregate_retention_days })) {
      throw new Error('本次保存的配置已被修改，请重新读取后保存。');
    }
  }
  if (published) {
    if (detail.device.desired_config_id !== id) throw new Error('配置已保存，但目前分配已变化；请重新读取设备。');
    if (currentProvisionConfig(detail)?.id !== id) throw new Error('本次保存的位置或配置已失效，请重新读取并再次保存。');
    return id;
  }
  if (draft && operation.body && detail.device.desired_config_id !== operation.desired) {
    throw new Error('当前设备配置已变化，请重新读取后保存。');
  }
  const current = currentProvisionConfig(detail);
  if (!draft && !operation.body && current && (current.placement.place_id || null) === targetPlace && current.dataset === dataset && matchesPurposes(current.placement)) return current.id;
  if (!draft && !operation.body) {
    const existing = detail.configs?.find(c => c.id === detail.device.desired_config_id);
    if (detail.device.desired_config_id && !existing) throw new Error('未能读取当前采集配置，请刷新后再保存。');
    const now = Date.now();
    const placement = detail.placements?.find(p => p.id === existing?.config?.placement_id);
    const samePlace = placement && (placement.place_id || null) === targetPlace && matchesPurposes(placement) && placement.valid_from_ms <= now && (placement.effective_valid_until_ms ?? placement.valid_until_ms ?? Infinity) > now;
    const config = existing ? structuredClone(existing.config) : provisionConfig(node, samePlace ? placement.id : placementId, id, dataset, now);
    Object.assign(config, { capture_config_id: id, node_id: node, placement_id: samePlace ? placement.id : placementId, dataset });
    if (!Number.isFinite(Date.parse(config.accept_until)) || Date.parse(config.accept_until) <= now) config.accept_until = new Date(now + 7 * 86400000).toISOString();
    operation.body = { config, raw_retention_hours: existing?.raw_retention_hours ?? 24, aggregate_retention_days: existing?.aggregate_retention_days ?? 30 };
    operation.placement = samePlace ? null : { id: placementId, place_id: targetPlace, valid_from_ms: now, valid_until_ms: null, ...(observation_kinds === undefined ? {} : { observation_kinds: [...observation_kinds] }) };
    operation.desired = detail.device.desired_config_id;
  }
  if (!draft) {
    if (detail.device.desired_config_id !== operation.desired) throw new Error('当前设备配置已变化，请重新读取后保存。');
    if (operation.placement) {
      const existingPlacement = detail.placements?.find(p => p.id === placementId);
      if (existingPlacement && ((existingPlacement.place_id || null) !== targetPlace || existingPlacement.valid_from_ms !== operation.placement.valid_from_ms || existingPlacement.valid_until_ms !== operation.placement.valid_until_ms || !matchesPurposes(existingPlacement))) throw new Error('本次保存的地点或工作用途记录已变化，请重新读取后保存。');
      if (!existingPlacement) await api(`/devices/${node}/placements`, { method: 'POST', body: operation.placement });
    }
    draft = (await api('/configs', { method: 'POST', body: operation.body })).draft;
  }
  await api(`/configs/${id}/validate`, { method: 'POST', body: { revision: draft.revision } });
  await api(`/configs/${id}/publish`, { method: 'POST', body: { revision: draft.revision } });
  detail = await api(`/devices/${node}`);
  if (detail.device.desired_config_id !== id) throw new Error('配置已保存，但目前分配已变化；请重新读取设备。');
  return id;
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

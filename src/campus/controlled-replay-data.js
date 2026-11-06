// Historical administrator evidence is deliberately separate from public field reads.
export const CONTROLLED_REPLAY_SCHEMA = 'campuspulse-replay-view/1';
const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const signedInteger = value => Number.isSafeInteger(value);
const invalid = () => { throw new Error('历史回放数据无效，未将其作为现场数据展示'); };
const categories = ['phone_candidate', 'e_bike_candidate', 'car_candidate', 'other', 'unknown', 'conflicting'];

export function controlledReplayId(search = '') {
  // Presence is intentional, including an empty/invalid ID: never silently fall back to field.
  const query = new URLSearchParams(search);
  return query.has('capture_replay') ? query.get('capture_replay') : null;
}

export function controlledReplayPath(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('无效的历史回放编号');
  return `/api/v1/admin/replays/${encodeURIComponent(id)}`;
}

export function normalizeControlledReplay(body, requestedId) {
  if (!object(body) || body.schema !== CONTROLLED_REPLAY_SCHEMA || body.dataset !== 'controlled_test'
    || body.source !== 'historical_cpraw' || body.id !== requestedId || !idPattern.test(body.id)
    || typeof body.label !== 'string' || !body.label.trim() || body.label.length > 160
    || !(body.place_id === null || typeof body.place_id === 'string')
    || typeof body.imported_at !== 'string' || !Number.isFinite(Date.parse(body.imported_at))
    || !hashPattern.test(body.body_sha256) || !integer(body.window_ms) || !body.window_ms
    || !integer(body.bin_ms) || !body.bin_ms || !object(body.source_metadata)
    || body.source_metadata.time_semantics !== 'historical_capture'
    || !Array.isArray(body.source_metadata.sha256) || !body.source_metadata.sha256.length
    || !body.source_metadata.sha256.every(hash => typeof hash === 'string' && hashPattern.test(hash))
    || !integer(body.source_metadata.total_reports) || !integer(body.source_metadata.replayed_reports)
    || body.source_metadata.replayed_reports !== body.source_metadata.total_reports
    || !Array.isArray(body.source_metadata.clock_anchors)
    || !Array.isArray(body.windows) || !body.windows.length || body.windows.length > 120) invalid();

  let previousEnd = null, totalWorkerReports = 0;
  for (const [index, entry] of body.windows.entries()) {
    const item = entry?.item;
    if (!object(entry) || !integer(entry.source_start_mono_us) || !integer(entry.source_end_mono_us)
      || previousEnd !== null && entry.source_start_mono_us !== previousEnd || !object(item) || item.seq !== index + 1
      || item.window_seq !== index + 1 || !integer(item.duration_ms) || !item.duration_ms || item.duration_ms > body.window_ms
      || entry.source_end_mono_us - entry.source_start_mono_us !== item.duration_ms * 1000
      || item.bin_ms !== body.bin_ms || !object(item.time) || !integer(item.time.mono_ms)
      || !integer(item.time.clock_epoch) || !item.time.clock_epoch
      || !(item.time.utc_ms === null || integer(item.time.utc_ms) && item.time.utc_ms <= 8640000000000000)
      || !(item.time.uncertainty_ms === null || integer(item.time.uncertainty_ms))
      || (item.time.utc_ms === null) !== (item.time.uncertainty_ms === null)
      || !object(item.categories) || !categories.every(key => integer(item.categories[key]))
      || !integer(item.visible_identifiers) || item.visible_identifiers !== categories.reduce((sum, key) => sum + item.categories[key], 0)
      || item.estimated_total !== null || !object(item.reports)
      || !['received', 'worker', 'adv', 'scan_response'].every(key => integer(item.reports[key]))
      || item.reports.adv + item.reports.scan_response !== item.reports.worker || item.reports.worker > item.reports.received
      || !Array.isArray(item.bins) || item.bins.length !== Math.ceil(item.duration_ms / item.bin_ms)
      || !item.bins.every(bin => object(bin) && ['worker_reports', 'visible_identifiers', 'rssi_samples'].every(key => integer(bin[key])) && signedInteger(bin.rssi_sum_dbm))
      || !object(item.rssi) || !integer(item.rssi.samples) || !signedInteger(item.rssi.sum_dbm)
      || !(item.rssi.min_dbm === null || signedInteger(item.rssi.min_dbm))
      || !(item.rssi.max_dbm === null || signedInteger(item.rssi.max_dbm))
      || !object(item.losses) || !['scan_coverage_ms', 'callback_drops', 'aggregation_drops', 'address_overflow_reports'].every(key => integer(item.losses[key]))
      || item.losses.scan_coverage_ms > item.duration_ms || !integer(item.quality_mask) || item.quality_mask > 63
      || !object(item.versions) || item.versions.extractor_version !== 'cp-v3-stats/1' || item.versions.ruleset_version !== 'unclassified-v1'
      || categories.some(key => key !== 'unknown' && item.categories[key] !== 0)
      || item.duration_ms !== body.window_ms && !(item.quality_mask & 1)
      || item.time.utc_ms === null && !(item.quality_mask & 2)) invalid();
    previousEnd = entry.source_end_mono_us;
    totalWorkerReports += item.reports.worker;
  }
  if (totalWorkerReports !== body.source_metadata.replayed_reports) invalid();
  return body;
}

/** Source extent is frozen at import. Import date and current time never extend it. */
export function controlledReplayBounds(data) {
  if (!data?.windows.length) return null;
  return { from: data.windows[0].source_start_mono_us, to: data.windows.at(-1).source_end_mono_us };
}

export function controlledWindowIndex(value, count) {
  return Math.max(0, Math.min(Math.max(0, count - 1), Number.isFinite(value) ? Math.trunc(value) : 0));
}

export function formatReplayTime(entry, edge = 'end', data = null) {
  if (!entry) return '源时间待载入';
  const utc = entry.item.time.utc_ms;
  if (utc !== null) {
    const milliseconds = utc - (edge === 'start' ? entry.item.duration_ms : 0);
    return `${new Date(milliseconds).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })} 北京`;
  }
  const origin = data?.windows[0]?.source_start_mono_us ?? 0;
  const elapsed = (entry[edge === 'start' ? 'source_start_mono_us' : 'source_end_mono_us'] - origin) / 1_000_000;
  return `源起点 +${elapsed.toFixed(3)} 秒（绝对时间未知）`;
}

export const replayQualityLabels = mask => [[1, '非完整窗口'], [2, '源时钟存在不确定性'], [4, '扫描覆盖不足'], [8, '标识表溢出'], [16, '回调丢失'], [32, '聚合丢失']].filter(([bit]) => mask & bit).map(([, label]) => label);

/** Generation guard protects against late JSON completion after abort or source changes. */
export function createControlledReplayReader(onState, fetcher = (...args) => fetch(...args)) {
  let generation = 0, active;
  return {
    async read(id) {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      const request = ++generation;
      const current = () => generation === request && !controller.signal.aborted;
      onState({ id, loading: true, data: null, error: '', unauthorized: false });
      let timeout;
      try {
        const path = controlledReplayPath(id);
        const result = await Promise.race([
          (async () => {
            const response = await fetcher(path, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
            if (response.status === 401 || response.status === 403) return { unauthorized: true };
            if (!response.ok) throw new Error(response.status === 404 ? '没有找到此历史回放' : `历史回放读取失败（${response.status}）`);
            return { data: normalizeControlledReplay(await response.json(), id) };
          })(),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('历史回放读取超时，请重试')), 45_000); }),
        ]);
        if (result.unauthorized) {
          if (current()) onState({ id, loading: false, data: null, error: '请先在同站点登录管理员，再返回此回放', unauthorized: true });
          return;
        }
        if (current()) onState({ id, loading: false, data: result.data, error: '', unauthorized: false });
      } catch (problem) {
        if (current()) onState({ id, loading: false, data: null, error: problem instanceof Error ? problem.message : '历史回放读取失败', unauthorized: false });
      } finally { clearTimeout(timeout); controller.abort(); }
    },
    cancel() { generation += 1; active?.abort(); active = null; },
  };
}

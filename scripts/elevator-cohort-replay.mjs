import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { detectCohortEvents, ruleConfig } from '../worker/elevator-cohort-rules.js';
import { projectAddressWindow } from '../worker/elevator-cohort-adapter.js';

const scope = { node_id: 'synthetic-node', boot_id: 'synthetic-boot',
  placement_id: 'synthetic-lobby', capture_config_id: 'synthetic-config', dataset: 'demo' };

export function syntheticDemo() {
  // Locally authored synthetic identifiers, never field captures.
  const ids = Array.from({ length: 18 }, (_, i) => `02:00:00:00:00:${i.toString(16).padStart(2, '0')}`);
  const windows = [];
  for (let n = 0; n < 4; n++) {
    const time = { mono_ms: (n + 1) * 30000, utc_ms: null, clock_epoch: 0, uncertainty_ms: null };
    const present = n === 0 ? ids : ids.slice(6);
    windows.push({ scope: { ...scope },
      window: { seq: n + 1, time, duration_ms: 30000, scan_enabled_ms: 30000,
        visible_identifiers: present.length, reports_aggregated: present.length * 6,
        aggregation_drops: 0, unique_table_overflow: false, quality_flags: [] },
      summaries: present.map((address, i) => ({ seq: n * 18 + i + 1, window_seq: n + 1,
        time, duration_ms: 30000, bin_ms: 5000, address, address_type: 'random',
        reports: 6, adv_reports: 6, scan_response_reports: 0,
        first_offset_ms: 1000, last_offset_ms: 29000, bins: [1, 1, 1, 1, 1, 1] })),
    });
  }
  return { source: 'synthetic', windows };
}

/** Input is PRIVATE v2 window+summary bundles in capture order.
 * No sorting: delayed/reordered material must be explicitly reconstructed by a
 * trusted store adapter. This replay is not a historical as-of backtest. */
export function replay(input, overrides = {}) {
  if (!input || !['synthetic', 'private_capture'].includes(input.source) ||
      !Array.isArray(input.windows) || input.windows.length > 128) throw new Error('invalid_replay_input');
  const config = ruleConfig(overrides);
  if (input.source === 'synthetic' && input.windows.some(w => w.scope?.dataset !== 'demo')) throw new Error('synthetic_dataset_mismatch');
  const bins = input.windows.flatMap(w => projectAddressWindow(w, config.bin_ms));
  const result = detectCohortEvents(bins, { config });
  return {
    source: input.source, mode: 'offline_replay', realtime: false,
    computed_at: new Date().toISOString(),
    interpretation: '群体消失规则候选；不代表已确认上梯、人数或候梯时间预测。',
    ...result,
  };
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

export function htmlReport(result) {
  const rows = result.events.map(e => `<tr><td>${e.event_from_mono_ms / 1000}–${e.event_to_mono_ms / 1000} 秒</td><td>${e.lost_identifiers} / ${e.baseline_identifiers}</td><td>${e.confirmed_at_mono_ms / 1000} 秒</td><td>${e.reappearance_flag ? '确认后有标识回返' : '未核实'}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CampusPulse 候梯区规则回放</title><style>body{font:16px/1.7 system-ui;margin:40px auto;padding:0 20px;max-width:850px;color:#153048;background:#f5f8fa}article{background:white;padding:24px;border-radius:14px}table{width:100%;border-collapse:collapse}th,td{padding:10px;text-align:left;border-bottom:1px solid #dde5eb}.tag{color:#8b4400;font-weight:bold}.table{overflow:auto}</style><article><p>CampusPulse · 候梯区事件研究</p><h1>一起消失的蓝牙标识，可能说明什么？</h1><p class="tag">${result.source === 'synthetic' ? '合成数据演示' : '私有采集离线回放'} · 非实时 · 尚未现场验证</p><p>电梯厅内的一批蓝牙广播，如果在接近的时刻停止出现，可能与一批人进入电梯有关。我们先确认这些标识此前稳定可见，再等待连续缺席，并排除扫描中断与摘要未到齐的情况。</p><p>同样的现象也可能来自走出大厅、遮挡或地址变化。这里展示的是规则候选，标识数不等于人数，也没有预测下一趟电梯或候梯秒数。</p><p>规则状态：${escapeHtml(result.status)} · 合格桶 ${result.usable_bins} · 拒绝桶 ${result.rejected_bins}</p><div class="table"><table><thead><tr><th>最后可见区间（启动后）</th><th>消失 / 原稳定标识</th><th>缺席确认时刻</th><th>验证状态</th></tr></thead><tbody>${rows || '<tr><td colspan="4">本次回放暂无满足条件的候选；请同时检查数据质量。</td></tr>'}</tbody></table></div><p>首次预热 30 秒；默认另外等待聚集范围与连续缺席证据。时间分辨率约 5 秒，30 秒闭合上传窗口还会增加延迟。</p><p>现场请对照记录“进入电梯”和“走出大厅”两类事件。</p><small>规则版本：${escapeHtml(result.rule_version)} · 计算时间：${escapeHtml(result.computed_at)}</small></article></html>`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const useDemo = args.includes('--demo');
    const inputPath = args.find(a => !a.startsWith('--'));
    if (!useDemo && !inputPath) throw new Error('usage: node scripts/elevator-cohort-replay.mjs --demo | private-input.json [--html]');
    const bytes = useDemo ? null : await readFile(inputPath);
    if (bytes && bytes.length > 8 * 1024 * 1024) throw new Error('input_too_large');
    const result = replay(useDemo ? syntheticDemo() : JSON.parse(bytes.toString('utf8')));
    if (args.includes('--html')) {
      // Explicit output only. Output contains aggregates, never address sets.
      const output = useDemo ? 'elevator-demo.html' : 'elevator-replay.html';
      await writeFile(output, htmlReport(result), { flag: 'wx' });
      process.stdout.write(`Wrote ${output}\n`);
    } else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    // Input JSON may contain private addresses; never print raw parse errors.
    const safe = error instanceof Error && /^[a-z0-9_: .|\[\]-]+$/i.test(error.message) ? error.message : 'replay_failed';
    process.stderr.write(`${safe}\n`); process.exitCode = 1;
  }
}

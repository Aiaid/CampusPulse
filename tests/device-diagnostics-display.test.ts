import { expect, it } from 'vitest';
import { ageText, statusEvidence } from '../src/admin/device-diagnostics.js';
const now = Date.UTC(2026, 9, 25);
const device = { stale_after_seconds: 60, latest_control: { boot_id: 'new' }, latest_status: { received_at: new Date(now - 1000).toISOString(), boot_id: 'new', item: { time: { utc_ms: now - 1000 } } } };
it('distinguishes fresh control from old-boot, stale and delayed status evidence', () => {
  expect(statusEvidence(device, now).label).toBe('最近状态 · 同一控制启动');
  expect(statusEvidence({ ...device, latest_status: { ...device.latest_status, boot_id: 'old' } }, now).label).toBe('旧启动状态');
  expect(statusEvidence(device, now + 61000).label).toBe('状态已过期');
  expect(statusEvidence({ ...device, latest_status: { ...device.latest_status, item: { time: { utc_ms: now - 90000 } } } }, now).label).toBe('延迟上传的历史状态');
  expect(statusEvidence({ ...device, latest_status: null }, now).label).toBe('尚无状态样本');
  expect(statusEvidence({ ...device, latest_control: null }, now).label).toBe('最近状态 · 启动未核对');
  expect(ageText(null, now)).toBe('时间未知');
});

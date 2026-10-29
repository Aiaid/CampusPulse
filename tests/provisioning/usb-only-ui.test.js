import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Provisioning from '../../src/admin/Provisioning.jsx';
import { siteHelp } from '../../src/admin/help-site.js';
import { deviceHelp } from '../../src/admin/help-device.js';

vi.mock('../../src/admin/shared.jsx', async importOriginal => ({
  ...await importOriginal(),
  useAdmin: () => ({ api: vi.fn(), sensitiveAction: vi.fn(), notify: vi.fn() }),
  useResource: () => ({ loading: false, data: { places: [] }, error: null }),
}));

afterEach(() => vi.unstubAllGlobals());
const render = () => renderToStaticMarkup(React.createElement(Provisioning, { onClose: vi.fn() }));
const setupButton = html => html.match(/<button[^>]*>选择 USB 设备并开始配网<\/button>/)?.[0];

describe('USB-only device setup', () => {
  it('offers USB provisioning and read-only diagnostics on supported browsers', () => {
    vi.stubGlobal('isSecureContext', true);
    const selectPort = vi.fn(), selectBluetooth = vi.fn();
    vi.stubGlobal('navigator', { serial: { requestPort: selectPort }, bluetooth: { requestDevice: selectBluetooth } });
    const html = render();
    expect(setupButton(html)).toBeDefined();
    expect(setupButton(html)).not.toContain('disabled');
    expect(html).toContain('连接 USB 只读诊断');
    expect(html).toContain('通过 USB 发送给设备');
    expect(html).toContain('PEAP/MSCHAPv2');
    for (const removed of ['蓝牙配网', '设备热点配网', '设备屏幕上的配网码', '设备屏幕上的工厂节点 ID', '本地配网交接', '192.168.4.1']) expect(html).not.toContain(removed);
    // Rendering offers a user gesture; it must not prompt for any device itself.
    expect(selectPort).not.toHaveBeenCalled();
    expect(selectBluetooth).not.toHaveBeenCalled();
  });

  it.each([
    [false, { serial: { requestPort: vi.fn() } }],
    [true, { bluetooth: { requestDevice: vi.fn() } }],
    [true, {}],
  ])('blocks setup with secure-context=%s when Web Serial is unavailable', (secure, navigator) => {
    vi.stubGlobal('isSecureContext', secure);
    vi.stubGlobal('navigator', navigator);
    const html = render();
    expect(setupButton(html)).toContain('disabled');
    expect(html).toContain('此浏览器没有可用的 Web Serial');
    expect(html).toContain('桌面 Chrome / Edge');
    expect(html).not.toContain('连接 USB 只读诊断');
    expect(html).not.toContain('设备热点配网');
    expect(html).not.toContain('蓝牙配网');
  });

  it('documents USB delivery while keeping local-save and cloud evidence distinct', () => {
    expect(siteHelp['配网方式'].title).toBe('USB 配网');
    const help = JSON.stringify([
      siteHelp['配网方式'], siteHelp['确认现场设备'], siteHelp['设置 Wi-Fi'],
      siteHelp['保留设备内现有凭证'], deviceHelp['device.provision'],
    ]);
    expect(help).toContain('USB');
    expect(help).toContain('Web Serial');
    expect(help).toContain('云端回执');
    expect(help).not.toMatch(/蓝牙|本地热点|设备本地页面/);
    expect(siteHelp['设备屏幕上的配网码']).toBeUndefined();
    expect(siteHelp['复制到设备本地页面的交接内容']).toBeUndefined();
  });
});

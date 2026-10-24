import { bytes, establishSecurity1 } from './security1.js';
export const SERVICE_UUID = 'f0c00000-7b3a-4f1d-a848-8baf42c67a01';
export const SESSION_UUID = 'f0c0ff51-7b3a-4f1d-a848-8baf42c67a01';
export const APP_UUID = 'f0c0ff52-7b3a-4f1d-a848-8baf42c67a01';
export function bluetoothSupport(nav = globalThis.navigator) { return !!(globalThis.isSecureContext && nav?.bluetooth?.requestDevice && globalThis.crypto?.subtle); }
// Call synchronously from the button gesture, before any await/cloud request.
export function selectProvisioningDevice(nav = globalThis.navigator) { return nav.bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }] }); }
export async function connectProvisioning(device, proof) {
  let cipher; let busy = false;
  try {
    const server = await device.gatt.connect(), service = await server.getPrimaryService(SERVICE_UUID);
    const session = await service.getCharacteristic(SESSION_UUID), app = await service.getCharacteristic(APP_UUID);
    const exchange = async (characteristic, data) => {
      if (data.length > 512) throw new Error('配网请求超出 BLE 长度限制。');
      await characteristic.writeValueWithResponse(data);
      return bytes(await characteristic.readValue()).slice();
    };
    cipher = await establishSecurity1(data => exchange(session, data), proof);
    const client = { device, close: () => { cipher = null; if (device.gatt.connected) device.gatt.disconnect(); },
      async request(body) {
        if (busy || !cipher) throw new Error('配网会话忙或已经断开，请重新连接。'); busy = true;
        try {
          const plain = new TextEncoder().encode(JSON.stringify({ v: 1, ...body }));
          const encrypted = await cipher.apply(plain); plain.fill(0);
          const reply = await cipher.apply(await exchange(app, encrypted));
          let data; try { data = JSON.parse(new TextDecoder().decode(reply)); } finally { reply.fill(0); }
          if (data.v !== 1 || !data.ok) throw new Error(data.reason || '设备拒绝配网请求。'); return data;
        } catch (error) { client.close(); throw error; } finally { busy = false; }
      } };
    const identity = await client.request({ op: 'info' });
    if (!/^cp_[a-f0-9]{12}$/.test(identity.node_id)) throw new Error('设备没有返回有效工厂节点 ID。');
    return { client, identity };
  } catch (error) { if (device.gatt.connected) device.gatt.disconnect(); if (error.name === 'NotSupportedError') throw new Error('此浏览器不支持设备所需的蓝牙或 X25519 加密，请选择设备热点配网。'); throw error; }
}

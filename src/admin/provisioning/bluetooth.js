import { bytes, checkedReply } from './protocol.js';
import { establishSecurity2 } from './security2.js';
export const SERVICE_UUID = 'f0c00000-7b3a-4f1d-a848-8baf42c67a01';
export const SESSION_UUID = 'f0c0ff51-7b3a-4f1d-a848-8baf42c67a01';
export const APP_UUID = 'f0c0ff52-7b3a-4f1d-a848-8baf42c67a01';
export function bluetoothSupport(nav = globalThis.navigator) { return !!(globalThis.isSecureContext && nav?.bluetooth?.requestDevice && globalThis.crypto?.subtle && typeof BigInt === 'function'); }
export function selectProvisioningDevice(nav = globalThis.navigator) { return nav.bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }] }); }
export async function connectProvisioning(device, proof) {
  let cipher; let busy = false;
  try {
    const server = await device.gatt.connect(), service = await server.getPrimaryService(SERVICE_UUID);
    const session = await service.getCharacteristic(SESSION_UUID), app = await service.getCharacteristic(APP_UUID);
    const exchange = async (characteristic, data) => {
      if (data.length > 512) throw new Error('配网请求超出 BLE 长度限制。');
      await characteristic.writeValueWithResponse(data);
      const reply = bytes(await characteristic.readValue()).slice();
      if (reply.length > 512) throw new Error('设备响应超出 BLE 长度限制。'); return reply;
    };
    cipher = await establishSecurity2(data => exchange(session, data), proof);
    const client = { device, transport: 'ble', close: () => { cipher?.close(); cipher = null; if (device.gatt.connected) device.gatt.disconnect(); },
      async request(body) {
        if (busy || !cipher) throw new Error('配网会话忙或已经断开，请重新连接。'); busy = true;
        try {
          const plain = new TextEncoder().encode(JSON.stringify({ v: 1, ...body }));
          let encrypted;
          try { if (plain.length > 496) throw new Error('配网请求超出 BLE 长度限制。'); encrypted = await cipher.encrypt(plain); } finally { plain.fill(0); }
          const reply = await cipher.decrypt(await exchange(app, encrypted));
          let data; try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply)); } catch { throw new Error('设备加密响应格式无效。'); } finally { reply.fill(0); }
          return checkedReply(data);
        } catch (error) { client.close(); throw error; } finally { busy = false; }
      } };
    const identity = await client.request({ op: 'info' });
    if (!/^cp_[a-f0-9]{12}$/.test(identity.node_id) || identity.transport !== 'ble' || identity.security !== 'security2') throw new Error('设备没有返回有效工厂身份或 Security 2 状态。');
    return { client, identity };
  } catch (error) { cipher?.close(); if (device.gatt.connected) device.gatt.disconnect(); if (error.name === 'NotSupportedError') throw new Error('此浏览器不支持所需的蓝牙或加密，请选择 USB 或设备热点配网。'); throw error; }
}

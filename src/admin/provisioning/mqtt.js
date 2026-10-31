export const MQTT_BROKER_URI = 'mqtts://q9a692f8.ala.cn-hangzhou.emqxsl.cn:8883';

// Broker identities are independent of factory node IDs. Accept only the
// production endpoint and bounded fields; never infer a namespace from a node.
export function mqttSettings(value) {
  if (!value || value.uri !== MQTT_BROKER_URI ||
      typeof value.username !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(value.username) ||
      typeof value.password !== 'string' || !/^[\x21-\x7e]{1,96}$/.test(value.password) ||
      typeof value.namespace !== 'string' || !/^[a-z0-9_-]{1,15}$/.test(value.namespace)) {
    throw new Error('未收到有效的杭州 MQTT 授权。请检查凭证池验证状态；本次不会改用 HTTPS。');
  }
  return { uri: value.uri, username: value.username, password: value.password, namespace: value.namespace };
}

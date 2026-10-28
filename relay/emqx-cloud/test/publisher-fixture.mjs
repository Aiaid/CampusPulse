// Test build substitution only. Never referenced by the production Wrangler entry.
export async function publishMqttReply(options) {
  const response = await fetch('https://synthetic-reply.invalid/' + options.topic, {
    method:'POST',body:options.payload,
  });
  if (response.status !== 204) throw new Error('synthetic_publish_failed');
  return {acknowledged:true,packetId:1};
}

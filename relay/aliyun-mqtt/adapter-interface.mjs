/**
 * Adapter integration point, NOT a deployed Alibaba FC handler.
 *
 * authenticateAndNormalize must authenticate the invocation/event source and
 * obtain principal/topic from broker-attested metadata. A device JSON field or
 * an unauthenticated HTTP JSON event is never trusted context. Provider-specific
 * event formats, service roles, topic ACLs and publishing credentials belong in
 * the deployment adapter after the actual managed product is selected.
 */
export function createHandler({ relay, authenticateAndNormalize, publishReply }) {
  if ([relay, authenticateAndNormalize, publishReply].some((value) => typeof value !== 'function')) throw new Error('Adapter functions required');
  return async function handler(event, invocationContext) {
    const trusted = await authenticateAndNormalize(event, invocationContext);
    const result = await relay(trusted);
    await publishReply(result.replyTopic, Buffer.from(JSON.stringify(result.reply)));
    // This records only reply publication. It is not a cloud durable receipt,
    // even when a broker confirms publication or the FC invocation completes.
    return { kind: 'reply_published', request_id: result.reply.request_id };
  };
}

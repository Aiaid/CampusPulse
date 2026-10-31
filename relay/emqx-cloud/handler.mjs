import { timingSafeEqual } from 'node:crypto';
import {MAX_ORIGINAL_BODY, MAX_V3_WIRE, parseV3Frame} from './v3-frame.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const MAX_BODY = MAX_ORIGINAL_BODY;
const MAX_EVENT = 12288;
const MAX_REPLY = 2048;
const BOOT = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const TOPIC = new RegExp(`^cp/v1/([a-z0-9_-]{1,15})/(${BOOT})/req/(contact|config|activation|ingest)/([1-9][0-9]{0,9})$`);
const UNKNOWN = encoder.encode('{"error":"gateway_outcome_unknown"}');

class Rejected extends Error {
  constructor(status) { super('rejected'); this.status = status; }
}

function response(status) {
  return new Response(null, {status, headers: {'Cache-Control': 'no-store'}});
}

async function boundedBody(body, limit, signal) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const parts = []; let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, {once: true});
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('deadline');
      const {done, value} = await reader.read();
      if (signal?.aborted) throw new Error('deadline');
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Rejected(413);
      parts.push(value);
    }
    const out = new Uint8Array(length); let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  } catch (error) {
    // Cancellation need not settle in order to reject an oversized event.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function parseEvent(bytes) {
  try {
    const event = JSON.parse(decoder.decode(bytes));
    if (!event || Object.keys(event).sort().join(',') !== 'payload_b64,published_at_ms,qos,retain,topic,username' ||
        event.qos !== 1 || event.retain !== false || typeof event.topic !== 'string' ||
        !Number.isSafeInteger(event.published_at_ms) || event.published_at_ms<=0 ||
        event.published_at_ms<Date.now()-120000 || event.published_at_ms>Date.now()+10000 ||
        typeof event.username !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(event.username) ||
        typeof event.payload_b64 !== 'string' || event.payload_b64.length > Math.ceil(MAX_V3_WIRE / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.payload_b64)) throw new Error();
    const match = TOPIC.exec(event.topic);
    if (!match || Number(match[4]) > 0xffffffff) throw new Error();
    const [,namespace,boot,op,rpc] = match;
    const wire = Uint8Array.from(atob(event.payload_b64), char => char.charCodeAt(0));
    if (btoa(String.fromCharCode(...wire)) !== event.payload_b64) throw new Error();
    const frame = parseV3Frame(wire);
    if (frame && op !== 'ingest') throw new Error();
    const body = frame ? frame.body : wire;
    if (body.length > MAX_BODY || (!frame && op === 'config' && body.length !== 0)) throw new Error();
    if (frame ? frame.v3.subop !== 2 : op !== 'config') {
      const payload = JSON.parse(decoder.decode(body));
      if (!payload || Array.isArray(payload) || typeof payload !== 'object' ||
          (!frame && op !== 'ingest' && payload.boot_id !== boot) ||
          (!frame && op === 'ingest' && (typeof payload.node_id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(payload.node_id)))) throw new Error();
    }
    return {username:event.username, namespace, boot, op, rpc:Number(rpc), body, wire,
      ...(frame ? {v3: frame.v3} : {}), publishedAtMs:event.published_at_ms,
      replyTopic: event.topic.replace('/req/', '/rep/')};
  } catch (error) {
    throw error instanceof Rejected ? error : new Rejected(400);
  }
}

async function within(work, milliseconds) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('deadline')),milliseconds);
    })]);
  } finally {clearTimeout(timer);}
}

async function authorize(rpc, env) {
  const identity=await within(()=>env.INGEST_SERVICE.authorize({username:rpc.username,namespace:rpc.namespace}),2000);
  if(!identity || typeof identity.node_id!=='string' || !/^[a-z0-9_-]{1,64}$/.test(identity.node_id)) throw new Rejected(403);
  return identity.node_id;
}

async function forward(rpc, env) {
  try {
    const result=await within(()=>env.INGEST_SERVICE.dispatch({username:rpc.username,
      namespace:rpc.namespace,boot:rpc.boot,op:rpc.op,rpc:rpc.rpc,body:rpc.body,
      ...(rpc.v3 ? {v3:rpc.v3} : {})}),10000);
    const maxReply = rpc.v3?.subop === 2 ? MAX_ORIGINAL_BODY : MAX_REPLY;
    if(!result || !Number.isInteger(result.status) || result.status<100 || result.status>599 ||
      !(result.body instanceof Uint8Array) || result.body.length>maxReply) throw new Error('invalid_response');
    return result;
  } catch {
    // A timeout cannot prove rollback. Only the original retried CF receipt
    // permits the device to release a frozen batch.
    return {status: 504, body: UNKNOWN};
  }
}

/** Authenticated broker webhook. No request or response payloads are logged. */
export async function handleWebhook(request, env, publishReply, dispatch) {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET' && !url.search) return response(204);
  if (url.pathname !== '/emqx' || url.search) return response(404);
  if (request.method !== 'POST') return response(405);
  try {
    if (typeof env.WEBHOOK_KEY !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(env.WEBHOOK_KEY)) throw new Rejected(503);
    const provided = request.headers.get('X-CP-Webhook-Key') ?? '';
    const expected = encoder.encode(env.WEBHOOK_KEY); const actual = encoder.encode(provided);
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new Rejected(401);
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
        request.headers.has('Content-Encoding')) throw new Rejected(415);
    const length = request.headers.get('Content-Length');
    if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > MAX_EVENT)) throw new Rejected(413);
    const bytes = await boundedBody(request.body, MAX_EVENT);
    const rpc = parseEvent(bytes);
    const node=await authorize(rpc,env);
    if (dispatch) return response(await dispatch(node, bytes));
    return response(await handleBrokerEvent(bytes, env, publishReply));
  } catch (error) {
    return response(error instanceof Rejected ? error.status : 503);
  }
}

/** Called only after the public webhook is authenticated, or by its private DO. */
export async function handleBrokerEvent(bytes, env, publishReply, beforeForward) {
  try {
    const rpc = parseEvent(bytes);
    const node=await authorize(rpc,env);
    if (env.MQTT_PASSWORD === env.WEBHOOK_KEY) throw new Rejected(503);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rpc.wire));
    const hash = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
    if (beforeForward) {
      const status = await beforeForward({node, boot: rpc.boot, op: rpc.op,
        rpc: rpc.rpc, digest: hash, bytes: rpc.wire.length,publishedAtMs:rpc.publishedAtMs,
        ...(rpc.v3 ? {v3:rpc.v3} : {})});
      if (status !== undefined) throw new Rejected(status);
    }
    const result = await forward(rpc, env);
    const payload = new Uint8Array(result.body.length + 2);
    payload[0] = result.status >>> 8; payload[1] = result.status & 255; payload.set(result.body, 2);
    // Wait for the broker's PUBACK for the response publication before the HTTP
    // action is considered delivered. Device application validation is separate.
    await publishReply({hostname: env.BROKER_HOST, username: env.MQTT_USERNAME,
      password: env.MQTT_PASSWORD, topic: rpc.replyTopic, payload, timeoutMs: 6000,
      ...(rpc.v3?.subop === 2 ? {maxPayloadBytes: MAX_ORIGINAL_BODY + 2} : {})});
    return 204;
  } catch (error) {
    // Provider retry is safe: exact bytes go through the API's own idempotency.
    // Never cache config leases or turn broker acceptance into data custody.
    return error instanceof Rejected ? error.status : 503;
  }
}

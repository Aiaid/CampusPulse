// No dependencies. Never print configuration values, private paths, or bodies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

function fail(message) { throw new Error(message); }
function required(o, k) {
  if (typeof o[k] !== 'string' || !o[k] || o[k].includes('\0')) fail(`Invalid ${k}`);
  return o[k];
}
function main() {
  const [input, output] = process.argv.slice(2);
  const repo = fs.realpathSync(fileURLToPath(new URL('../../../..', import.meta.url)));
  if (!input || !output || !path.isAbsolute(input)) fail('Absolute external config required');
  const actual = fs.realpathSync(input);
  if (actual === repo || actual.startsWith(repo + path.sep)) fail('Config must be outside repository');
  if ((fs.statSync(actual).mode & 0o077) !== 0) fail('Config permissions must be 0600 or stricter');
  const cfg = JSON.parse(fs.readFileSync(actual, 'utf8'));
  const allowed = new Set(['broker_uri','client_id','username','password','ca_file','request_topic',
    'reply_topic','unix_time','synthetic_node_id','body_fixture_file','expected_ack','deadline_ms']);
  if (!cfg || typeof cfg !== 'object' || Object.keys(cfg).some(k => !allowed.has(k))) fail('Unknown configuration fields');
  // Printable ASCII keeps JSON string escaping valid in C and prevents compiler
  // diagnostics from ever quoting invalid universal-character escapes in secrets.
  for (const key of ['broker_uri','client_id','username','password','request_topic','reply_topic','synthetic_node_id'])
    if (!/^[\x20-\x7e]{1,1024}$/.test(required(cfg,key))) fail(`Invalid ${key}`);
  const uri = new URL(required(cfg, 'broker_uri'));
  if (uri.protocol !== 'mqtts:' || uri.username || uri.password || uri.search || uri.hash ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/i.test(uri.hostname) || !/[a-z]/i.test(uri.hostname) ||
      (uri.pathname && uri.pathname !== '/')) fail('MQTTS DNS hostname origin required');
  for (const key of ['client_id','username','password','synthetic_node_id']) required(cfg,key);
  for (const key of ['request_topic','reply_topic']) {
    if (/[+#\r\n]/.test(required(cfg,key))) fail(`Exact ${key} required`);
  }
  if (cfg.request_topic === cfg.reply_topic) fail('Request and reply topics must differ');
  if (!Number.isSafeInteger(cfg.unix_time) || Math.abs(Date.now()/1000-cfg.unix_time)>86400)
    fail('Supply current unix_time within one day; certificate date checking is mandatory');
  const deadline = cfg.deadline_ms ?? 120000;
  if (!Number.isSafeInteger(deadline) || deadline < 10000 || deadline > 120000) fail('deadline_ms must be 10000..120000');
  const pem = fs.readFileSync(required(cfg,'ca_file'),'utf8');
  if (!pem.includes('-----BEGIN CERTIFICATE-----') || /PRIVATE KEY/.test(pem)) fail('Public certificate PEM required');
  let body = Buffer.alloc(0), ack = {};
  if (cfg.body_fixture_file) {
    body = fs.readFileSync(required(cfg,'body_fixture_file'));
    if (!body.length || body.length>8192) fail('Fixture must be 1..8192 exact bytes');
    const fixture = JSON.parse(body.toString('utf8'));
    if (fixture.node_id !== cfg.synthetic_node_id || fixture.dataset !== 'demo' || fixture.protocol!=='campuspulse/2')
      fail('Fixture must explicitly be demo dataset and match synthetic_node_id');
    if (!Array.isArray(fixture.items) || !fixture.items.length || fixture.items.length>128)
      fail('Fixture requires 1..128 items');
    ack = cfg.expected_ack;
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    if (!ack || Object.keys(ack).sort().join(',') !==
        'accepted_count,batch_id,body_sha256,boot_id,durability,node_id,stream') fail('Exact expected_ack metadata required');
    for (const key of ['node_id','boot_id','batch_id','stream'])
      if (typeof fixture[key] !== 'string' || ack[key] !== fixture[key]) fail(`Fixture mismatch: ${key}`);
    if (ack.body_sha256!==hash || ack.durability!=='committed' || !Number.isSafeInteger(ack.accepted_count) ||
        ack.accepted_count!==fixture.items.length)
      fail('Expected ACK must bind exact fixture SHA and committed positive count');
  } else if (cfg.expected_ack) fail('expected_ack requires a fixture');
  const lines = ['#pragma once'];
  for (const [key,value] of Object.entries({broker_uri:cfg.broker_uri, client_id:cfg.client_id,
    username:cfg.username,password:cfg.password,request_topic:cfg.request_topic,
    reply_topic:cfg.reply_topic,ca_pem:pem,body_base64:body.toString('base64'),
    body_sha256:crypto.createHash('sha256').update(body).digest('hex'), expected_ack:JSON.stringify(ack)}))
    lines.push(`static const char cfg_${key}[] = ${JSON.stringify(value)};`);
  lines.push(`#define CP_MQTT_UNIX_TIME ${cfg.unix_time}LL`, `#define CP_MQTT_DEADLINE_MS ${deadline}`,
    `#define CP_MQTT_HAS_FIXTURE ${body.length?1:0}`, `#define CP_MQTT_BODY_LENGTH ${body.length}`);
  fs.writeFileSync(output, lines.join('\n')+'\n', {mode:0o600});
  fs.chmodSync(output,0o600);
}
try { main(); } catch (error) {
  // Node/JSON/IO errors can quote a secret or private path. Only our fixed errors leave this process.
  const safe = /^(Invalid |Unknown configuration|Config |Absolute |MQTTS |Exact |Request and |Supply current |deadline_ms |Public certificate|Fixture |Expected ACK|expected_ack)/;
  process.stderr.write(safe.test(error.message) ? error.message+'\n' : 'Unable to prepare private configuration\n');
  process.exitCode=1;
}

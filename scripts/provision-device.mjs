import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateCaptureConfig } from '../worker/ingest-validation.ts';

const idPattern = /^[a-z0-9_-]{1,64}$/;
const maxEpochMs = 8640000000000000;
const fail = () => { throw new Error('Invalid provisioning input.'); };
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min && value <= maxEpochMs ? value : fail();

/** A placement is immutable and may intentionally have no fixed place_id. */
export function validatePlacement(value, config) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const keys = ['id', 'node_id', 'place_id', 'valid_from_ms', 'valid_until_ms'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
  if (typeof value.id !== 'string' || !idPattern.test(value.id) ||
      typeof value.node_id !== 'string' || !idPattern.test(value.node_id) ||
      value.id !== config.placement_id || value.node_id !== config.node_id) fail();
  if (value.place_id !== null && (typeof value.place_id !== 'string' || !idPattern.test(value.place_id))) fail();
  const valid_from_ms = integer(value.valid_from_ms);
  const valid_until_ms = value.valid_until_ms === null ? null : integer(value.valid_until_ms, valid_from_ms + 1);
  const acceptUntil = Date.parse(config.accept_until);
  if (valid_from_ms >= acceptUntil) fail();
  return { id: value.id, node_id: value.node_id, place_id: value.place_id, valid_from_ms, valid_until_ms };
}

/** Three ordered inserts for D1 db.batch; the bearer credential is only hashed. */
export function buildProvisioningStatements(configValue, placementValue, token) {
  const config = validateCaptureConfig(configValue);
  const placement = validatePlacement(placementValue, config);
  if (typeof token !== 'string' || !/^[!-~]{16,256}$/.test(token)) fail();
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');
  const configJson = JSON.stringify(config);
  const acceptUntil = integer(Date.parse(config.accept_until));
  return [
    `INSERT INTO device_nodes (id, credential_sha256) VALUES (${quote(config.node_id)}, ${quote(digest)});`,
    `INSERT INTO placements (id, node_id, place_id, valid_from_ms, valid_until_ms) VALUES (${quote(placement.id)}, ${quote(placement.node_id)}, ${placement.place_id === null ? 'NULL' : quote(placement.place_id)}, ${placement.valid_from_ms}, ${placement.valid_until_ms === null ? 'NULL' : placement.valid_until_ms});`,
    `INSERT INTO capture_configs (id, node_id, placement_id, dataset, config_json, accept_until_ms) VALUES (${quote(config.capture_config_id)}, ${quote(config.node_id)}, ${quote(config.placement_id)}, ${quote(config.dataset)}, ${quote(configJson)}, ${acceptUntil});`,
  ];
}

/** Plain SQL import file. Import batching and failure handling belong to Wrangler. */
export function buildProvisioningSql(configValue, placementValue, token) {
  return [
    '-- New-node provisioning. Run only after migrations and review the target D1 database.',
    '-- The bearer credential is never stored in this file; only its SHA-256 digest is.',
    ...buildProvisioningStatements(configValue, placementValue, token),
    '',
  ].join('\n');
}

function parseArgs(args) {
  const flags = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!['--config', '--placement', '--token-file', '--output'].includes(flag) ||
        flags.has(flag) || !args[i + 1] || args[i + 1].startsWith('--')) fail();
    flags.set(flag, args[i + 1]);
  }
  if (!flags.has('--config') || !flags.has('--placement') || !flags.has('--token-file')) fail();
  return flags;
}

function ensurePrivateOutput(path) {
  const cwd = process.cwd();
  const rel = relative(cwd, path);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    try { execFileSync('git', ['check-ignore', '--no-index', '--quiet', '--', path], { cwd, stdio: 'ignore' }); }
    catch { throw new Error('Output must be git-ignored.'); }
  }
}

export function main(args = process.argv.slice(2)) {
  const flags = parseArgs(args);
  const tokenPath = resolve(flags.get('--token-file'));
  const tokenStat = lstatSync(tokenPath);
  if (!tokenStat.isFile() || (tokenStat.mode & 0o077) !== 0) fail();
  const token = readFileSync(tokenPath, 'utf8');
  const config = JSON.parse(readFileSync(resolve(flags.get('--config')), 'utf8'));
  const placement = JSON.parse(readFileSync(resolve(flags.get('--placement')), 'utf8'));
  const sql = buildProvisioningSql(config, placement, token);
  const output = resolve(flags.get('--output') ?? '.wrangler/provision-device.sql');
  ensurePrivateOutput(output);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const fd = openSync(output, 'wx', 0o600);
  try { writeFileSync(fd, sql, { encoding: 'utf8' }); }
  finally { closeSync(fd); }
  console.log('Private provisioning SQL created. Apply only to the intended migrated D1 database.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch { console.error('Provisioning failed. Check private inputs, policy and ignored output path.'); process.exitCode = 1; }
}

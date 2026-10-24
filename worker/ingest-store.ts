import type { IngestBatch } from './ingest-validation';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface IngestAck {
  node_id: string;
  boot_id: string;
  stream: 'ble_windows' | 'ble_reports' | 'node_status';
  batch_id: string;
  body_sha256: string;
  accepted_count: number;
  durability: 'committed';
  receipt_id: string;
  received_at: string;
}

export interface IngestReceipt extends IngestAck {
  seq_first: number;
  seq_last: number;
  raw_object_key: string | null;
  expires_at_ms: number;
  retain_until_ms: number;
}

export class IngestStoreError extends Error {
  constructor(public status: number, public code: string, message = code) {
    super(message);
  }
}

interface ReceiptRow {
  node_id: string;
  boot_id: string;
  stream: IngestAck['stream'];
  batch_id: string;
  body_sha256: string;
  accepted_count: number;
  receipt_id: string;
  received_at: string;
  seq_first: number;
  seq_last: number;
  raw_object_key: string | null;
  expires_at_ms: number;
  retain_until_ms: number;
}

interface ConfigRow {
  accept_until_ms: number;
  raw_retention_hours: number;
  aggregate_retention_days: number;
}

const RECEIPT_COLUMNS = 'node_id,boot_id,stream,batch_id,body_sha256,accepted_count,receipt_id,received_at,seq_first,seq_last,raw_object_key,expires_at_ms,retain_until_ms';

function receiptFromRow(row: ReceiptRow): IngestReceipt {
  return { ...row, durability: 'committed' };
}

export function ackFromReceipt(receipt: IngestReceipt): IngestAck {
  return {
    node_id: receipt.node_id,
    boot_id: receipt.boot_id,
    stream: receipt.stream,
    batch_id: receipt.batch_id,
    body_sha256: receipt.body_sha256,
    accepted_count: receipt.accepted_count,
    durability: 'committed',
    receipt_id: receipt.receipt_id,
    received_at: receipt.received_at,
  };
}

export async function findReceipt(db: D1Database, nodeId: string, batchId: string): Promise<IngestReceipt | null> {
  const row = await db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM ingestion_batches WHERE node_id = ? AND batch_id = ?`)
    .bind(nodeId, batchId).first<ReceiptRow>();
  return row ? receiptFromRow(row) : null;
}

/** The registry is server-owned. Device payloads cannot create or update it. */
export async function findNodeByCredentialHash(db: D1Database, hash: string): Promise<{ id: string; enabled: number } | null> {
  return db.prepare('SELECT id, enabled FROM device_nodes WHERE credential_sha256 = ?')
    .bind(hash).first<{ id: string; enabled: number }>();
}

export interface StoredCaptureConfig extends ConfigRow {
  id: string;
  node_id: string;
  placement_id: string;
  dataset: string;
  config_json: string;
}

export async function findCaptureConfig(db: D1Database, nodeId: string, configId: string): Promise<StoredCaptureConfig | null> {
  return db.prepare('SELECT id,node_id,placement_id,dataset,config_json,accept_until_ms,raw_retention_hours,aggregate_retention_days FROM capture_configs WHERE node_id = ? AND id = ?')
    .bind(nodeId, configId).first<StoredCaptureConfig>();
}

/** Persist a validated batch. D1.batch commits its statements as one transaction. */
export async function commitBatch(
  db: D1Database,
  batch: IngestBatch,
  bodyHash: string,
  rawKey: string | null,
  now: number,
): Promise<{ ack: IngestAck; duplicate: boolean }> {
  // Idempotency is checked before config expiry so accepted, queued retries
  // continue to receive the original durable ACK after the policy closes.
  const prior = await findReceipt(db, batch.node_id, batch.batch_id);
  if (prior) {
    if (prior.body_sha256 !== bodyHash) throw new IngestStoreError(409, 'batch_conflict');
    return { ack: ackFromReceipt(prior), duplicate: true };
  }

  const config = await findCaptureConfig(db, batch.node_id, batch.capture_config_id);
  if (!config || config.placement_id !== batch.placement_id || config.dataset !== batch.dataset) {
    throw new IngestStoreError(422, 'capture_config_mismatch');
  }
  if (now > config.accept_until_ms) throw new IngestStoreError(410, 'capture_config_expired');
  if (batch.stream === 'ble_reports' && !rawKey) throw new IngestStoreError(503, 'raw_object_missing');
  if (batch.stream !== 'ble_reports' && rawKey) throw new IngestStoreError(422, 'unexpected_raw_object');

  const seqFirst = batch.items[0].seq;
  const seqLast = batch.items[batch.items.length - 1].seq;
  const receivedAt = new Date(now).toISOString();
  const expiry = now + (batch.stream === 'ble_reports'
    ? config.raw_retention_hours * HOUR_MS
    : config.aggregate_retention_days * DAY_MS);
  const retainUntil = Math.max(expiry, config.accept_until_ms + 7 * DAY_MS);
  const receiptId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO ingestion_batches (
      node_id,batch_id,receipt_id,body_sha256,boot_id,stream,seq_first,seq_last,accepted_count,
      placement_id,capture_config_id,dataset,firmware_version,raw_object_key,received_at,expires_at_ms,retain_until_ms
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      batch.node_id, batch.batch_id, receiptId, bodyHash, batch.boot_id, batch.stream,
      seqFirst, seqLast, batch.items.length, batch.placement_id, batch.capture_config_id,
      batch.dataset, batch.firmware_version, rawKey, receivedAt, expiry, retainUntil,
    ),
  ];
  if (batch.stream !== 'ble_reports') {
    const table = batch.stream === 'ble_windows' ? 'sensor_windows' : 'node_status';
    const sql = table === 'sensor_windows'
      ? `INSERT INTO sensor_windows (node_id,boot_id,seq,batch_id,placement_id,capture_config_id,dataset,utc_ms,duration_ms,item_json,received_at,expires_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      : `INSERT INTO node_status (node_id,boot_id,seq,batch_id,placement_id,capture_config_id,dataset,utc_ms,item_json,received_at,expires_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
    for (const item of batch.items) {
      const common: unknown[] = [batch.node_id, batch.boot_id, item.seq, batch.batch_id,
        batch.placement_id, batch.capture_config_id, batch.dataset, item.time.utc_ms];
      if (table === 'sensor_windows') common.push((item as typeof item & { duration_ms: number }).duration_ms);
      common.push(JSON.stringify(item), receivedAt, expiry);
      statements.push(db.prepare(sql).bind(...common));
    }
  }

  try {
    await db.batch(statements);
  } catch (error) {
    // A concurrent request may have won the receipt race. Read it back after
    // the transaction resolves; only identical bytes receive the old ACK.
    const winner = await findReceipt(db, batch.node_id, batch.batch_id);
    if (winner) {
      if (winner.body_sha256 !== bodyHash) throw new IngestStoreError(409, 'batch_conflict');
      return { ack: ackFromReceipt(winner), duplicate: true };
    }
    // D1 may wrap SQLite trigger failures and omit their message from the
    // top-level Error. The committed interval is the durable source of truth.
    const crossVersionBatch = await db.prepare('SELECT 1 FROM ingestion_batches_v2 WHERE node_id = ? AND batch_id = ?').bind(batch.node_id, batch.batch_id).first();
    if (crossVersionBatch) throw new IngestStoreError(409, 'batch_conflict');
    const overlap = await db.prepare(`SELECT 1 FROM (SELECT node_id,boot_id,stream,seq_first,seq_last FROM ingestion_batches UNION ALL SELECT node_id,boot_id,stream,seq_first,seq_last FROM ingestion_batches_v2)
      WHERE node_id = ? AND boot_id = ? AND stream = ?
        AND seq_first <= ? AND seq_last >= ? LIMIT 1`)
      .bind(batch.node_id, batch.boot_id, batch.stream, seqLast, seqFirst).first();
    if (overlap) throw new IngestStoreError(409, 'seq_range_overlap');
    throw error;
  }
  return {
    ack: {
      node_id: batch.node_id, boot_id: batch.boot_id, stream: batch.stream,
      batch_id: batch.batch_id, body_sha256: bodyHash, accepted_count: batch.items.length,
      durability: 'committed', receipt_id: receiptId, received_at: receivedAt,
    },
    duplicate: false,
  };
}

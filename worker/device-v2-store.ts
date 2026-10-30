import type { BatchV2, V2Stream } from './device-v2-validation';
import type { AuthAssertion } from './admin-auth';
import { findV3NamespaceConflict, IngestStoreError } from './ingest-store';
export interface AckV2 {
 node_id: string; boot_id: string; stream: V2Stream; batch_id: string; body_sha256: string;
 accepted_count: number; durability: 'committed'; receipt_id: string; received_at: string;
}
export async function findReceiptV2(db: D1Database, node: string, batch: string): Promise<AckV2 | null> {
 const row = await db.prepare('SELECT node_id,boot_id,stream,batch_id,body_sha256,accepted_count,receipt_id,received_at FROM ingestion_batches_v2 WHERE node_id=? AND batch_id=?').bind(node,batch).first<Omit<AckV2,'durability'>>();
 return row ? { ...row, durability: 'committed' } : null;
}
export async function commitBatchV2(db: D1Database, batch: BatchV2, hash: string, rawKey: string | null, rawHours: number, aggregateDays: number, acceptUntil: number, now: number, authorization?:AuthAssertion): Promise<AckV2> {
 const prior = await findReceiptV2(db,batch.node_id,batch.batch_id);
 if (prior) { if (prior.body_sha256 !== hash) throw new IngestStoreError(409,'batch_conflict'); return prior; }
 // R2 archival may have crossed the upload cutoff after route authorization.
 // A committed retry above remains valid; a new receipt must still be timely.
 if (now > acceptUntil) throw new IngestStoreError(410,'capture_config_expired');
 const seqFirst = batch.items[0].seq, seqLast = batch.items[batch.items.length-1].seq;
 const ack: AckV2 = { node_id:batch.node_id,boot_id:batch.boot_id,stream:batch.stream,batch_id:batch.batch_id,body_sha256:hash,
   accepted_count:batch.items.length,durability:'committed',receipt_id:crypto.randomUUID(),received_at:new Date(now).toISOString() };
 const privateEvidence = batch.stream === 'address_summaries' || batch.stream === 'ble_reports';
 const expiry = now + (privateEvidence ? rawHours*3600000 : aggregateDays*86400000);
 const retain = Math.max(expiry,acceptUntil+7*86400000);
 const statements = [db.prepare(`INSERT INTO ingestion_batches_v2(node_id,batch_id,receipt_id,body_sha256,boot_id,stream,seq_first,seq_last,accepted_count,placement_id,capture_config_id,dataset,firmware_version,raw_object_key,received_at,expires_at_ms,retain_until_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .bind(batch.node_id,batch.batch_id,ack.receipt_id,hash,batch.boot_id,batch.stream,seqFirst,seqLast,batch.items.length,batch.placement_id,batch.capture_config_id,batch.dataset,batch.firmware_version,rawKey,ack.received_at,expiry,retain)];
 for (const item of batch.items) {
  // For raw, D1 stores only sequence/window bookkeeping. Exact evidence stays in private R2.
  const raw = batch.stream === 'ble_reports';
  const serialized = raw ? JSON.stringify({seq:item.seq,window_seq:'window_seq' in item ? item.window_seq : null}) : JSON.stringify(item);
  statements.push(db.prepare(`INSERT INTO ingestion_items_v2(node_id,boot_id,stream,seq,batch_id,placement_id,capture_config_id,dataset,utc_ms,duration_ms,window_seq,address,address_type,item_json,received_at,expires_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
   .bind(batch.node_id,batch.boot_id,batch.stream,item.seq,batch.batch_id,batch.placement_id,batch.capture_config_id,batch.dataset,item.time.utc_ms,
    'duration_ms' in item ? item.duration_ms : null, 'window_seq' in item ? item.window_seq : null,
    'address' in item ? item.address : null,'address_type' in item ? item.address_type : null,serialized,ack.received_at,expiry));
 }
 const authGuard=crypto.randomUUID();
 if(authorization){statements.unshift(db.prepare(`INSERT INTO admin_write_assertions(id,ok) SELECT ?,CASE WHEN (${authorization.sql}) THEN 1 ELSE 0 END`).bind(authGuard,...authorization.bindings));statements.push(db.prepare('DELETE FROM admin_write_assertions WHERE id=?').bind(authGuard));}
 try { await db.batch(statements); }
 catch (error) {
  const winner = await findReceiptV2(db,batch.node_id,batch.batch_id);
  if (winner) { if (winner.body_sha256 !== hash) throw new IngestStoreError(409,'batch_conflict'); return winner; }
  const v3Conflict = await findV3NamespaceConflict(db,batch.node_id,batch.batch_id,batch.boot_id,batch.stream,seqFirst,seqLast);
  if(v3Conflict) throw new IngestStoreError(409,v3Conflict);
  const conflicting = await db.prepare(`SELECT batch_id FROM ingestion_batches WHERE node_id=? AND batch_id=?`).bind(batch.node_id,batch.batch_id).first();
  if (conflicting) throw new IngestStoreError(409,'batch_conflict');
  const overlap = await db.prepare(`SELECT 1 FROM (SELECT node_id,boot_id,stream,seq_first,seq_last FROM ingestion_batches UNION ALL SELECT node_id,boot_id,stream,seq_first,seq_last FROM ingestion_batches_v2) WHERE node_id=? AND boot_id=? AND stream=? AND seq_first<=? AND seq_last>=? LIMIT 1`)
   .bind(batch.node_id,batch.boot_id,batch.stream,seqLast,seqFirst).first();
  if (overlap) throw new IngestStoreError(409,'seq_range_overlap');
  const messages: string[] = [];
  for (let e:unknown=error,n=0;e instanceof Error && n<4;e=e.cause,n++) messages.push(e.message);
  if (/private_window_closed|accepted_count\s*<=\s*budget|summary_window_conflict|UNIQUE constraint failed: ingestion_items_v2/.test(messages.join(' '))) throw new IngestStoreError(409,'window_evidence_conflict');
  throw error;
 }
 return ack;
}

import type { Env } from './types';

/** Bounded, idempotent cleanup of committed evidence only. Unreferenced R2
 * objects are deliberately excluded: they may belong to an in-flight commit. */
export async function expireIngestion(env: Env, now = Date.now()): Promise<void> {
  const expired = await env.DB.prepare('SELECT node_id,batch_id,raw_object_key FROM ingestion_batches WHERE raw_object_key IS NOT NULL AND expires_at_ms <= ? LIMIT 100')
    .bind(now).all<{ node_id: string; batch_id: string; raw_object_key: string }>();
  if (env.RAW_BUCKET) {
    for (const batch of expired.results) {
      await env.RAW_BUCKET.delete(batch.raw_object_key);
      await env.DB.prepare('UPDATE ingestion_batches SET raw_object_key = NULL WHERE node_id = ? AND batch_id = ? AND raw_object_key = ?')
        .bind(batch.node_id, batch.batch_id, batch.raw_object_key).run();
    }
  }
  // Each invocation is bounded. Later invocations resume from remaining rows.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sensor_windows WHERE rowid IN (SELECT rowid FROM sensor_windows WHERE expires_at_ms <= ? LIMIT 500)').bind(now),
    env.DB.prepare('DELETE FROM node_status WHERE rowid IN (SELECT rowid FROM node_status WHERE expires_at_ms <= ? LIMIT 500)').bind(now),
    env.DB.prepare('DELETE FROM ingestion_batches WHERE rowid IN (SELECT rowid FROM ingestion_batches WHERE retain_until_ms <= ? AND raw_object_key IS NULL AND NOT EXISTS (SELECT 1 FROM sensor_windows w WHERE w.node_id = ingestion_batches.node_id AND w.batch_id = ingestion_batches.batch_id) AND NOT EXISTS (SELECT 1 FROM node_status s WHERE s.node_id = ingestion_batches.node_id AND s.batch_id = ingestion_batches.batch_id) LIMIT 100)').bind(now),
  ]);
}

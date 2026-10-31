/** Additive v3 may not have been migrated on an older deployment. Only probe
 * its committed namespace after a failed write, and never query absent tables. */
export async function findV3NamespaceConflict(db: D1Database, node: string, batch: string, boot: string, stream: string, first: number, last: number): Promise<string | null> {
  const schema = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND name IN ('ingestion_batches_v3','statistics_batches_v3','statistics_sequence_floors_v3')`).all<{ name: string }>();
  const present = new Set(schema.results.map(row => row.name));
  const tables = ['ingestion_batches_v3', 'statistics_batches_v3'].filter(table => present.has(table));
  for (const table of tables) if (await db.prepare(`SELECT 1 FROM ${table} WHERE node_id=? AND batch_id=?`).bind(node, batch).first()) return 'batch_conflict';
  for (const table of tables) if (await db.prepare(`SELECT 1 FROM ${table} WHERE node_id=? AND boot_id=? AND stream=? AND seq_first<=? AND seq_last>=? LIMIT 1`)
    .bind(node, boot, stream, last, first).first()) return 'seq_range_overlap';
  if (present.has('statistics_sequence_floors_v3') && await db.prepare(`SELECT 1 FROM statistics_sequence_floors_v3
    WHERE node_id=? AND boot_id=? AND stream=? AND seq_floor>=?`).bind(node, boot, stream, first).first()) return 'seq_range_overlap';
  return null;
}


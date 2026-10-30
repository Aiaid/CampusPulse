-- Private exact-byte TF archive. Policies are provisioned only by an operator.
CREATE TABLE cpraw_archive_policies (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES device_nodes(id),
  cpraw_archive INTEGER NOT NULL DEFAULT 0 CHECK (cpraw_archive IN (0,1)),
  policy_kind TEXT NOT NULL CHECK (policy_kind = 'offline_import'),
  dataset TEXT NOT NULL CHECK (dataset IN ('field','controlled_test','demo')),
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 80),
  accept_until_ms INTEGER NOT NULL CHECK (accept_until_ms >= 0),
  raw_retention_hours INTEGER NOT NULL CHECK (raw_retention_hours BETWEEN 1 AND 8760),
  max_file_bytes INTEGER NOT NULL CHECK (max_file_bytes BETWEEN 0 AND 16780672),
  max_files INTEGER NOT NULL CHECK (max_files BETWEEN 1 AND 1000),
  max_pending_uploads INTEGER NOT NULL CHECK (max_pending_uploads BETWEEN 1 AND 100),
  max_total_bytes INTEGER NOT NULL CHECK (max_total_bytes BETWEEN 0 AND 16780672000),
  placement_id TEXT,
  placement_provenance TEXT,
  CHECK ((placement_id IS NULL AND placement_provenance IS NULL) OR
    (placement_id IS NOT NULL AND placement_provenance IS NOT NULL AND length(placement_provenance) BETWEEN 1 AND 200)),
  FOREIGN KEY (placement_id,node_id) REFERENCES placements(id,node_id),
  UNIQUE (id,node_id)
);
CREATE TRIGGER cpraw_policy_immutable BEFORE UPDATE ON cpraw_archive_policies
BEGIN SELECT RAISE(ABORT,'cpraw_policy_immutable'); END;

CREATE TABLE cpraw_uploads (
  node_id TEXT NOT NULL REFERENCES device_nodes(id),
  upload_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256)=64),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256)=64),
  file_bytes INTEGER NOT NULL CHECK (file_bytes BETWEEN 0 AND 16780672),
  chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 0 AND 257),
  accepted_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  retain_until_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','committed','deleting','expired')),
  last_cleanup_at_ms INTEGER NOT NULL DEFAULT 0,
  private_summary_json TEXT CHECK (private_summary_json IS NULL OR json_valid(private_summary_json)),
  final_receipt_json TEXT CHECK (final_receipt_json IS NULL OR json_valid(final_receipt_json)),
  PRIMARY KEY (node_id,upload_id),
  FOREIGN KEY (policy_id,node_id) REFERENCES cpraw_archive_policies(id,node_id)
);
CREATE INDEX cpraw_upload_expiry ON cpraw_uploads(expires_at_ms,state);
CREATE INDEX cpraw_upload_policy ON cpraw_uploads(policy_id,node_id,state);
CREATE TRIGGER cpraw_upload_immutable BEFORE UPDATE OF node_id,upload_id,policy_id,
  manifest_json,manifest_sha256,file_sha256,file_bytes,chunk_count,accepted_at_ms,
  expires_at_ms,retain_until_ms ON cpraw_uploads
BEGIN SELECT RAISE(ABORT,'cpraw_manifest_immutable'); END;
CREATE TRIGGER cpraw_upload_admission BEFORE INSERT ON cpraw_uploads
WHEN NOT EXISTS (
  SELECT 1 FROM cpraw_archive_policies p WHERE p.id=NEW.policy_id AND p.node_id=NEW.node_id
    AND p.cpraw_archive=1 AND p.accept_until_ms>NEW.accepted_at_ms AND NEW.file_bytes<=p.max_file_bytes
    AND EXISTS (SELECT 1 FROM device_nodes n WHERE n.id=NEW.node_id AND n.enabled=1)
    AND (SELECT COUNT(*) FROM cpraw_uploads u WHERE u.node_id=p.node_id AND u.policy_id=p.id AND u.state='open' AND u.expires_at_ms>NEW.accepted_at_ms)<p.max_pending_uploads
    AND (SELECT COUNT(*) FROM cpraw_uploads u WHERE u.node_id=p.node_id AND u.policy_id=p.id)<p.max_files
    AND (SELECT COALESCE(SUM(file_bytes),0) FROM cpraw_uploads u WHERE u.node_id=p.node_id AND u.policy_id=p.id)+NEW.file_bytes<=p.max_total_bytes
)
BEGIN SELECT RAISE(ABORT,'cpraw_admission_denied'); END;

CREATE TABLE cpraw_chunks (
  node_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 256),
  byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
  byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 1 AND 65536),
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256)=64),
  raw_object_key TEXT,
  committed_at_ms INTEGER NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  PRIMARY KEY (node_id,upload_id,chunk_index),
  FOREIGN KEY (node_id,upload_id) REFERENCES cpraw_uploads(node_id,upload_id)
);
CREATE TRIGGER cpraw_chunk_immutable BEFORE UPDATE OF node_id,upload_id,chunk_index,
  byte_offset,byte_count,body_sha256,receipt_json,committed_at_ms ON cpraw_chunks
BEGIN SELECT RAISE(ABORT,'cpraw_chunk_immutable'); END;
CREATE TRIGGER cpraw_chunk_open BEFORE INSERT ON cpraw_chunks
WHEN NOT EXISTS (SELECT 1 FROM cpraw_uploads u JOIN cpraw_archive_policies p ON p.id=u.policy_id
  JOIN device_nodes n ON n.id=u.node_id WHERE u.node_id=NEW.node_id AND
  u.upload_id=NEW.upload_id AND u.state='open' AND u.expires_at_ms>NEW.committed_at_ms
  AND p.accept_until_ms>NEW.committed_at_ms AND p.cpraw_archive=1 AND n.enabled=1)
BEGIN SELECT RAISE(ABORT,'cpraw_upload_closed'); END;
CREATE TRIGGER cpraw_final_receipt_immutable BEFORE UPDATE OF final_receipt_json ON cpraw_uploads
WHEN OLD.final_receipt_json IS NOT NULL
BEGIN SELECT RAISE(ABORT,'cpraw_final_receipt_immutable'); END;
CREATE TRIGGER cpraw_private_summary_immutable BEFORE UPDATE OF private_summary_json ON cpraw_uploads
WHEN OLD.final_receipt_json IS NOT NULL AND NOT (NEW.private_summary_json IS NULL AND NEW.state IN ('deleting','expired'))
BEGIN SELECT RAISE(ABORT,'cpraw_private_summary_immutable'); END;
CREATE TRIGGER cpraw_chunk_key_immutable BEFORE UPDATE OF raw_object_key ON cpraw_chunks
WHEN NEW.raw_object_key IS NOT NULL OR NOT EXISTS (SELECT 1 FROM cpraw_uploads u WHERE
  u.node_id=NEW.node_id AND u.upload_id=NEW.upload_id AND u.state IN ('deleting','expired'))
BEGIN SELECT RAISE(ABORT,'cpraw_chunk_key_immutable'); END;
CREATE TRIGGER cpraw_upload_state_forward BEFORE UPDATE OF state ON cpraw_uploads
WHEN NOT (NEW.state=OLD.state OR (OLD.state='open' AND NEW.state IN ('committed','deleting')) OR
  (OLD.state='committed' AND NEW.state='deleting') OR (OLD.state='deleting' AND NEW.state='expired'))
BEGIN SELECT RAISE(ABORT,'cpraw_state_transition'); END;

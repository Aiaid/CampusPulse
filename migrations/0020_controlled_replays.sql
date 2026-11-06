-- Private aggregate-only historical CPRAW replay snapshots. No field/device
-- records, leases, ACKs, credentials or existing retained evidence are changed.
CREATE TABLE controlled_replays (
  id TEXT PRIMARY KEY,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  imported_at TEXT NOT NULL,
  imported_by TEXT NOT NULL REFERENCES admin_accounts(id),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB)) <= 262144
    AND json_extract(snapshot_json,'$.schema') = 'campuspulse-replay-view/1'
    AND json_extract(snapshot_json,'$.dataset') = 'controlled_test'
    AND json_extract(snapshot_json,'$.source') = 'historical_cpraw'
    AND json_extract(snapshot_json,'$.id') = id)
);
CREATE TRIGGER controlled_replays_immutable BEFORE UPDATE ON controlled_replays
BEGIN SELECT RAISE(ABORT, 'controlled_replay_immutable'); END;
CREATE TRIGGER controlled_replays_no_delete BEFORE DELETE ON controlled_replays
BEGIN SELECT RAISE(ABORT, 'controlled_replay_immutable'); END;
CREATE TRIGGER controlled_replays_capacity BEFORE INSERT ON controlled_replays
WHEN NOT EXISTS (SELECT 1 FROM controlled_replays WHERE id=NEW.id)
  AND (SELECT COUNT(*) FROM controlled_replays) >= 128
BEGIN SELECT RAISE(ABORT, 'controlled_replay_capacity'); END;

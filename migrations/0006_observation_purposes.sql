-- A physical place supports several concurrent purposes. Legacy kind remains
-- its primary purpose; historical observations and placement scope are retained.
ALTER TABLE places ADD COLUMN observation_kinds_json TEXT;
UPDATE places SET observation_kinds_json=json_array(kind);
DROP TRIGGER places_observation_kind;
DROP TRIGGER observations_place_kind;

CREATE TRIGGER places_purposes_insert BEFORE INSERT ON places
WHEN NEW.observation_kinds_json IS NOT NULL AND (
  NOT json_valid(NEW.observation_kinds_json) OR json_type(NEW.observation_kinds_json)!='array'
  OR json_array_length(NEW.observation_kinds_json) NOT BETWEEN 1 AND 3
  OR EXISTS (SELECT 1 FROM json_each(NEW.observation_kinds_json) WHERE type!='text' OR value NOT IN ('activity','parking','elevator'))
  OR (SELECT COUNT(DISTINCT value) FROM json_each(NEW.observation_kinds_json))!=json_array_length(NEW.observation_kinds_json)
  OR NOT EXISTS (SELECT 1 FROM json_each(NEW.observation_kinds_json) WHERE value=NEW.kind))
BEGIN SELECT RAISE(ABORT, 'place_purposes_invalid'); END;
CREATE TRIGGER places_purposes_legacy_insert AFTER INSERT ON places
WHEN NEW.observation_kinds_json IS NULL
BEGIN UPDATE places SET observation_kinds_json=json_array(NEW.kind) WHERE id=NEW.id; END;
CREATE TRIGGER places_purposes_update BEFORE UPDATE OF kind,observation_kinds_json ON places
WHEN NEW.observation_kinds_json IS NULL OR NOT json_valid(NEW.observation_kinds_json)
  OR json_type(NEW.observation_kinds_json)!='array' OR json_array_length(NEW.observation_kinds_json) NOT BETWEEN 1 AND 3
  OR EXISTS (SELECT 1 FROM json_each(NEW.observation_kinds_json) WHERE type!='text' OR value NOT IN ('activity','parking','elevator'))
  OR (SELECT COUNT(DISTINCT value) FROM json_each(NEW.observation_kinds_json))!=json_array_length(NEW.observation_kinds_json)
  OR NOT EXISTS (SELECT 1 FROM json_each(NEW.observation_kinds_json) WHERE value=NEW.kind)
BEGIN SELECT RAISE(ABORT, 'place_purposes_invalid'); END;
-- Only new evidence must use a currently enabled purpose. Retries, cancellation
-- and disabling a purpose must not rewrite or invalidate historical evidence.
CREATE TRIGGER observations_place_kind BEFORE INSERT ON observations
WHEN NOT EXISTS (SELECT 1 FROM observations WHERE id=NEW.id)
 AND NOT EXISTS (SELECT 1 FROM places p,json_each(p.observation_kinds_json) k WHERE p.id=NEW.place_id AND k.value=NEW.kind)
BEGIN SELECT RAISE(ABORT, 'place_kind_conflict'); END;
CREATE INDEX observations_place_purpose_time ON observations(place_id,kind,status,observed_at DESC,id DESC);

-- NULL is an insertion-only sentinel for legacy SQL/provisioning callers. The
-- AFTER INSERT trigger freezes the current target scope within that statement.
ALTER TABLE placements ADD COLUMN observation_kinds_json TEXT;
DROP TRIGGER placements_immutable_update;
UPDATE placements SET observation_kinds_json=COALESCE(
  (SELECT observation_kinds_json FROM places WHERE id=placements.place_id),'["activity"]');
CREATE TRIGGER placements_immutable_update BEFORE UPDATE ON placements
WHEN OLD.observation_kinds_json IS NOT NULL OR NEW.observation_kinds_json IS NULL
  OR NEW.id IS NOT OLD.id OR NEW.node_id IS NOT OLD.node_id OR NEW.place_id IS NOT OLD.place_id
  OR NEW.valid_from_ms IS NOT OLD.valid_from_ms OR NEW.valid_until_ms IS NOT OLD.valid_until_ms
BEGIN SELECT RAISE(ABORT, 'placement_immutable'); END;
CREATE TRIGGER placements_purposes_insert BEFORE INSERT ON placements
WHEN NEW.observation_kinds_json IS NOT NULL AND (NOT json_valid(NEW.observation_kinds_json) OR json_type(NEW.observation_kinds_json)!='array'
  OR json_array_length(NEW.observation_kinds_json) NOT BETWEEN 1 AND 3
  OR EXISTS (SELECT 1 FROM json_each(NEW.observation_kinds_json) WHERE type!='text' OR value NOT IN ('activity','parking','elevator'))
  OR (SELECT COUNT(DISTINCT value) FROM json_each(NEW.observation_kinds_json))!=json_array_length(NEW.observation_kinds_json))
BEGIN SELECT RAISE(ABORT, 'placement_purposes_invalid'); END;
CREATE TRIGGER placements_purposes_legacy_insert AFTER INSERT ON placements
WHEN NEW.observation_kinds_json IS NULL
BEGIN UPDATE placements SET observation_kinds_json=COALESCE(
  (SELECT observation_kinds_json FROM places WHERE id=NEW.place_id),'["activity"]') WHERE id=NEW.id; END;
CREATE TRIGGER placements_purposes_scope BEFORE INSERT ON placements
WHEN NEW.place_id IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(NEW.observation_kinds_json) selected
  WHERE NOT EXISTS (SELECT 1 FROM places p,json_each(p.observation_kinds_json) allowed
    WHERE p.id=NEW.place_id AND allowed.value=selected.value))
BEGIN SELECT RAISE(ABORT, 'placement_purposes_invalid'); END;

PRAGMA foreign_keys = ON;

-- Coordinates are provisional normalized schematic anchors, not surveyed GIS.
CREATE TABLE places (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('activity', 'parking', 'elevator')),
  anchor_x REAL NOT NULL CHECK (anchor_x BETWEEN 0 AND 1),
  anchor_y REAL NOT NULL CHECK (anchor_y BETWEEN 0 AND 1),
  gis_anchor_x REAL CHECK (gis_anchor_x BETWEEN 0 AND 1),
  gis_anchor_y REAL CHECK (gis_anchor_y BETWEEN 0 AND 1),
  CHECK ((gis_anchor_x IS NULL) = (gis_anchor_y IS NULL))
);

INSERT INTO places (id,name,kind,anchor_x,anchor_y) VALUES
  ('library', '图书馆', 'activity', 0.52, 0.46),
  ('east-parking', '东区停车观察点', 'parking', 0.72, 0.58),
  ('teaching-elevator', '教学楼候梯观察点', 'elevator', 0.34, 0.34);

-- Official public GIS hotspot: library at (15656,9059) in the 24576px image.
-- This verifies the building marker only, not a BLE installation or coverage.
UPDATE places SET gis_anchor_x = 15656.0 / 24576, gis_anchor_y = 9059.0 / 24576
WHERE id = 'library';

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  place_id TEXT NOT NULL REFERENCES places(id),
  kind TEXT NOT NULL CHECK (kind IN ('parking', 'elevator')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source = 'manual'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  observed_at TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  received_at TEXT NOT NULL,
  cancelled_at TEXT,
  parking_min INTEGER,
  parking_max INTEGER,
  wait_seconds INTEGER,
  CHECK (
    (kind = 'parking' AND parking_min IS NOT NULL AND parking_max IS NOT NULL
      AND parking_min >= 0 AND parking_max >= parking_min AND parking_max <= 10000
      AND wait_seconds IS NULL)
    OR
    (kind = 'elevator' AND parking_min IS NULL AND parking_max IS NULL
      AND wait_seconds IS NOT NULL AND wait_seconds BETWEEN 0 AND 7200)
  )
);
CREATE INDEX observations_place_time ON observations(place_id, observed_at DESC);
